"""Small JSON-lines adapter for the optional local rvc-python package.

The adapter is launched by electron/rvc-host.ts for one status or conversion
request at a time. It never opens a listener and it only reads model paths the
operator explicitly selected in BetterTTS.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import struct
import sys
import tempfile
import wave
from pathlib import Path
from typing import Any

MAX_PCM_BYTES = 80 * 1024 * 1024
SAMPLE_RATE_MIN = 8_000
SAMPLE_RATE_MAX = 96_000
TEST_MODE = os.environ.get("BETTERTTS_RVC_TEST_MODE") == "1"


def emit(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def runtime_status() -> dict[str, Any]:
    if TEST_MODE:
        return {
            "available": True,
            "pythonPath": sys.executable,
            "pythonVersion": sys.version.split()[0],
            "rvcInstalled": True,
            "torchInstalled": True,
            "message": "Explicit RVC test adapter is active.",
            "recovery": "Disable BETTERTTS_RVC_TEST_MODE for real local conversion.",
            "testMode": True,
        }
    rvc_installed = importlib.util.find_spec("rvc_python") is not None
    torch_installed = importlib.util.find_spec("torch") is not None
    available = rvc_installed and torch_installed
    if available:
        message = "rvc-python and torch are ready; registered .pth files can be used locally."
        recovery = "Model files remain user-managed and are never copied by BetterTTS."
    elif not rvc_installed:
        message = "The optional rvc-python package is not installed."
        recovery = "Use Set up RVC runtime to create the isolated environment and install rvc-python."
    else:
        message = "The optional RVC runtime is missing PyTorch."
        recovery = "Use Set up RVC runtime again or repair the isolated Python environment."
    return {
        "available": available,
        "pythonPath": sys.executable,
        "pythonVersion": sys.version.split()[0],
        "rvcInstalled": rvc_installed,
        "torchInstalled": torch_installed,
        "message": message,
        "recovery": recovery,
    }


def bounded_path(value: Any, extension: str, required: bool = True) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ValueError("The selected RVC path is invalid.")
    path = Path(value)
    if not path.is_absolute() or path.suffix.lower() != extension:
        raise ValueError(f"RVC paths must be absolute {extension} files.")
    if not path.is_file():
        raise FileNotFoundError(f"RVC model file is missing: {path}")
    return str(path)


def decode_pcm16(value: Any) -> list[float]:
    if not isinstance(value, str):
        raise ValueError("The RVC request did not contain PCM audio.")
    raw = base64.b64decode(value, validate=True)
    if not raw or len(raw) % 2 or len(raw) > MAX_PCM_BYTES:
        raise ValueError("The RVC PCM payload is invalid or too large.")
    return [sample / 32768.0 for (sample,) in struct.iter_unpack("<h", raw)]


def write_wav(path: str, samples: list[float], sample_rate: int) -> None:
    with wave.open(path, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(sample_rate)
        pcm = bytearray()
        for sample in samples:
            clamped = max(-1.0, min(1.0, float(sample)))
            pcm.extend(struct.pack("<h", round(clamped * (0x8000 if clamped < 0 else 0x7FFF))))
        stream.writeframes(bytes(pcm))


def read_wav(path: str) -> tuple[int, list[float]]:
    with wave.open(path, "rb") as stream:
        channels = stream.getnchannels()
        width = stream.getsampwidth()
        sample_rate = stream.getframerate()
        frames = stream.readframes(stream.getnframes())
    if channels < 1 or width not in (2, 4):
        raise ValueError("The RVC adapter returned an unsupported WAV format.")
    if width == 2:
        values = [sample / 32768.0 for (sample,) in struct.iter_unpack("<h", frames)]
    else:
        values = [sample / 2147483648.0 for (sample,) in struct.iter_unpack("<i", frames)]
    if channels > 1:
        values = [sum(values[index:index + channels]) / channels for index in range(0, len(values), channels)]
    return sample_rate, values


def resample(samples: list[float], source_rate: int, target_rate: int) -> list[float]:
    if source_rate == target_rate or not samples:
        return samples
    length = max(1, round(len(samples) * target_rate / source_rate))
    result: list[float] = []
    for index in range(length):
        source = index * source_rate / target_rate
        low = min(len(samples) - 1, int(source))
        high = min(len(samples) - 1, low + 1)
        fraction = source - low
        result.append(samples[low] * (1.0 - fraction) + samples[high] * fraction)
    return result


def blend(primary: list[float], secondary: list[float], ratio: float) -> list[float]:
    ratio = max(0.0, min(1.0, float(ratio)))
    length = max(len(primary), len(secondary))
    result: list[float] = []
    for index in range(length):
        first = primary[index] if index < len(primary) else 0.0
        second = secondary[index] if index < len(secondary) else 0.0
        result.append(max(-1.0, min(1.0, first * (1.0 - ratio) + second * ratio)))
    return result


def convert_one(input_path: str, output_path: str, model_path: str, index_path: str, pitch: float, index_rate: float) -> tuple[int, list[float]]:
    from rvc_python.infer import RVCInference

    converter = RVCInference(device=os.environ.get("BETTERTTS_RVC_DEVICE", "cpu:0"))
    converter.load_model(model_path, version="v2", index_path=index_path)
    converter.set_params(f0up_key=int(round(pitch)), index_rate=max(0.0, min(1.0, index_rate)), protect=0.33, rms_mix_rate=1.0)
    converter.infer_file(input_path, output_path)
    return read_wav(output_path)


def convert(request: dict[str, Any]) -> None:
    sample_rate = int(request.get("sample_rate", 0))
    if sample_rate < SAMPLE_RATE_MIN or sample_rate > SAMPLE_RATE_MAX:
        raise ValueError("The requested RVC sample rate is outside the supported range.")
    samples = decode_pcm16(request.get("pcm16"))
    model_path = bounded_path(request.get("model_path"), ".pth")
    index_path = bounded_path(request.get("index_path"), ".index", required=False)
    blend_model_path = bounded_path(request.get("blend_model_path"), ".pth", required=False)
    blend_index_path = bounded_path(request.get("blend_index_path"), ".index", required=False)
    ratio = max(0.0, min(1.0, float(request.get("blend_ratio", 0.0))))
    pitch = max(-24.0, min(24.0, float(request.get("pitch_semitones", 0.0))))
    index_rate = max(0.0, min(1.0, float(request.get("index_rate", 0.5))))

    if TEST_MODE:
        # Explicit fixture only: it proves the transport and clipping path in
        # CI without pretending that a real model was loaded.
        emit({"type": "progress", "progress": 0.5, "stage": "Running explicit RVC transport fixture"})
        transformed = [max(-1.0, min(1.0, sample * 0.82)) for sample in samples]
        emit({"type": "result", "sample_rate": sample_rate, "pcm16": base64.b64encode(b"".join(struct.pack("<h", round(sample * (0x8000 if sample < 0 else 0x7FFF))) for sample in transformed)).decode("ascii")})
        return

    with tempfile.TemporaryDirectory(prefix="bettertts-rvc-") as directory:
        input_path = str(Path(directory) / "input.wav")
        output_a = str(Path(directory) / "output-a.wav")
        output_b = str(Path(directory) / "output-b.wav")
        write_wav(input_path, samples, sample_rate)
        emit({"type": "progress", "progress": 0.12, "stage": "Loading RVC model"})
        source_rate, converted_a = convert_one(input_path, output_a, model_path, index_path, pitch, index_rate)
        converted_a = resample(converted_a, source_rate, sample_rate)
        if blend_model_path:
            emit({"type": "progress", "progress": 0.56, "stage": "Converting through blend model"})
            blend_rate, converted_b = convert_one(input_path, output_b, blend_model_path, blend_index_path, pitch, index_rate)
            converted_b = resample(converted_b, blend_rate, sample_rate)
            converted_a = blend(converted_a, converted_b, ratio)
        emit({"type": "progress", "progress": 0.92, "stage": "Preparing converted audio"})
        raw = b"".join(struct.pack("<h", round(max(-1.0, min(1.0, sample)) * (0x8000 if sample < 0 else 0x7FFF))) for sample in converted_a)
        emit({"type": "result", "sample_rate": sample_rate, "pcm16": base64.b64encode(raw).decode("ascii")})


def main() -> None:
    line = sys.stdin.readline()
    if not line:
        raise ValueError("The RVC adapter received no request.")
    request = json.loads(line)
    if not isinstance(request, dict):
        raise ValueError("The RVC request must be an object.")
    if request.get("type") == "status":
        emit({"type": "status", "status": runtime_status()})
        return
    if request.get("type") != "convert":
        raise ValueError("Unsupported RVC adapter request.")
    status = runtime_status()
    if not status["available"] and not TEST_MODE:
        emit({"type": "error", "code": "missing-package", "message": status["message"]})
        return
    try:
        convert(request)
    except FileNotFoundError as error:
        emit({"type": "error", "code": "missing-model", "message": str(error)})
    except Exception as error:
        emit({"type": "error", "code": "failed", "message": str(error)[:1000]})

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "error", "code": "failed", "message": str(error)[:1000]})
