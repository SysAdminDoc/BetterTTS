"""BetterTTS Python sidecar for the optional Qwen3-TTS desktop engine.

The process speaks a deliberately small JSON-lines protocol over stdin/stdout.
It never opens a listener and it never receives renderer data directly. Each
inference runs in a disposable worker process so cancellation can terminate a
stuck torch generation without taking down the sidecar supervisor.
"""

from __future__ import annotations

import base64
import importlib.metadata
import importlib.util
import json
import math
import os
import struct
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
MAX_TEXT_CHARS = 5_000
MAX_INSTRUCT_CHARS = 500
MAX_PCM_BYTES = 80 * 1024 * 1024
TEST_SAMPLE_RATE = 24_000
TEST_MODE = os.environ.get("BETTERTTS_SIDECAR_TEST_MODE") == "1"
LANGUAGES = {
    "Auto", "Chinese", "English", "Japanese", "Korean", "German",
    "French", "Russian", "Portuguese", "Spanish", "Italian",
}
SPEAKERS = {
    "Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden",
    "Ono_Anna", "Sohee",
}

_write_lock = threading.Lock()


def emit(message: dict[str, Any]) -> None:
    """Write one bounded protocol message without interleaving worker output."""
    encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    with _write_lock:
        sys.stdout.write(encoded + "\n")
        sys.stdout.flush()


def bounded_error(error: BaseException) -> str:
    message = str(error).strip() or error.__class__.__name__
    return message[:1_000]


def model_cache_dir() -> Path:
    configured = os.environ.get("BETTERTTS_SIDECAR_MODEL_DIR")
    if configured:
        return Path(configured)
    return Path.home() / ".bettertts" / "models" / "qwen"


def model_is_ready() -> bool:
    root = model_cache_dir()
    if not root.exists():
        return False
    return any(
        candidate.is_dir()
        for candidate in root.glob("models--Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice*")
    ) or (root / "config.json").exists()


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None
    except Exception:
        return None


def sidecar_status() -> dict[str, Any]:
    python_version = ".".join(str(part) for part in sys.version_info[:3])
    if TEST_MODE:
        return {
            "available": True,
            "pythonPath": sys.executable,
            "pythonVersion": python_version,
            "qwenInstalled": True,
            "torchInstalled": True,
            "modelReady": True,
            "modelId": MODEL_ID,
            "message": "The sidecar test adapter is ready.",
            "recovery": "Test mode is disabled in production builds.",
            "testMode": True,
        }

    qwen_installed = importlib.util.find_spec("qwen_tts") is not None
    torch_installed = importlib.util.find_spec("torch") is not None
    model_ready = model_is_ready()
    qwen_version = package_version("qwen-tts")
    if not qwen_installed or not torch_installed:
        message = "The Qwen3-TTS Python runtime is not installed yet."
    elif not model_ready:
        message = "Qwen3-TTS is installed; model weights will download on first use."
    else:
        message = f"Qwen3-TTS {qwen_version or 'runtime'} is ready."
    recovery = (
        "Use Set up Qwen3-TTS to create the private Python environment and install "
        "torch/qwen-tts. Model weights are downloaded only on first synthesis and "
        "stored outside the app package."
    )
    return {
        "available": qwen_installed and torch_installed,
        "pythonPath": sys.executable,
        "pythonVersion": python_version,
        "qwenInstalled": qwen_installed,
        "torchInstalled": torch_installed,
        "modelReady": model_ready,
        "modelId": MODEL_ID,
        "message": message,
        "recovery": recovery,
        "qwenVersion": qwen_version,
    }


def validate_synthesis(payload: dict[str, Any]) -> None:
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
        raise ValueError("Text must contain 1-5,000 characters.")
    language = payload.get("language")
    if not isinstance(language, str) or language not in LANGUAGES:
        raise ValueError("A valid Qwen3-TTS language is required.")
    speaker = payload.get("speaker")
    if not isinstance(speaker, str) or speaker not in SPEAKERS:
        raise ValueError("A valid Qwen3-TTS speaker is required.")
    instruct = payload.get("instruct", "")
    if not isinstance(instruct, str) or len(instruct) > MAX_INSTRUCT_CHARS:
        raise ValueError("Voice instruction is limited to 500 characters.")
    speed = payload.get("speed", 1.0)
    if not isinstance(speed, (int, float)) or not math.isfinite(float(speed)) or not 0.5 <= float(speed) <= 1.5:
        raise ValueError("Speed must be between 0.5 and 1.5.")


def apply_speed(samples: Any, speed: float) -> Any:
    """Apply a bounded duration change while keeping the declared sample rate."""
    if abs(speed - 1.0) < 0.001:
        return samples
    import numpy as np

    source = np.asarray(samples, dtype=np.float32).reshape(-1)
    if source.size < 2:
        return source
    target_length = max(1, min(source.size * 3, round(source.size / speed)))
    positions = np.linspace(0, source.size - 1, target_length, dtype=np.float32)
    return np.interp(positions, np.arange(source.size, dtype=np.float32), source).astype(np.float32)


def float_samples_to_pcm16(samples: Any) -> bytes:
    import numpy as np

    values = np.asarray(samples, dtype=np.float32).reshape(-1)
    if values.size == 0:
        raise ValueError("Qwen3-TTS produced no audio samples.")
    if values.size * 2 > MAX_PCM_BYTES:
        raise ValueError("Generated audio exceeds the sidecar size limit.")
    values = np.nan_to_num(np.clip(values, -1.0, 1.0), nan=0.0, posinf=0.0, neginf=0.0)
    return (values * 32767.0).astype("<i2", copy=False).tobytes()


def test_pcm16(text: str, speed: float) -> bytes:
    duration = max(0.08, min(0.8, 0.08 + len(text) / 2_000))
    count = max(1, round(TEST_SAMPLE_RATE * duration / speed))
    frames = bytearray()
    for index in range(count):
        sample = math.sin(2.0 * math.pi * 220.0 * index / TEST_SAMPLE_RATE) * 0.15
        frames.extend(struct.pack("<h", round(sample * 32767)))
    return bytes(frames)


def worker_main(payload: dict[str, Any], output: Any) -> None:
    """Run one inference in an independently terminable process."""
    try:
        output.put({"kind": "progress", "progress": 0.08, "stage": "Preparing Qwen3-TTS"})
        validate_synthesis(payload)
        text = str(payload["text"])
        speed = float(payload.get("speed", 1.0))
        if TEST_MODE:
            time.sleep(0.02)
            pcm = test_pcm16(text, speed)
            output.put({
                "kind": "result",
                "sample_rate": TEST_SAMPLE_RATE,
                "pcm16": base64.b64encode(pcm).decode("ascii"),
            })
            return

        output.put({"kind": "progress", "progress": 0.15, "stage": "Loading model weights"})
        import numpy as np
        import torch
        from qwen_tts import Qwen3TTSModel

        use_cuda = bool(torch.cuda.is_available())
        model = Qwen3TTSModel.from_pretrained(
            MODEL_ID,
            cache_dir=str(model_cache_dir()),
            device_map="cuda:0" if use_cuda else "cpu",
            dtype=torch.bfloat16 if use_cuda else torch.float32,
        )
        output.put({"kind": "progress", "progress": 0.62, "stage": "Synthesizing with Qwen3-TTS"})
        kwargs: dict[str, Any] = {
            "text": text,
            "language": str(payload["language"]),
            "speaker": str(payload["speaker"]),
        }
        if str(payload.get("instruct", "")).strip():
            kwargs["instruct"] = str(payload["instruct"]).strip()
        wavs, sample_rate = model.generate_custom_voice(**kwargs)
        samples = apply_speed(np.asarray(wavs[0], dtype=np.float32), speed)
        pcm = float_samples_to_pcm16(samples)
        output.put({
            "kind": "result",
            "sample_rate": int(sample_rate),
            "pcm16": base64.b64encode(pcm).decode("ascii"),
        })
    except Exception as error:
        output.put({
            "kind": "error",
            "message": bounded_error(error),
            "trace": traceback.format_exc(limit=4)[-2_000:],
        })


def emit_worker_event(event: dict[str, Any]) -> None:
    kind = event.get("kind")
    if kind == "progress":
        emit({
            "type": "progress",
            "progress": max(0.0, min(1.0, float(event.get("progress", 0.0)))),
            "stage": str(event.get("stage", "Generating"))[:200],
        })
    elif kind == "result":
        emit({
            "type": "result",
            "sample_rate": int(event["sample_rate"]),
            "pcm16": str(event["pcm16"]),
        })
    elif kind == "error":
        emit({
            "type": "error",
            "code": "failed",
            "message": str(event.get("message", "Qwen3-TTS synthesis failed."))[:1_000],
        })


class DirectWorkerOutput:
    def put(self, event: dict[str, Any]) -> None:
        emit_worker_event(event)


def worker_entry() -> int:
    raw = sys.stdin.readline()
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("Invalid Qwen3-TTS worker request.")
        worker_main(payload, DirectWorkerOutput())
    except Exception as error:
        emit_worker_event({"kind": "error", "message": bounded_error(error)})
        return 1
    return 0


def monitor_generation(request_id: int, process: subprocess.Popen[str], active: dict[int, Any], lock: threading.Lock) -> None:
    result_seen = False
    stderr = ""
    try:
        assert process.stdout is not None
        assert process.stderr is not None
        for raw_line in process.stdout:
            try:
                event = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            with lock:
                still_active = request_id in active
            if not still_active:
                continue
            event_type = event.get("type")
            if event_type == "progress":
                emit({
                    "type": "progress",
                    "id": request_id,
                    "progress": max(0.0, min(1.0, float(event.get("progress", 0.0)))),
                    "stage": str(event.get("stage", "Generating"))[:200],
                })
            elif event_type == "result":
                result_seen = True
                emit({"type": "result", "id": request_id, **event})
            elif event_type == "error":
                emit({"type": "error", "id": request_id, **event})
        stderr = process.stderr.read()[-2_000:]
        return_code = process.wait(timeout=2.0)
        with lock:
            still_active = request_id in active
        if still_active and not result_seen and return_code != 0:
            emit({
                "type": "error",
                "id": request_id,
                "code": "failed",
                "message": f"Qwen3-TTS worker exited with code {return_code}.{stderr.strip()[-600:]}",
            })
    except Exception as error:
        with lock:
            still_active = request_id in active
        if still_active:
            emit({"type": "error", "id": request_id, "code": "failed", "message": bounded_error(error)})
    finally:
        with lock:
            active.pop(request_id, None)


def start_generation(request_id: int, payload: dict[str, Any], active: dict[int, Any], lock: threading.Lock) -> None:
    try:
        validate_synthesis(payload)
        if not TEST_MODE:
            status = sidecar_status()
            if not status["available"]:
                emit({"type": "error", "id": request_id, "code": "missing-package", "message": status["recovery"]})
                return
        with lock:
            if active:
                emit({"type": "error", "id": request_id, "code": "failed", "message": "The Qwen3-TTS sidecar is already generating audio."})
                return
            process = subprocess.Popen(
                [sys.executable, "-u", str(Path(__file__).resolve()), "--worker"],
                cwd=str(Path(__file__).resolve().parent),
                env=os.environ.copy(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            active[request_id] = process
            assert process.stdin is not None
            process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            process.stdin.close()
        threading.Thread(
            target=monitor_generation,
            args=(request_id, process, active, lock),
            daemon=True,
        ).start()
    except Exception as error:
        emit({"type": "error", "id": request_id, "code": "failed", "message": bounded_error(error)})


def cancel_generation(request_id: int, active: dict[int, Any], lock: threading.Lock) -> None:
    with lock:
        item = active.pop(request_id, None)
    if not item:
        return
    process = item
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            process.kill()
    emit({"type": "error", "id": request_id, "code": "cancelled", "message": "Generation cancelled."})


def main() -> int:
    active: dict[int, Any] = {}
    lock = threading.Lock()
    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
        except json.JSONDecodeError:
            emit({"type": "error", "id": 0, "code": "failed", "message": "Invalid sidecar JSON request."})
            continue
        if not isinstance(request, dict):
            continue
        request_type = request.get("type")
        request_id = request.get("id")
        if not isinstance(request_id, int) or request_id < 0:
            continue
        if request_type == "status":
            emit({"type": "status", "id": request_id, "status": sidecar_status()})
        elif request_type == "synthesize":
            start_generation(request_id, request, active, lock)
        elif request_type == "cancel":
            cancel_generation(request_id, active, lock)
        elif request_type == "shutdown":
            with lock:
                requests = list(active.keys())
            for active_id in requests:
                cancel_generation(active_id, active, lock)
            break
        elif request_type == "setup":
            emit({
                "type": "error",
                "id": request_id,
                "code": "failed",
                "message": "Sidecar setup is managed by the desktop host.",
            })
    return 0


if __name__ == "__main__":
    if "--worker" in sys.argv[1:]:
        raise SystemExit(worker_entry())
    raise SystemExit(main())
