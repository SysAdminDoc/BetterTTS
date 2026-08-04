import type { CapabilityEngine } from './capabilities.ts'

export const APP_VERSION = "0.22.0"
export const CORE_ENGINES: readonly CapabilityEngine[] = [
  {
    "id": "kokoro",
    "label": "Kokoro local",
    "platforms": [
      "web",
      "windows"
    ],
    "runtime": [
      "browser",
      "native"
    ],
    "queueable": true,
    "streaming": true,
    "timestamps": true,
    "exportFormats": [
      "wav",
      "mp3",
      "opus",
      "flac",
      "m4b"
    ],
    "experimental": false,
    "firstLoad": "default",
    "modelId": "onnx-community/Kokoro-82M-v1.0-ONNX",
    "modelLicenseIds": [
      "kokoro-82m",
      "sherpa-kokoro"
    ],
    "postStages": [
      "rvc"
    ]
  },
  {
    "id": "supertonic",
    "label": "Supertonic",
    "platforms": [
      "web",
      "windows"
    ],
    "runtime": [
      "browser"
    ],
    "queueable": true,
    "streaming": true,
    "timestamps": false,
    "exportFormats": [
      "wav",
      "mp3",
      "opus",
      "flac",
      "m4b"
    ],
    "experimental": false,
    "firstLoad": "lazy",
    "modelId": "onnx-community/Supertonic-TTS-ONNX",
    "modelLicenseIds": [
      "supertonic"
    ],
    "postStages": [
      "rvc"
    ]
  },
  {
    "id": "kitten",
    "label": "KittenTTS",
    "platforms": [
      "web",
      "windows"
    ],
    "runtime": [
      "browser"
    ],
    "queueable": true,
    "streaming": true,
    "timestamps": false,
    "exportFormats": [
      "wav",
      "mp3",
      "opus",
      "flac",
      "m4b"
    ],
    "experimental": false,
    "firstLoad": "lazy",
    "modelId": "KittenML/kitten-tts-nano-0.1",
    "modelLicenseIds": [
      "kitten"
    ],
    "postStages": [
      "rvc"
    ]
  },
  {
    "id": "chatterbox",
    "label": "Chatterbox",
    "platforms": [
      "web",
      "windows"
    ],
    "runtime": [
      "browser"
    ],
    "queueable": false,
    "streaming": false,
    "timestamps": false,
    "exportFormats": [
      "wav",
      "mp3",
      "opus",
      "flac",
      "m4b"
    ],
    "experimental": true,
    "firstLoad": "lazy",
    "modelId": "onnx-community/chatterbox-ONNX",
    "modelLicenseIds": [
      "chatterbox"
    ],
    "postStages": [
      "rvc"
    ]
  },
  {
    "id": "piper",
    "label": "Piper-plus",
    "platforms": [
      "web",
      "windows"
    ],
    "runtime": [
      "browser",
      "native"
    ],
    "queueable": true,
    "streaming": true,
    "timestamps": false,
    "exportFormats": [
      "wav",
      "mp3",
      "opus",
      "flac",
      "m4b"
    ],
    "experimental": false,
    "firstLoad": "lazy",
    "modelId": "ayousanz/piper-plus-tsukuyomi-chan",
    "modelLicenseIds": [
      "piper-plus",
      "sherpa-piper"
    ],
    "postStages": [
      "rvc"
    ]
  },
  {
    "id": "melo",
    "label": "MeloTTS",
    "platforms": [
      "windows"
    ],
    "runtime": [
      "native"
    ],
    "queueable": true,
    "streaming": true,
    "timestamps": false,
    "exportFormats": [
      "wav",
      "mp3",
      "opus",
      "flac",
      "m4b"
    ],
    "experimental": false,
    "firstLoad": "lazy",
    "modelId": "myshell-ai/MeloTTS-Chinese",
    "modelLicenseIds": [
      "melo",
      "sherpa-melo"
    ],
    "postStages": [
      "rvc"
    ]
  },
  {
    "id": "qwen",
    "label": "Qwen3-TTS",
    "platforms": [
      "windows"
    ],
    "runtime": [
      "sidecar"
    ],
    "queueable": false,
    "streaming": false,
    "timestamps": false,
    "exportFormats": [
      "wav",
      "mp3",
      "opus",
      "flac",
      "m4b"
    ],
    "experimental": true,
    "firstLoad": "lazy",
    "modelId": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    "modelLicenseIds": [
      "qwen"
    ],
    "postStages": [
      "rvc"
    ]
  },
  {
    "id": "browser",
    "label": "Browser",
    "platforms": [
      "web",
      "windows"
    ],
    "runtime": [
      "browser"
    ],
    "queueable": false,
    "streaming": true,
    "timestamps": false,
    "exportFormats": [],
    "experimental": false,
    "firstLoad": "default",
    "modelId": "Web Speech API",
    "modelLicenseIds": [
      "browser"
    ],
    "postStages": []
  }
]
