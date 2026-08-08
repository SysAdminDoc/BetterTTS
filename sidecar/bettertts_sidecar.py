"""BetterTTS Python sidecar for the optional Qwen3-TTS desktop engine.

The process speaks a deliberately small JSON-lines protocol over stdin/stdout.
It never opens a listener and it never receives renderer data directly. Each
inference runs in a disposable worker process so cancellation can terminate a
stuck torch generation without taking down the sidecar supervisor.
"""

from __future__ import annotations

import base64
import ctypes
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
MODEL_REVISION = "85e237c12c027371202489a0ec509ded67b5e4b5"
MODEL_MANIFEST_NAME = "bettertts-qwen-model.json"
RUNTIME_MANIFEST_NAME = "qwen-runtime-manifest.json"
RUNTIME_MANIFEST_SCHEMA = 1
MAX_TEXT_CHARS = 5_000
MAX_INSTRUCT_CHARS = 500
MAX_PCM_BYTES = 80 * 1024 * 1024
TEST_SAMPLE_RATE = 24_000
MAX_MODEL_FILES = 256
MAX_MODEL_BYTES = 8 * 1024 * 1024 * 1024
GENERATION_TIMEOUT_SECONDS = 600.0
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


def runtime_manifest_path() -> Path:
    configured = os.environ.get("BETTERTTS_SIDECAR_MANIFEST")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().with_name(RUNTIME_MANIFEST_NAME)


def load_runtime_manifest() -> dict[str, Any] | None:
    try:
        value = json.loads(runtime_manifest_path().read_text(encoding="utf-8"))
        if not isinstance(value, dict) or value.get("schemaVersion") != RUNTIME_MANIFEST_SCHEMA:
            return None
        return value
    except Exception:
        return None


def runtime_contract_errors(manifest: dict[str, Any] | None = None) -> list[str]:
    manifest = manifest or load_runtime_manifest()
    if manifest is None:
        return ["The pinned Qwen runtime manifest is missing or invalid."]
    errors: list[str] = []
    if manifest.get("platform") != "win32-x64" or manifest.get("python") != "3.12":
        errors.append("The Qwen runtime manifest targets a different platform or Python version.")
    model = manifest.get("model")
    if not isinstance(model, dict) or model.get("id") != MODEL_ID or model.get("revision") != MODEL_REVISION:
        errors.append("The Qwen model identity is not pinned to the supported revision.")
    packages = manifest.get("packages")
    expected_qwen = packages.get("qwenTts") if isinstance(packages, dict) else None
    expected_torch = packages.get("torch") if isinstance(packages, dict) else None
    qwen_version = package_version("qwen-tts")
    torch_version = package_version("torch")
    if qwen_version != expected_qwen:
        errors.append(f"qwen-tts {expected_qwen or 'the pinned version'} is required (found {qwen_version or 'missing'}).")
    if torch_version != expected_torch:
        errors.append(f"torch {expected_torch or 'the pinned version'} is required (found {torch_version or 'missing'}).")
    requirements = manifest.get("requirements")
    requirements_value = os.environ.get("BETTERTTS_SIDECAR_REQUIREMENTS")
    requirements_file = Path(requirements_value) if requirements_value else None
    if isinstance(requirements, dict) and requirements_file and requirements_file.is_file():
        digest = hashlib.sha256(requirements_file.read_text(encoding="utf-8").replace("\r\n", "\n").encode("utf-8")).hexdigest()
        if digest != requirements.get("sha256"):
            errors.append("The Qwen requirements file does not match its pinned SHA-256.")
    elif isinstance(requirements, dict):
        errors.append("The pinned Qwen requirements file is missing.")
    return errors


def model_snapshot_dir(root: Path | None = None) -> Path:
    root = root or model_cache_dir()
    cache_name = MODEL_ID.replace("/", "--")
    return root / f"models--{cache_name}" / "snapshots" / MODEL_REVISION


def model_manifest_path(root: Path | None = None) -> Path:
    return (root or model_cache_dir()) / MODEL_MANIFEST_NAME


def model_relative_path(path: Path, root: Path) -> str:
    relative = path.relative_to(root).as_posix()
    if not relative or relative.startswith("/") or "\\" in relative or any(part in {"", ".", ".."} for part in relative.split("/")):
        raise ValueError("The Qwen model cache contains an unsafe path.")
    return relative


def model_files(root: Path | None = None) -> list[tuple[str, Path, int]]:
    snapshot = model_snapshot_dir(root)
    if not snapshot.is_dir() or snapshot.is_symlink():
        raise ValueError("The pinned Qwen model snapshot is missing.")
    files: list[tuple[str, Path, int]] = []
    total_bytes = 0
    for path in snapshot.rglob("*"):
        if path.is_symlink():
            try:
                resolved = path.resolve(strict=True)
                resolved.relative_to(root.resolve())
            except (OSError, ValueError):
                raise ValueError("The Qwen model cache contains a symlink outside its cache root.") from None
            if not resolved.is_file():
                raise ValueError("The Qwen model cache contains a symlink to a non-regular entry.")
        elif path.is_dir():
            continue
        elif not path.is_file():
            raise ValueError("The Qwen model cache contains a non-regular entry.")
        relative = model_relative_path(path, snapshot)
        size = path.stat().st_size
        total_bytes += size
        if len(files) >= MAX_MODEL_FILES or total_bytes > MAX_MODEL_BYTES:
            raise ValueError("The Qwen model cache exceeds the bounded file or size limit.")
        files.append((relative, path, size))
    if not files:
        raise ValueError("The pinned Qwen model snapshot contains no files.")
    files.sort(key=lambda item: item[0])
    required = {"config.json", "model.safetensors", "speech_tokenizer/model.safetensors"}
    if not required.issubset({item[0] for item in files}):
        raise ValueError("The pinned Qwen model snapshot is missing required model files.")
    return files


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_model_manifest() -> dict[str, Any]:
    root = model_cache_dir()
    root.mkdir(parents=True, exist_ok=True)
    files = model_files(root)
    entries = [
        {"path": relative, "sizeBytes": size, "sha256": sha256_file(path)}
        for relative, path, size in files
    ]
    manifest = {
        "schemaVersion": 1,
        "modelId": MODEL_ID,
        "revision": MODEL_REVISION,
        "snapshot": MODEL_REVISION,
        "totalBytes": sum(entry["sizeBytes"] for entry in entries),
        "files": entries,
        "verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    marker = model_manifest_path(root)
    temporary = root / f".{MODEL_MANIFEST_NAME}.part"
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, marker)
    return manifest


def verify_model_manifest(root: Path | None = None) -> bool:
    root = root or model_cache_dir()
    try:
        manifest = json.loads(model_manifest_path(root).read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
            return False
        if manifest.get("modelId") != MODEL_ID or manifest.get("revision") != MODEL_REVISION or manifest.get("snapshot") != MODEL_REVISION:
            return False
        entries = manifest.get("files")
        if not isinstance(entries, list) or not entries or len(entries) > MAX_MODEL_FILES:
            return False
        expected: dict[str, tuple[int, str]] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                return False
            relative = entry.get("path")
            size = entry.get("sizeBytes")
            digest = entry.get("sha256")
            if not isinstance(relative, str) or not isinstance(size, int) or size < 0 or not isinstance(digest, str) or len(digest) != 64:
                return False
            if relative in expected or "\\" in relative or relative.startswith("/") or any(part in {"", ".", ".."} for part in relative.split("/")):
                return False
            expected[relative] = (size, digest.lower())
        actual = model_files(root)
        actual_names = {relative for relative, _, _ in actual}
        if actual_names != set(expected):
            return False
        total_bytes = 0
        for relative, path, size in actual:
            expected_size, expected_digest = expected[relative]
            if size != expected_size or sha256_file(path) != expected_digest:
                return False
            total_bytes += size
        return manifest.get("totalBytes") == total_bytes and {"config.json", "model.safetensors", "speech_tokenizer/model.safetensors"}.issubset(actual_names)
    except Exception:
        return False


def model_is_ready() -> bool:
    return verify_model_manifest()


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None
    except Exception:
        return None


def available_memory_bytes() -> int:
    if os.name == "nt":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_uint32),
                ("dwMemoryLoad", ctypes.c_uint32),
                ("ullTotalPhys", ctypes.c_uint64),
                ("ullAvailPhys", ctypes.c_uint64),
                ("ullTotalPageFile", ctypes.c_uint64),
                ("ullAvailPageFile", ctypes.c_uint64),
                ("ullTotalVirtual", ctypes.c_uint64),
                ("ullAvailVirtual", ctypes.c_uint64),
                ("ullAvailExtendedVirtual", ctypes.c_uint64),
            ]

        status = MemoryStatus()
        status.dwLength = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.ullAvailPhys)
    try:
        pages = os.sysconf("SC_AVPHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        return int(pages * page_size)
    except (AttributeError, ValueError, OSError):
        return 0


def free_disk_bytes() -> int:
    root = model_cache_dir()
    probe = root
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        return int(shutil.disk_usage(probe).free)
    except OSError:
        return 0


def gpu_available(torch_installed: bool) -> bool | None:
    if not torch_installed:
        return None
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def sidecar_status() -> dict[str, Any]:
    python_version = ".".join(str(part) for part in sys.version_info[:3])
    if TEST_MODE:
        return {
            "available": True,
            "pythonPath": sys.executable,
            "pythonVersion": python_version,
            "qwenVersion": "0.1.1",
            "torchVersion": "2.7.1",
            "qwenInstalled": True,
            "torchInstalled": True,
            "modelReady": True,
            "modelId": MODEL_ID,
            "modelRevision": MODEL_REVISION,
            "freeDiskBytes": free_disk_bytes(),
            "freeMemoryBytes": available_memory_bytes(),
            "gpuAvailable": False,
            "message": "The sidecar test adapter is ready.",
            "recovery": "Test mode is disabled in production builds.",
            "testMode": True,
        }

    manifest = load_runtime_manifest()
    contract_errors = runtime_contract_errors(manifest)
    qwen_version = package_version("qwen-tts")
    torch_version = package_version("torch")
    expected_packages = manifest.get("packages", {}) if isinstance(manifest, dict) else {}
    qwen_installed = importlib.util.find_spec("qwen_tts") is not None and qwen_version == expected_packages.get("qwenTts")
    torch_installed = importlib.util.find_spec("torch") is not None and torch_version == expected_packages.get("torch")
    model_ready = model_is_ready()
    if contract_errors:
        message = contract_errors[0]
    elif not model_ready:
        message = f"Qwen3-TTS {qwen_version} is installed; pinned model weights will download on first use."
    else:
        message = f"Qwen3-TTS {qwen_version or 'runtime'} is ready."
    recovery = (
        "Use Set up Qwen3-TTS to create the private Python environment from the pinned "
        "Windows runtime manifest. Set BETTERTTS_QWEN_WHEELHOUSE to a local wheel folder "
        "for offline repair. Model weights are downloaded only on first synthesis and "
        "stored outside the app package."
    )
    gpu = gpu_available(torch_installed)
    return {
        "available": qwen_installed and torch_installed,
        "pythonPath": sys.executable,
        "pythonVersion": python_version,
        "qwenVersion": qwen_version,
        "torchVersion": torch_version,
        "qwenInstalled": qwen_installed,
        "torchInstalled": torch_installed,
        "modelReady": model_ready,
        "modelId": MODEL_ID,
        "modelRevision": MODEL_REVISION,
        "freeDiskBytes": free_disk_bytes(),
        "freeMemoryBytes": available_memory_bytes(),
        **({"gpuAvailable": gpu} if gpu is not None else {}),
        "message": message,
        "recovery": recovery,
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


def verify_runtime_installation() -> dict[str, Any]:
    manifest = load_runtime_manifest()
    errors = runtime_contract_errors(manifest)
    return {
        "ok": not errors,
        "qwenVersion": package_version("qwen-tts"),
        "torchVersion": package_version("torch"),
        "errors": errors,
    }


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

        output.put({"kind": "progress", "progress": 0.15, "stage": "Loading pinned model weights"})
        import numpy as np
        import torch
        from qwen_tts import Qwen3TTSModel

        use_cuda = bool(torch.cuda.is_available())
        model = Qwen3TTSModel.from_pretrained(
            MODEL_ID,
            cache_dir=str(model_cache_dir()),
            revision=MODEL_REVISION,
            device_map="cuda:0" if use_cuda else "cpu",
            dtype=torch.bfloat16 if use_cuda else torch.float32,
        )
        output.put({"kind": "progress", "progress": 0.54, "stage": "Verifying model files"})
        write_model_manifest()
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


def generation_timeout(request_id: int, process: subprocess.Popen[str], active: dict[int, Any], lock: threading.Lock) -> None:
    try:
        process.wait(timeout=GENERATION_TIMEOUT_SECONDS)
        return
    except subprocess.TimeoutExpired:
        pass
    with lock:
        if request_id not in active:
            return
        active.pop(request_id, None)
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            process.kill()
    emit({
        "type": "error",
        "id": request_id,
        "code": "failed",
        "message": "Qwen3-TTS generation timed out after 10 minutes.",
    })


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
            manifest = load_runtime_manifest()
            resources = manifest.get("resources", {}) if isinstance(manifest, dict) else {}
            if (
                free_disk_bytes() < int(resources.get("minFreeDiskBytes", 0))
                or available_memory_bytes() < int(resources.get("minFreeMemoryBytes", 0))
            ):
                emit({
                    "type": "error",
                    "id": request_id,
                    "code": "missing-model",
                    "message": "Qwen3-TTS needs more free disk space or available memory before downloading the pinned model.",
                })
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
        threading.Thread(
            target=generation_timeout,
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
    if "--verify-runtime" in sys.argv[1:]:
        result = verify_runtime_installation()
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        raise SystemExit(0 if result["ok"] else 1)
    raise SystemExit(main())
