# BetterTTS

[![Version](https://img.shields.io/badge/version-0.12.0-blue.svg)](#)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-GitHub%20Pages-24292f.svg)](https://sysadmindoc.github.io/BetterTTS/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178c6.svg)](#)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](#)
[![Tests](https://img.shields.io/badge/tests-114%20passing-53d889.svg)](#)

**Free client-side text-to-speech studio.** Kokoro 82M, Supertonic, and KittenTTS run entirely in your browser — no server, no signup, no usage caps (5,000 characters per run, unlimited runs). Export WAV, MP3, Opus, or chaptered M4B — keep everything private.

[**Try it live**](https://sysadmindoc.github.io/BetterTTS/) | [Changelog](CHANGELOG.md)

---

## Why BetterTTS?

Every cloud TTS service gates you behind signups, character limits, and paid tiers. BetterTTS runs the full Kokoro 82M neural model locally in your browser via WebGPU or WASM — your text never leaves your device. No API keys, no queue, no watermarks, no 10,000-character monthly cap.

| | BetterTTS | ElevenLabs Free | TTSMaker Free | voice-generator.com |
|---|---|---|---|---|
| Character limit | **Unlimited** | 10,000/month | 20,000/week | Unlimited |
| Signup required | **No** | Yes | No | No |
| Runs locally | **Yes** | No | No | No |
| WAV export | **Yes** | No (MP3 only) | Yes | No |
| MP3 export | **Yes** | Yes | Yes | No |
| Commercial use | **Yes (MIT)** | Paid only | With attribution | Yes |
| Subtitle export | **SRT + VTT** | No | SRT (paid) | No |
| Voice count | 41 | 30+ (free tier) | 300+ | 54 |
| Pitch control | **Yes** | Paid only | No | No |
| Offline capable | **Yes (PWA)** | No | No | No |

## Features

### Studio Interface
- **Premium workstation UI** with a compact topbar, editor toolbar, output deck, persistent queue/library empty states, inspector-style engine controls, generation status module, and bottom system rail
- **Clean dark and light themes** using shared design tokens, 4-8px control radii, visible focus states, and mobile-responsive toolbar collapse

### Audio Generation
- **Kokoro 82M** neural TTS via `kokoro-js` + Transformers.js — top-tier voice quality (MOS 4.3-4.5)
- **Supertonic speed engine** via Transformers.js — 10 English F/M voices, 44.1 kHz fp32 output, lazy-loaded only when selected
- **KittenTTS lightweight engine** via `kitten-tts-webgpu` — 8 English voices, WebGPU shader inference, and selectable Nano 15M / Micro 40M / Mini 80M models
- **41 Kokoro voices** — 28 English voices plus Spanish, French, Hindi, Italian, and Brazilian Portuguese voices
- **Multilingual Kokoro pack** — ephone/eSpeak NG phonemization routes `es`, `fr`, `it`, `pt-BR`, and `hi` through the direct Kokoro model path
- **WebGPU acceleration** with automatic WASM q8 fallback for devices without GPU support
- **Pages-hosted WASM q8 model** with Hugging Face fallback and 429-aware retry; WebGPU fp32 stays HF-hosted because it exceeds the Pages file cap
- **Web Worker inference** — generation runs off the main thread so the UI stays responsive
- **Streaming playback** — audio plays as each sentence is synthesized, no waiting for the full run
- **Web Speech API fallback** — device-native voices when Kokoro can't run, with full browser voice picker

### Export & Output
- **WAV** (lossless), **MP3** (96/128/160 kbps), **Opus/WebM**, and **chaptered M4B audiobook** export
- **Per-line generation** with individual files + automatic ZIP bundle
- **SRT and VTT subtitle export** with sentence-level timing, plus opt-in word-level cues from the timestamped Kokoro model
- **Persistent clip library** — generated clips saved to IndexedDB, survive page reloads
- **Web Share** for sharing audio files directly from the app (Android Chrome)
- **Native save dialog** via `showSaveFilePicker` on Chromium, with `<a download>` fallback

### Audio Processing
- **Pitch control** - +/-4 semitones via Signalsmith Stretch AudioWorklet/WASM rendering, without tempo change
- **Background music mixing** — upload any audio file, loop to speech length, mix at adjustable volume
- **Silence insertion** — `[pause 2s]` tags splice real silence into the output
- **Speed control** — engine-aware ranges: Kokoro 0.5x-1.5x, Supertonic 0.8x-1.2x, KittenTTS 0.5x-2.0x

### Studio Features
- **Dialog mode** — `[speaker:Alice]` line prefixes map to different voices for multi-character scripts
- **Follow-along transcript** — click-to-seek sentence highlighting synced to playback
- **Article import** — paste any URL and Readability extracts the text (plus Android share-target support)
- **Text cleanup** — skip citations, shorten URLs, spell vowel-less acronyms, strip markdown before synthesis
- **Voice preview** — one-click preview for each voice with session-cached audio
- **Pronunciation dictionary** — custom word/replacement pairs persisted in localStorage
- **Generation stats** — elapsed time, chars/s throughput, audio duration, realtime speed factor
- **Cancel button** — abort generation mid-run, keep partial results
- **Voice blending** — weighted mix of 2-4 Kokoro voices via custom style tensors (e.g. `af_heart(2)+af_bella(1)`)
- **EPUB import** — chapter-aware parsing with TOC title extraction, queued for batch generation
- **Persistent job queue** — queue, pause, resume, ZIP-download, and M4B audiobook export survive tab close via IndexedDB checkpointing
- **CPU mode** — persistent WASM switch for GPUs with corrupted WebGPU output

### Platform
- **Installable PWA** with service worker for offline app shell and per-build cache versioning
- **COOP/COEP headers** injected via service worker for SharedArrayBuffer threaded WASM
- **Content-Security-Policy** baked into production builds
- **Persistent storage** request + usage meter; clip library auto-evicts past a 200 MB cap
- **Media Session API** — lock-screen play/pause controls for generated audio
- **Dark and light themes** with `prefers-color-scheme` detection and zero-flash boot
- **Responsive layout** — works on desktop and mobile
- **Accessible** — ARIA progressbar, live status, native caption tracks, alert toasts, AA contrast ratios

## Quick Start

```bash
# Clone and install
git clone https://github.com/SysAdminDoc/BetterTTS.git
cd BetterTTS
npm install

# Development
npm run dev

# Run tests
npm test

# Production build
npm run build
```

Open `http://localhost:5173/BetterTTS/` in your browser.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 19 + TypeScript 6 |
| Build | Vite 8 |
| TTS Model | Kokoro 82M via `kokoro-js` 1.2.1 + Transformers.js 4.2.0; timestamped Kokoro via direct ONNX output; Supertonic via Transformers.js 4.2.0; KittenTTS via `kitten-tts-webgpu` |
| MP3 Encoding | `@breezystack/lamejs` (LGPL-2.1, browser LAME) |
| M4B Export | WebCodecs AAC + direct ISO BMFF writer with QuickTime/Nero chapter metadata |
| Pitch Shifting | `signalsmith-stretch` (MIT, AudioWorklet/WASM) |
| Phonemization | `phonemizer` for English + `ephone`/eSpeak NG WASM for multilingual Kokoro |
| ZIP Packaging | `fflate` |
| Icons | `lucide-react` |
| Testing | Vitest (114 assertions across 15 suites) |
| Linting | oxlint |
| Hosting | GitHub Pages (static, no backend) |

## Architecture

```
src/
├── App.tsx                  # App shell, state, UI
├── App.css                  # Layout and component styles
├── index.css                # Design tokens, dark/light themes
├── main.tsx                 # React entry point + SW registration
├── lib/
│   ├── kokoro.ts            # Model loader, WebGPU probe, WASM fallback
│   ├── kokoro-assets.ts     # Pages-hosted q8 asset routing + HF fallback
│   ├── kokoro-multilingual.ts # ephone + direct Kokoro model path for es/fr/it/pt-BR/hi
│   ├── kokoro-timestamps.ts # Timestamped Kokoro loader and word cue alignment
│   ├── kokoro-worker.ts     # Web Worker client interface
│   ├── supertonic.ts        # Supertonic pipeline loader and voice metadata
│   ├── kitten.ts            # KittenTTS WebGPU wrapper, metadata, and WAV parser
│   ├── encode.ts            # WAV/MP3 encoding, pitch shift, BGM mixing
│   ├── m4b.ts               # WebCodecs AAC + M4B chapter muxing
│   ├── wav.ts               # Raw PCM → WAV encoder
│   ├── text.ts              # Sentence splitting, pause parsing, slugify
│   ├── voices.ts            # 41-voice Kokoro catalog with quality grades
│   ├── webspeech.ts         # Browser Speech API wrapper
│   ├── subtitles.ts         # SRT/VTT serializers
│   └── library.ts           # IndexedDB clip storage
├── worker/
│   └── tts.worker.ts        # Off-thread Kokoro inference
└── signalsmith-stretch.d.ts        # Type declarations
```

**Key design decisions:**
- WASM q8 model files (~107 MB including tokenizer and 28 voice bins) load from the GitHub Pages site first, then fall back to Hugging Face with 429-aware retry
- Word-level SRT/VTT is opt-in and uses the HF-hosted `Kokoro-82M-v1.0-ONNX-timestamped` q8 graph plus duration-output alignment
- All audio generation and processing happens client-side — zero network calls after model download
- Web Worker isolates WASM/WebGPU inference from the main thread
- Service worker injects COOP/COEP headers to enable SharedArrayBuffer for threaded WASM on GitHub Pages

## Deploy to GitHub Pages

This project does not use GitHub Actions. Build and publish locally:

```bash
npm run deploy
```

The deploy script builds `dist/`, syncs the Pages-hosted Kokoro q8 model assets into `dist/models/`, and force-pushes it to the `gh-pages` branch from a disposable git worktree, so your working tree is never modified. Then in repository settings: **Pages** → Source: `gh-pages` branch, folder: `/`.

## Voice Catalog

41 Kokoro voices spanning American English, British English, Spanish, French, Hindi, Italian, and Brazilian Portuguese. English voices keep the detailed quality grades from Kokoro's VOICES metadata:

| Grade | Voices |
|---|---|
| A | Heart |
| A- | Bella |
| B- | Nicole, Emma |
| C+ | Aoede, Kore, Sarah, Fenrir, Michael, Puck |
| C | Alloy, Nova, Isabella, Fable, George |
| C- | Sky |
| D+ | Lewis |
| D | Jessica, River, Echo, Eric, Liam, Onyx, Alice, Lily, Daniel |
| D- | Santa |
| F+ | Adam |

Multilingual voices:

| Language | Voices |
|---|---|
| Spanish | Dora, Alex, Santa |
| French | Siwis |
| Hindi | Alpha, Beta, Omega, Psi |
| Italian | Sara, Nicola |
| Brazilian Portuguese | Dora, Alex, Santa |

## Model Details

| Attribute | Value |
|---|---|
| Model | Kokoro-82M v1.0 |
| Parameters | 82 million |
| ONNX source | `onnx-community/Kokoro-82M-v1.0-ONNX` |
| Sample rate | 24,000 Hz |
| WebGPU dtype | fp32 (~326 MB, HF-hosted) |
| WASM dtype | q8 (~92 MB, Pages-hosted) |
| Languages | English (US + British), Spanish, French, Hindi, Italian, Brazilian Portuguese |
| License | Apache-2.0 |

Supertonic is available as a separate English speed engine: 66M parameters, 10 voices, 44,100 Hz output, HF-hosted fp32 ONNX assets, OpenRAIL license, and Transformers.js 4.2.0 runtime.

KittenTTS is available as a separate English lightweight engine: Nano 15M / 24 MB by default, Micro 40M / 41 MB, Mini 80M / 78 MB, 8 voices, 24,000 Hz output, WebGPU-only shader inference, MIT package code, and Apache-2.0 model weights. The package is lazy-loaded and model weights stay HF-hosted until the engine is selected.

Word timestamps are available as an opt-in Kokoro mode using `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped`; the extra q8 model stays HF-hosted and powers word-level SRT/VTT plus follow-along highlighting.

## Roadmap

The active ROADMAP contains research-driven follow-ups from the 2026-07-09 post-v0.11.0 research pass. ROADMAP.md is gitignored and tracks only incomplete local work.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm test && npm run lint && npm run build`
5. Submit a pull request

Please match the existing code style. No new dependencies without justification.

## License

[MIT](LICENSE)

---

Built with [Kokoro](https://github.com/hexgrad/kokoro) and [Transformers.js](https://github.com/huggingface/transformers.js).
