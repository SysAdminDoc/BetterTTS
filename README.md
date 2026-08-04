# BetterTTS

[![Version](https://img.shields.io/badge/version-0.23.0-blue.svg)](#)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Web%20%7C%20Windows-24292f.svg)](https://sysadmindoc.github.io/BetterTTS/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178c6.svg)](#)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](#)
[![Tests](https://img.shields.io/badge/tests-542%20passing-53d889.svg)](#)

<!-- BEGIN BETTERTTS CAPABILITIES -->
- **Application:** BetterTTS v0.23.0 · Web + Windows
- **Engines:** Kokoro local, Supertonic, KittenTTS, Chatterbox (experimental), Piper-plus, MeloTTS, Qwen3-TTS (experimental), Browser
- **Queue:** resumable jobs for Kokoro local, Supertonic, KittenTTS, Piper-plus, MeloTTS
- **Exports:** WAV, MP3, OPUS, FLAC, M4B audio · SRT, VTT, ASS captions
- **Tests:** 542 tests across 94 test files
- **Runtime licenses:** 21 direct package rows validated by `npm run license:runtime`
- **Model licenses:** Kokoro 82M (Apache-2.0); Sherpa Kokoro int8 pack (Apache-2.0); Supertonic ONNX model (OpenRAIL); KittenTTS model (Apache-2.0); Chatterbox ONNX models (MIT); Piper-plus Tsukuyomi-chan (MIT); Sherpa Piper Cori pack (Public-Domain); MeloTTS model (MIT); Sherpa MeloTTS pack (MIT); Qwen3-TTS model (Apache-2.0); Browser voices (Device-managed)
<!-- END BETTERTTS CAPABILITIES -->

**Private local text-to-speech studio for web and Windows.** Kokoro 82M, native MeloTTS, Supertonic, KittenTTS, Chatterbox, an experimental Piper-plus path, optional desktop Qwen3-TTS, narrator mode, and an opt-in desktop RVC post-stage run on your device — no account, cloud synthesis, or usage caps (5,000 characters per run, unlimited runs). The Windows model manager also supports explicit metadata-only registration of self-supplied restricted weights. Export WAV, MP3, Opus, or chaptered M4B while keeping scripts and audio local.

[**Try it live**](https://sysadmindoc.github.io/BetterTTS/) | [Changelog](CHANGELOG.md)

> **Windows desktop app.** The Electron build reuses the same studio inside a version-locked Chromium shell and can synthesize Kokoro, MeloTTS, and English Piper through **Sherpa-ONNX** in an isolated utility process. It also bundles the pinned whisper.cpp x64 CLI for optional imported-audio word alignment; multilingual GGML weights stay in the user model folder and are never bundled. Optional Qwen3-TTS runs in a private Python sidecar: its torch/qwen-tts environment and model weights are downloaded into the desktop user-data folder only after the user starts setup or synthesis. Optional RVC conversion uses user-selected `.pth`/`.index` files through a separate Python adapter; the app stores their paths and provenance, never copies them, and only installs `rvc-python` after explicit setup. Native model archives are pinned to immutable revisions and SHA-256 verified before extraction and use. Enable **Native engine (desktop)** under Voice chain -> Engine -> System & diagnostics. The unsigned NSIS build checks a static HTTPS update feed; downloads and restart installs require an explicit user action. Run `npm run desktop:dev` for development or `npm run desktop:dist` to build the installer.

---

## Why BetterTTS?

Every cloud TTS service gates you behind signups, character limits, and paid tiers. BetterTTS runs its engines locally through WebGPU, WebAssembly, or native Sherpa-ONNX — your text never leaves your device. No API keys, cloud render queue, or 10,000-character monthly cap. Chatterbox is an explicit ownership/permission-gated voice-cloning lab and retains its built-in PerTh watermark.

| | BetterTTS | ElevenLabs Free | TTSMaker Free | voice-generator.com |
|---|---|---|---|---|
| Character limit | **Unlimited** | 10,000/month | 20,000/week | Unlimited |
| Signup required | **No** | Yes | No | No |
| Runs locally | **Yes** | No | No | No |
| WAV export | **Yes** | No (MP3 only) | Yes | No |
| MP3 export | **Yes** | Yes | Yes | No |
| Commercial use | **Yes (MIT)** | Paid only | With attribution | Yes |
| Subtitle export | **SRT + VTT + ASS** | No | SRT (paid) | No |
| Voice count | 54 | 30+ (free tier) | 300+ | 54 |
| Pitch control | **Yes** | Paid only | No | No |
| Offline capable | **Yes (PWA)** | No | No | No |

## Features

### Studio Interface
- **Premium production workspace** with a persistent destination rail, session-aware command bar, dominant script canvas, real Output/Queue/Library tabs, integrated waveform transport, and compact properties inspector
- **Clean dark and light themes** using neutral semantic design tokens, 4-8px control radii, visible focus states, and a mobile command grid that preserves full editor width
- **Locale-ready interface** with a persisted UI-language boundary kept separate from each engine's synthesis-language selector; only reviewed English UI ships until translations are reviewed

### Audio Generation
- **Kokoro 82M** neural TTS via `kokoro-js` + Transformers.js — top-tier voice quality (MOS 4.3-4.5)
- **Kokoro short-input cleanup** — one-to-four-word English renders use padded context and timestamped boundary cropping to remove leading/trailing artifacts across generation, queue chunks, and voice previews
- **Supertonic speed engine** via Transformers.js — 10 English F/M voices, 44.1 kHz fp32 output, lazy-loaded only when selected
- **KittenTTS lightweight engine** via `kitten-tts-webgpu` — 8 English voices, WebGPU shader inference, and selectable Nano 15M / Micro 40M / Mini 80M models
- **Chatterbox voice-cloning engine** via Transformers.js 4.2.0 — explicit ownership/permission acknowledgement before local reference clips, English or multilingual 23-language model, WebGPU-preferred inference, emotion exaggeration, permissive-license gate, local provenance on saved clips, and disclosed PerTh watermark
- **Experimental Piper-plus engine** behind an explicit flag — Tsukuyomi-chan model, MIT package/runtime path, WASM + ONNX Runtime Web, and JA/EN/ZH/KO/ES/FR/PT/SV language targets
- **MeloTTS native engine** — pinned MIT Chinese + English VITS archive through Sherpa-ONNX, single speaker, 44.1 kHz, Windows desktop only
- **Optional desktop Qwen3-TTS 0.6B CustomVoice engine** — multilingual CustomVoice synthesis through a private Python sidecar, with language, speaker, style instruction, progress, cancellation, and explicit first-use setup
- **Optional desktop RVC voice conversion** — post-process generated audio through a registered local `.pth` model, with optional second-model blending, explicit consent, and provenance recorded on the saved clip
- **Versioned generation provenance** — saved clips and resumable jobs retain engine/model revisions, voice, synthesis, cleanup, pronunciation, BGM, encoder, source hash, cues, and RVC context; ZIP/project exports and M4B metadata carry the manifest while source text and article URLs remain opt-in
- **Text normalization preview** — imported text can show compact rule-grouped before/after changes, toggle cleanup rules, apply or undo them, restore the raw import, and inspect the exact synthesized text snapshot
- **Narrator mode** — auto-split quoted dialogue and `[speaker:Name]` lines from narration, assign a voice per role, and preserve those assignments through resumable queue and M4B export
- **54 Kokoro voices** — 28 English voices plus Japanese, Mandarin Chinese, Spanish, French, Hindi, Italian, and Brazilian Portuguese voices
- **Multilingual Kokoro pack** — ephone/eSpeak NG phonemization routes `ja`, `cmn`, `es`, `fr`, `it`, `pt-BR`, and `hi` through the direct Kokoro model path
- **Cross-browser WebGPU acceleration** with adapter probing, automatic WASM q8 fallback, a local bad-audio denylist, and a persisted experimental fp16 opt-in; fp32 remains the default
- **Pages-hosted WASM q8 model** with immutable revision + SHA-256-verified deployment assets, Hugging Face fallback, and 429-aware retry; WebGPU fp32/fp16 assets stay HF-hosted because they exceed the Pages file cap
- **Web Worker inference** — generation runs off the main thread so the UI stays responsive
- **Native desktop inference** — the Electron build runs Kokoro, MeloTTS, and English Piper on `sherpa-onnx-node` 1.13.4 (CPU EP) in an isolated utility process, loading SHA-256-verified archives pinned to immutable revisions; the runtime reports the verified Windows x64 addon and active pack
- **Local OpenAI-compatible API** — the Windows app can opt into a loopback-only `POST /v1/audio/speech` server for native Kokoro, MeloTTS, and English Piper, with WAV/MP3/Opus/FLAC output and bounded SSE base64 streaming; it is off by default and fully stops when disabled
- **RVC post-stage** — desktop-only timbre conversion runs after TTS and before pitch/BGM/export; it waits for the complete clip and is unavailable to the persistent queue while enabled
- **Narrator mode** — quote-aware long-form segmentation uses distinct narration/dialogue voices, while plain text falls back to one narration voice
- **Headless native CLI** — `bettertts synth` converts TXT or EPUB input to WAV, MP3, Opus, FLAC, or chaptered M4B with SRT/VTT captions and machine-readable progress, without launching the GUI
- **Desktop audio captioning** — import a WAV/MP3/FLAC/OGG/WebM recording, choose a language or auto-detect, and run the pinned whisper.cpp x64 CLI in an isolated utility process for word-level multilingual cues; missing model/runtime recovery is explicit
- **SRT/VTT re-voicing** — import existing timed subtitles, synthesize each cue with the selected local engine, preserve absolute silence gaps and overlaps, and export one timeline-aligned audio file with visible fit warnings
- **Prosody panel** — opt-in per-punctuation pauses are persisted and reversible, while selected editor spans can carry explicit rate and pitch deltas through local synthesis and queue resume
- **Listening speed trainer** — opt in to +5% playback ramps after configurable active-listening intervals, with a persisted per-profile cap, visible progress, and reset
- **Mini player** — supported Chromium/Firefox browsers can pop active playback into a Document Picture-in-Picture controller with sentence highlighting, seek, and sentence skips; Media Session remains the fallback elsewhere
- **Streaming playback** — audio plays as each sentence is synthesized, no waiting for the full run
- **Web Speech API fallback** — device-native voices when Kokoro can't run, with full browser voice picker

### Export & Output
- **WAV** (lossless), **MP3** (96/128/160 kbps), **Opus/WebM**, and **chaptered M4B audiobook** export with AAC capability preflight
- **EPUB3 Media Overlays** — completed EPUB queue jobs export text, SMIL timing, synchronized audio, and active highlight classes; WAV queue audio is normalized to EPUB-compatible MP3
- **EPUB chapter mapping** — review imported chapters before queueing: rename, split, merge, reorder, exclude, assign voices, or configure per-chapter weighted Kokoro blends; “Queue with defaults” preserves the quick path
- **Sentence retakes** — select a sentence in a completed queue chunk, edit and regenerate up to four local A/B takes, then apply the chosen take with a cue-boundary crossfade; the original stays intact until commit
- **Per-line generation** with individual files + automatic chaptered ZIP bundle, including `chapters.json` for fallback workflows
- **SRT, VTT, and ASS subtitle import/export** with sentence-level timing, cue-by-cue timeline re-voicing, and karaoke/pop-on/outline styling presets, plus opt-in word-level cues from the timestamped Kokoro model or desktop whisper.cpp forced alignment
- **Persistent clip library** — generated clips saved to IndexedDB, survive page reloads, restore their last playback position, and support label/filename search, voice/engine/cue filters, created/duration/size sorting, storage-cap visibility, lazy audio loading, and missing-blob recovery
- **Reader mode** — imported EPUBs, articles, PDFs, DOCX files, and text open in a book-like, chapter-aware view with stable sentence/word karaoke highlighting, paragraph-to-playback jumps, per-document resume, optional line focus, and EPUB queue audio tracks
- **Honest persistence state** — settings and crash-recovery writes are verified; blocked/private/quota-limited storage switches the shell to session-only guidance instead of claiming data was saved
- **Web Share** for sharing audio files directly from the app (Android Chrome)
- **Native save dialog** via `showSaveFilePicker` on Chromium, with `<a download>` fallback

### Audio Processing
- **Pitch control** - +/-4 semitones via Signalsmith Stretch AudioWorklet/WASM rendering, without tempo change
- **Studio cleanup** — opt-in Windows FFmpeg denoise plus conservative room-tail reduction for imported BGM and generated output; the before-cleanup audio remains playable in the current session for comparison
- **Background music mixing** — upload any audio file, loop to speech length, mix at adjustable volume, and optionally auto-duck the music beneath the speech envelope with adjustable depth
- **Loudness targets** — choose Off, audiobook mono (-19 LUFS), or podcast stereo (-16 LUFS); browser exports use a gated client-side estimate with a -1.5 dBTP true-peak ceiling, native FFmpeg exports use two-pass EBU R128, and completed outputs show measured LUFS/dBTP
- **Silence insertion** — `[pause 2s]` tags splice real silence into the output
- **Prosody markup** — `[prosody rate=1.15 pitch=2]emphasized text[/prosody]` splits synthesis at span boundaries; defaults remain 1x and 0 semitones
- **Speed control** — engine-aware ranges: Kokoro 0.5x-1.5x, Supertonic 0.8x-1.2x, KittenTTS 0.5x-2.0x; Chatterbox uses its emotion sampler instead

### Studio Features
- **Dialog mode** — `[speaker:Alice]` line prefixes map to different voices for multi-character scripts
- **Follow-along transcript** — click-to-seek sentence highlighting synced to playback, durable resume, and previous/next sentence controls
- **Document import** — open TXT, EPUB, PDF, or DOCX files; ZIP-backed formats are inspected against bounded entry, expansion, and compression-ratio limits before extraction, and PDF/DOCX text is cleaned with the same reversible audiobook cleanup controls before synthesis or Reader mode
- **Desktop workflow integrations** — opt-in Windows global read-selection hotkey, per-user Explorer menu plus “Open with BetterTTS” registrations for TXT/EPUB/PDF/DOCX, bounded folder import, optional Tesseract screen OCR, tray render status, and completion notifications; every OS hook is independently disableable and the web/PWA build remains unchanged
- **Article import** — paste any URL and Readability extracts the text (plus Android share-target support)
- **Text cleanup** — skip citations, footnotes, references, repeated page headers/footers, book metadata, URLs, markdown, re-flow wrapped PDF lines with end-of-line hyphen repair, and normalize audiobook numbers/units before synthesis; the persisted rules are previewable and reversible
- **Voice preview** — one-click preview for each voice with a bounded 20-entry session LRU cache and object-URL disposal
- **Pronunciation dictionary** — versioned JSON pack import/export, a bundled tech-abbreviation starter pack, and word-bounded respelling or eSpeak phoneme entries persisted locally
- **Generation stats** — elapsed time, time to first audio, chars/s throughput, audio duration, realtime speed factor
- **Cancel button** — abort generation mid-run, keep partial results
- **Completeness check** — every sentence is verified against a speech-rate floor; possibly truncated or missing audio is flagged in the output, queue, and diagnostics instead of failing silently
- **Voice blending** — weighted mix of 2-4 Kokoro voices via custom style tensors (e.g. `af_heart(2)+af_bella(1)`)
- **EPUB import** — chapter-aware parsing with TOC title extraction, an editable pre-queue mapping step, per-chapter voice/blend metadata, resumable batch generation, and EPUB3 Media Overlay export after synthesis
- **Engine-aware persistent job queue** — queue Kokoro, Supertonic, and KittenTTS jobs; pause, resume, edit/regenerate completed chunks safely, play completed chunks, ZIP-download, and M4B audiobook export survive tab close via IndexedDB checkpointing
- **M4B preflight + fallback** — queue UI probes WebCodecs AAC before export, including Safari/WebKit AAC when its codec probe passes; Firefox/Linux gaps get a chaptered ZIP/Opus fallback path
- **CPU mode** — persistent WASM switch for GPUs with corrupted WebGPU output

### Platform
- **Installable PWA** with service worker for offline app shell, per-build cache versioning, safe waiting-worker updates that retain the previous shell generation until reload, and desktop/mobile install screenshots
- **Companion MV3 browser extension** — permission-minimal selection/page context actions open the PWA with the captured text; the packaged archive is built with `npm run extension:build`
- **COOP/COEP headers** injected via service worker for SharedArrayBuffer threaded WASM
- **Content-Security-Policy** baked into production builds; document scripts stay same-origin while worker/media/image blob URLs remain destination-scoped
- **Persistent storage** request + usage meter; clip library auto-evicts past a 200 MB cap, warns at 90% quota, and recovers from full-storage saves by evicting oldest clips
- **Offline pack manager** — inspect per-engine model cache size, distinguish the app-shell cache, prefetch the selected Kokoro q8 voice pack, and selectively clear stale engine caches
- **Diagnostics export** — copy or download a local JSON support bundle with browser and native app/OS/runtime details, WebGPU adapter identity/denylist state, codec, generation timing, storage, cache, model-route, verified model-pack and FFmpeg status, sidecar stderr summaries, redacted paths, and recent sanitized error state; report corrupted WebGPU audio from the same panel to force that adapter onto WASM q8
- **Media Session API** — lock-screen play/pause, seek, and sentence-skip controls for generated audio
- **Audio output routing** — where the browser grants Audio Output Devices API support, choose a speaker or headset for every registered playback surface; unsupported browsers hide the picker
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

# Verify runtime license coverage
npm run license:runtime

# Validate the software/model SBOM inventory
npm run sbom:check

# Validate generated capability facts and test totals
npm run capabilities:check

# Local rendered smoke check
npm run smoke

# Package the optional browser extension
npm run extension:build

# Production build
npm run build

# Build the Windows native hosts and headless CLI
npm run desktop:build

# Run the Electron accessibility/native-window smoke contract
npm run desktop:smoke

# Convert a text file or EPUB without opening Electron
node dist-electron/bettertts-cli.cjs synth --in book.epub --voice af_heart --m4b --out book.m4b

# Re-check the existing production bundle against pinned shell/lazy-asset budgets
npm run budget:build

# Opt-in release gate: real pinned browser + packaged Electron synthesis
npm run release:smoke
```

Open `http://localhost:5173/BetterTTS/` in your browser.

## Troubleshooting

Use **Voice chain -> Engine -> System & diagnostics -> Diagnostics -> Copy JSON** when reporting a local runtime issue. The bundle includes app version, platform details, native runtime/provider state, verified model-pack and FFmpeg status, bounded sidecar/native stderr summaries, WebGPU adapter identity and denylist state, WebCodecs AAC/Opus support, the last generation's time to first audio, Cross-Origin Storage detection, Transformers.js upgrade readiness, Piper-plus runtime support, storage quota, model-cache summary, selected model routes, redacted path labels, and recent sanitized warnings/errors. It does not include script text or imported article URLs. If a WebGPU clip is corrupted or produces screeching audio, choose **Report bad audio** in the WebGPU adapter panel; BetterTTS stores only the adapter fingerprint and uses WASM q8 for that adapter until you clear the report.

BetterTTS currently pins `@huggingface/transformers` to 4.2.0 through the root npm override. Do not switch to 4.3+ until the candidate install dedupes with `npm ls @huggingface/transformers`, the Kokoro/Supertonic/Kitten compatibility tests pass under that candidate (`npx vitest run src/lib/transformers-v4.test.ts src/lib/kokoro-assets.test.ts src/lib/supertonic.test.ts src/lib/kitten.test.ts`), and the full `npm test`, `npm run lint`, `npm run build`, and `npm run smoke` checks pass. Cross-Origin Storage is feature-detected only; the default model path stays on the per-origin Cache API until native browser support is available without an extension or polyfill.

Run `npm run smoke` for a local production-build browser check. It serves `dist/` at `/BetterTTS/`, verifies both themes, semantic navigation and display preferences, mobile navigation, keyboard tabs, diagnostics and update actions, the browser-extension text handoff, listening-trainer/prosody controls, capability-gated Document PiP and audio-output controls, queue/library playback and Undo recovery, subtitle/ASS controls, empty states, M4B capability state, PWA screenshot manifest assets, initial-shell lazy-load boundaries, time to interactive, and unexpected console noise. Nine required screen captures plus `summary.json` are written to `dist/smoke/`; missing or empty captures fail the run. Every production build also enforces the raw/gzip shell and lazy-runtime limits in `scripts/performance-budget.json`; `npm run typecheck` covers renderer and Electron sources, and `npm run desktop:probe-host` checks the same pinned fixture's time to first audio and real-time factor.

`npm run desktop:smoke` runs the built Electron shell through the model-free native-window contract and checks theme switching, focus-visible keyboard reachability, smoke-safe file-picker cancellation, diagnostics, updater no-op state, and display-aware screenshot capture. On Windows, run GUI smoke through the repository's private-desktop visual-isolation harness so the window never enters the interactive desktop.

`npm run release:smoke` is the slower, networked release gate. It uses the immutable Apache-2.0 Kokoro q8 revision to synthesize and decode real browser and packaged-Electron WAV output, validates SRT/VTT cues, cancellation, and partial-queue resume, rebuilds the unsigned Windows installer, and removes its temporary native model cache. The ordinary `npm run smoke` command remains model-free.

The headless CLI is built by `npm run desktop:build` and runs the same verified Sherpa native host as the Windows app, but never opens a window. `bettertts synth --in book.epub --voice af_heart --m4b --out book.m4b` writes the audiobook plus sibling `book.srt` and `book.vtt` files; TXT input, WAV/MP3/Opus/FLAC formats, `--dry-run`, `--json`, `--force`, and `--no-captions` are also supported. Native model packs live in the user cache (override with `BETTERTTS_MODEL_CACHE`), and M4B output plus Studio cleanup require FFmpeg on `PATH` or `BETTERTTS_FFMPEG_PATH`.

Desktop audio captioning is available from the generated-output panel. `npm run desktop:build` fetches and SHA-256 verifies the pinned whisper.cpp v1.9.1 Windows runtime; it does not download model weights. Place the multilingual `ggml-base.bin` file in the app user-data folder under `models/whisper/`, or set `BETTERTTS_WHISPER_MODEL` to an existing GGML model path. The UI reports the exact recovery guidance when the runtime or model is missing. The same panel accepts SRT/VTT files for local cue-timed re-voicing without whisper.cpp.

Desktop workflow integrations are available from **Voice chain -> Engine -> System & diagnostics** and are off by default. The read-selection hotkey reads the current clipboard after you copy a selection; it never injects keyboard input. The Explorer option registers per-user context-menu and “Open with BetterTTS” entries for TXT, EPUB, PDF, and DOCX and queues the imported file in BetterTTS. **Import folder** walks supported documents with 100-file/100 MB bounds and sends file bytes through the isolated bridge. Screen OCR requires a local Tesseract installation or `BETTERTTS_TESSERACT_PATH`; capture runs only when you request it. Tray status and completion/error notifications are opt-in. Disable each option independently to remove its OS hook; web/PWA builds do not expose OS integrations.

Qwen3-TTS is available only in the Windows desktop app. Select it under Voice chain -> Engine to inspect the sidecar status, then choose **Set up Qwen3-TTS** when the private Python 3.12 environment is not installed. Setup downloads `torch` and `qwen-tts` into the desktop user-data folder; the 0.6B model weights download on first synthesis into `models/qwen/` and are never bundled in the installer. A disposable worker isolates inference and reports setup, progress, cancellation, and crash recovery. The web/PWA build remains unchanged when the desktop bridge is absent.

The **Bring-your-own weights** panel is disabled by default and is available in the Windows desktop app after an explicit non-commercial/restricted-terms acknowledgement. Choose a local file or directory for F5-TTS, XTTS-v2, Fish/OpenAudio S1, Higgs Audio, MaskGCT, Silero, or another compatible model, then record its exact license and provenance. BetterTTS stores only that metadata and the selected path, never downloads or copies the weights, and keeps registered models adapter-gated rather than silently activating them. Unchecking the acknowledgement hides the registered models until it is enabled again.

The **RVC voice conversion** post-stage is available only in the Windows desktop app. Enable the consent gate under **Voice chain -> Engine -> System & diagnostics**, register a local `.pth` model and optional `.index` file with its license and provenance, then enable RVC in Advanced options. A second registered model can be blended through two inference passes. BetterTTS keeps the original files in place and records the selected model metadata on each converted clip; the optional Python 3.10 runtime and `rvc-python` package are installed only when you choose setup. If the package, runtime, or selected model is missing, the stage reports recovery guidance instead of silently falling back.

**Narrator mode** is available in the Voice chain for local engines. Enable it in Advanced options to split ordinary quoted speech and explicit `[speaker:Name]` lines from narration, then choose the narration and dialogue voices. Plain text remains a single narration segment. Queue jobs persist the role, optional speaker, and exact voice on each chunk; ZIP manifests include the same metadata and M4B export uses the already-rendered role-specific audio. Engines with one active voice use the narration voice for both roles.

The **Local OpenAI-compatible TTS server** is also desktop-only and starts only from **Voice chain -> Engine -> System & diagnostics**. It binds to `127.0.0.1` on the selected port (default `8765`) and exposes `GET /health`, `GET /v1/models`, and `POST /v1/audio/speech`. A minimal request is `{"input":"Hello","model":"kokoro","voice":"af_heart","response_format":"wav"}`; add `"stream":true` or `"stream_format":"sse"` for SSE events containing base64 audio chunks followed by `data: [DONE]`. Supported models are `kokoro`, `kokoro-82m`, `piper`, and `piper-plus`; the native provider currently maps Piper voices to English Cori. The server does not expose browser-only engines and never listens on a non-loopback interface.

The Windows app can create and open portable `.bettertts` projects from System tools. Projects contain editor state, settings, resumable queues, saved clips, and checksummed audio assets; an open project serializes autosaves and reports its saved/unsaved state. Atomic writes compare revision, SHA-256, mtime, and size, so an external edit offers reload, save-copy, explicit overwrite, or cancel instead of being silently replaced. Existing browser/PWA data can be restored from a `.bettertts-backup` and then saved as a project. Backup creation and restore share the same 512 MB archive/expanded-data ceiling, reject undeclared payloads, and restore queue metadata with its audio blobs atomically.

Packaged Windows inference fails closed if a native model pack is missing, modified, on an unpinned revision, or blocked by its license. Development builds may explicitly opt into the old mutable fallback with `BETTERTTS_DEV_ALLOW_UNVERIFIED_MODEL_FALLBACK=1`; packaged builds ignore that flag.

When FFmpeg is available on `PATH` (or through `BETTERTTS_FFMPEG_PATH`), the Windows app routes WAV, MP3, Ogg Opus, FLAC, and M4B exports through its native process boundary. Loudness presets use measured two-pass EBU R128 normalization at -19 LUFS mono or -16 LUFS stereo with a -1.5 dBTP ceiling; browser exports use the bounded client-side loudness estimate and limiter. Completed clips report the measured output LUFS and true peak when a preset is selected. Queue M4B exports include chapter metadata and optional JPEG/PNG cover art. Before processing, BetterTTS checks decoded duration/bytes, worst-case temporary space, and actual free disk; defaults are 24 hours and 4 GB and can be lowered with `BETTERTTS_MAX_EXPORT_DURATION_SECONDS` and `BETTERTTS_MAX_EXPORT_TEMP_BYTES`. If FFmpeg is absent, System diagnostics shows the exact `winget install Gyan.FFmpeg` recovery command while browser encoders remain available.

Piper-plus is a first-class lazy engine: its MIT runtime and multilingual Tsukuyomi-chan pack download only when selected, and Piper jobs use the same resumable queue, clip library, project, and native export paths as other local engines. On Windows, selecting the native backend routes English Piper through the pinned public-domain Cori Sherpa pack; other Piper languages continue to use the multilingual web runtime. The web/PWA build keeps Piper behind its explicit experimental toggle because the WASM/G2P payload is large.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 19 + TypeScript 6 |
| Build | Vite 8 |
| TTS Model | Kokoro 82M via `kokoro-js` 1.2.1 + Transformers.js 4.2.0; timestamped Kokoro via direct ONNX output; Supertonic via Transformers.js 4.2.0; KittenTTS via `kitten-tts-webgpu`; opt-in Chatterbox English/multilingual via Transformers.js 4.2.0; experimental Piper-plus via `piper-plus` 0.6.0 + ONNX Runtime Web; Windows native Kokoro/MeloTTS/Piper via `sherpa-onnx-node` 1.13.4; optional desktop Qwen3-TTS 0.6B via `qwen-tts` 0.1.1 + PyTorch sidecar |
| Caption runtime | Pinned whisper.cpp v1.9.1 Windows x64 CLI (MIT) with user-supplied multilingual GGML model weights |
| Sidecar runtime | Optional Windows-only Python 3.12 environment; `torch` and `qwen-tts` install into user data and model weights are downloaded on demand |
| RVC post-stage | Optional Windows-only Python 3.10 environment; `rvc-python` and user-selected `.pth`/`.index` files remain outside the installer |
| Narrator segmentation | Bounded local quote/speaker parser with per-queue-chunk role and voice metadata |
| Restricted-weight manager | Consent-gated local metadata registry plus Windows file/folder picker; no default downloads, copies, or activation |
| Local API | Opt-in loopback-only Electron server for OpenAI-compatible speech requests, native Kokoro/Piper output, and SSE audio chunks |
| Headless CLI | Plain Node `bettertts synth` entrypoint reusing the verified Sherpa host, bounded text/EPUB chunking, FFmpeg export, and SRT/VTT serializers |
| Native addon | `sherpa-onnx-win-x64` 1.13.4, Apache-2.0; unpacked from the unsigned Windows installer beside the Sherpa `.node` module and companion DLLs |
| MP3 Encoding | `@breezystack/lamejs` (LGPL-3.0, browser LAME) |
| M4B Export | WebCodecs AAC preflight + direct ISO BMFF writer with QuickTime/Nero chapter metadata |
| Pitch Shifting | `signalsmith-stretch` (MIT, AudioWorklet/WASM) |
| Phonemization | `phonemizer` for English + `ephone`/eSpeak NG WASM for multilingual Kokoro |
| Document Import | Worker-isolated `pdfjs-dist` for PDF text; `fflate` + `linkedom` for EPUB/DOCX |
| ZIP Packaging | `fflate` |
| Icons | `lucide-react` |
| Testing | Vitest (542 tests across 94 files) + Playwright smoke + EPUBCheck |
| Linting | oxlint |
| Hosting | GitHub Pages (static, no backend) |

## Architecture

`capabilities.json` is the canonical product fact source. `npm run capabilities:update` refreshes its test metrics and generated README/CLAUDE fact blocks; `npm run capabilities:check` rejects stale output.

```
src/
├── App.tsx                  # Public renderer entrypoint
├── AppShell.tsx             # Studio controller and current UI composition
├── App.css                  # Layout and component styles
├── index.css                # Design tokens, dark/light themes
├── main.tsx                 # React entry point + SW registration
├── components/
│   ├── MiniPlayer.tsx        # Document PiP transport and cue highlight surface
│   └── AudioOutputPicker.tsx # Capability-gated output sink selection
├── lib/
│   ├── generation-dispatcher.ts # Abort-aware sentence plans, cues, and progress
│   ├── object-urls.ts        # Output/caption blob URL ownership
│   ├── kokoro.ts            # Model loader, WebGPU probe, WASM fallback
│   ├── engine-registry.ts   # Engine capability flags and queue boundaries
│   ├── engine-adapter.ts    # Validated v1 engine manifests, adapters, and registry
│   ├── kokoro-assets.ts     # SHA-verified Pages q8 routing + HF fallback
│   ├── model-assets.json     # Immutable model revisions and asset digests
│   ├── kokoro-multilingual.ts # ephone + direct Kokoro model path for ja/cmn/es/fr/it/pt-BR/hi
│   ├── kokoro-timestamps.ts # Timestamped Kokoro loader, short-input pad/crop, and word cue alignment
│   ├── kokoro-worker.ts     # Web Worker client interface
│   ├── diagnostics.ts       # Local browser/capability/support export bundle
│   ├── capabilities.ts       # Canonical app, engine, export, queue, and license facts
│   ├── ui-locale.ts          # Reviewed UI-locale adapter; synthesis language remains engine-specific
│   ├── document-import.ts   # PDF/DOCX text extraction
│   ├── reader.ts             # Stable document coordinates, cue binding, and resume state
│   ├── media-overlays.ts     # EPUB3 text/SMIL/audio package writer and WAV→MP3 normalization
│   ├── epub-mapping.ts       # Immutable EPUB chapter edits and per-chapter voice/blend metadata
│   ├── sentence-retakes.ts   # Cue-boundary crossfade, resampling, and sentence text replacement
│   ├── queue-sentence-retakes.ts # Lazy queue retake generation and atomic splice orchestration
│   ├── playback.ts          # Read-along resume and sentence navigation
│   ├── playback-controller.ts # Shared audio registration, transport, cues, sinks, and Media Session
│   ├── audio-output.ts       # Audio Output Devices API capability and selection adapter
│   ├── listening-trainer.ts # Persisted opt-in playback-rate ramp schedule
│   ├── supertonic.ts        # Supertonic pipeline loader and voice metadata
│   ├── kitten.ts            # KittenTTS WebGPU wrapper, metadata, and WAV parser
│   ├── chatterbox.ts        # Consent-gated reference audio decode and worker client
│   ├── chatterbox-config.ts # Chatterbox model IDs, languages, limits, and controls
│   ├── voice-lab.ts         # Reference-voice consent, license gate, and clip provenance
│   ├── whisper.ts            # whisper.cpp JSON word-cue parser and audio bounds
│   ├── qwen.ts               # Optional desktop Qwen sidecar client and controls
│   ├── byo-models.ts         # Consent-gated user-supplied weight metadata and provenance
│   ├── rvc.ts                # Consent-gated RVC model metadata, blend plans, and provenance
│   ├── piper-plus.ts        # Experimental Piper-plus lazy wrapper and support diagnostics
│   ├── encode.ts            # WAV/MP3 encoding, sample-range cropping, pitch shift, BGM mixing
│   ├── m4b.ts               # WebCodecs AAC + M4B chapter muxing
│   ├── wav.ts               # Raw PCM → WAV encoder
│   ├── text.ts              # Sentence/pause/prosody parsing, cleanup, narrator segmentation
│   ├── voices.ts            # 41-voice Kokoro catalog with quality grades
│   ├── webspeech.ts         # Browser Speech API wrapper
│   ├── subtitles.ts         # SRT/VTT/ASS parser, serializers, fitting, and style presets
│   ├── queue.ts             # IndexedDB persistent generation queue
│   └── library.ts           # IndexedDB clip storage
├── hooks/
│   ├── useGeneration.ts      # Generation lifecycle state and cancellation refs
│   ├── useQueue.ts           # Queue state boundary
│   └── useLibrary.ts         # Library state boundary
├── worker/
│   ├── tts.worker.ts         # Off-thread Kokoro inference
│   └── chatterbox.worker.ts  # Off-thread Chatterbox inference and speaker cache
└── signalsmith-stretch.d.ts        # Type declarations
```

```
electron/
├── main.ts                   # Window, IPC, and isolated utility-process routing
├── cli.mjs                   # Headless TXT/EPUB synthesis and export entrypoint
├── cli-core.ts               # CLI parsing, bounded chunks, and caption timing
├── whisper-host.ts           # Isolated whisper.cpp subprocess and temp-file host
├── whisper-ipc.ts            # Bounded desktop caption IPC protocol
├── tts-host.ts               # Isolated Sherpa native inference host
├── sidecar-host.ts           # Isolated Python sidecar lifecycle and setup host
├── sidecar-ipc.ts            # Bounded Qwen sidecar protocol and model metadata
├── rvc-host.ts               # Isolated optional RVC Python adapter host
├── rvc-ipc.ts                # Bounded RVC conversion and weight-picker protocol
├── openai-server.ts          # Opt-in loopback OpenAI-compatible speech server
├── openai-ipc.ts             # Bounded local API lifecycle requests
└── byo-ipc.ts                # Validated desktop local-weight selection request
```

```
sidecar/
├── bettertts_sidecar.py      # JSON-lines supervisor and disposable inference worker
├── requirements-qwen.txt     # Optional post-install torch/qwen-tts requirements
├── bettertts_rvc.py          # JSON-lines RVC adapter for user-managed models
├── requirements-rvc.txt      # Optional rvc-python runtime requirement
└── test_sidecar.py           # Protocol, bounds, cancellation, and test-mode coverage
```

**Key design decisions:**
- WASM q8 model files (~107 MB including tokenizer and 28 voice bins) are synced from immutable Hugging Face revisions with SHA-256 verification, load from the GitHub Pages site first, and fall back to the same verified revision with 429-aware retry; offline prefetch re-verifies cached responses
- Word-level SRT/VTT is opt-in and uses the HF-hosted `Kokoro-82M-v1.0-ONNX-timestamped` q8 graph plus duration-output alignment
- Desktop imported-audio word-level SRT/VTT uses whisper.cpp `-ml 1 -sow` forced alignment; the CLI is pinned and bundled by the Windows build, while `ggml-base.bin` remains a user-managed multilingual model
- Qwen3-TTS stays outside the browser bundle: Electron owns a private Python environment, the sidecar accepts bounded JSON-lines messages without opening a listener, and each synthesis runs in a disposable worker so cancellation or a crash cannot take down the desktop shell
- Restricted/non-commercial weights are a metadata-only BYO tier: model options stay hidden until consent, the desktop picker returns an existing file/folder without copying it, license and provenance are required, and no remote URL is ever fetched by the manager
- The local OpenAI-compatible server is an explicit desktop opt-in, binds only to `127.0.0.1`, bounds request/input/audio surfaces, supports raw encoded output plus SSE base64 chunks, and owns a stop path that closes the listener and active sockets
- RVC is an explicit desktop-only post-stage: consent and model provenance are required, model paths are user-managed, optional blending performs two bounded inference passes, and converted clips retain the selected model metadata
- New engines enter through the v1 adapter SDK: a local manifest declares immutable model files, runtime/license/safety metadata, hardware needs, queue/export capabilities, and required diagnostics fields before an adapter can be registered
- Narrator mode is a bounded text transformation before synthesis: quoted and explicit-speaker segments receive per-chunk role/voice metadata, plain text remains narration, and queue/M4B exports consume the persisted rendered chunks
- All audio generation and processing happens client-side — zero network calls after model download
- Web Worker isolates WASM/WebGPU inference from the main thread
- Service worker injects COOP/COEP headers to enable SharedArrayBuffer for threaded WASM on GitHub Pages

To benchmark a local candidate, run `node scripts/model-eval.mjs --manifest candidate.json --output report.json`. The manifest supplies the candidate's provider, runtime, permissive-license declaration, model-file sizes/digests, and a non-shell command; the command accepts JSON-lines `synthesize` requests and returns duration/sample-rate plus optional memory/VRAM metrics. Reports cover four fixed prompts and never promote a candidate into the default engine registry automatically.

## Deploy to GitHub Pages

This project does not use GitHub Actions. Build and publish locally:

```bash
npm run deploy
```

The deploy script builds `dist/`, syncs the Pages-hosted Kokoro q8 model assets and experimental Piper-plus Tsukuyomi-chan assets into `dist/models/`, emits `bettertts-sbom.cdx.json` as a validated CycloneDX 1.7 software/model inventory, and force-pushes it to the `gh-pages` branch from a disposable git worktree, so your working tree is never modified. Publishing requires a clean checkout plus an annotated `v<version>` tag at the exact source commit, and the deployed `release.json` records that commit for rollback/debugging. Diagnostics links to this same-origin SBOM on Pages. Then in repository settings: **Pages** -> Source: `gh-pages` branch, folder: `/`.

To rebuild and publish the unsigned Windows update, run `npm run deploy:updates`. The command verifies the installer checksum, validates the release SBOM, refuses to upload into an existing release associated with another source commit, uploads the installer, blockmap, and `BetterTTS-<version>.cdx.json` SBOM to the versioned GitHub Release, and publishes source-stamped `latest.yml` under the static `/updates/` feed. Desktop diagnostics links to that immutable versioned SBOM asset. This split keeps the 200+ MB binary outside GitHub Pages' 100 MB per-file limit.

## Voice Catalog

54 Kokoro voices spanning American English, British English, Japanese, Mandarin Chinese, Spanish, French, Hindi, Italian, and Brazilian Portuguese. English voices keep the detailed quality grades from Kokoro's VOICES metadata:

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
| Japanese | Alpha, Gongitsune, Nezumi, Tebukuro, Kumo |
| Mandarin Chinese | Xiaobei, Xiaoni, Xiaoxiao, Xiaoyi, Yunjian, Yunxi, Yunxia, Yunyang |
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
| WebGPU dtype | fp32 default (~326 MB, HF-hosted); fp16 experimental opt-in |
| WASM dtype | q8 (~92 MB, Pages-hosted) |
| Languages | English (US + British), Japanese, Mandarin Chinese, Spanish, French, Hindi, Italian, Brazilian Portuguese |
| License | Apache-2.0 |

The WebGPU fp16 switch is available under **Voice chain -> Advanced options -> WebGPU fp16 (experimental)**. It is persisted per browser, resets the active Kokoro session when changed, and automatically falls back to WASM q8 if WebGPU model loading fails.

### WebGPU dtype benchmark (2026-08-03)

| Browser / adapter | fp32 | fp16 | Notes |
|---|---|---|---|
| Chrome 151.0.7922.72 / NVIDIA Lovelace | PASS — RIFF/WAV, 150,044 bytes, 3.125 s | PASS — RIFF/WAV, 148,844 bytes, 3.100 s | Headed WebGPU run on the isolated virtual display; no page, inference, request, or media errors |
| Firefox 137.0.1 | N/A | N/A | Installed Firefox reports no `navigator.gpu`; Firefox 141 is not installed on this Windows host |
| Safari 26 | N/A | N/A | Safari is unavailable on this Windows host |

fp32 remains the default because only the Chrome adapter was available for an artifact-free WebGPU A/B run; the fp16 opt-in and CPU fallback remain available for broader adapter coverage.

Supertonic is available as a separate English speed engine: 66M parameters, 10 voices, 44,100 Hz output, HF-hosted fp32 ONNX assets, OpenRAIL license, and Transformers.js 4.2.0 runtime.

KittenTTS is available as a separate English lightweight engine: Nano 15M / 24 MB by default, Micro 40M / 41 MB, Mini 80M / 78 MB, 8 voices, 24,000 Hz output, WebGPU-only shader inference, MIT package code, and Apache-2.0 model weights. The package is lazy-loaded and model weights stay HF-hosted until the engine is selected.

Piper-plus is available behind **Enable experimental Piper-plus** under Voice chain -> Engine -> System & diagnostics: `piper-plus` 0.6.0, Tsukuyomi-chan (`ayousanz/piper-plus-tsukuyomi-chan`), 22,050 Hz output, JA/EN/ZH/KO/ES/FR/PT/SV language targets, MIT package/runtime path, and ONNX Runtime Web. Piper package code, the multilingual WASM G2P, ONNX Runtime, and the model are lazy-loaded only after the flag is enabled and Piper-plus is selected; the browser fallback uses an immutable revision, while deployment sync verifies the model and config digests. On Windows, the native backend's English path uses `sherpa-onnx-node` with the pinned en-GB Cori model; non-English native selections remain on Piper-plus web. Deployed builds prefer the same-origin `dist/models/ayousanz/piper-plus-tsukuyomi-chan/` copy; local builds fall back to the same immutable Hugging Face revision when that asset has not been synced.

MeloTTS is available as a Windows desktop-only native engine: the pinned MIT `myshell-ai/MeloTTS-Chinese` Chinese + English VITS archive is verified by SHA-256 and loaded through Sherpa-ONNX at 44,100 Hz. It exposes one default speaker, chooses the language from the input text, participates in the resumable queue and local OpenAI-compatible API, and remains hidden in web/PWA builds. The exact archive and model revision are recorded in diagnostics after first use.

Qwen3-TTS 0.6B CustomVoice is an optional Windows-only desktop engine using the Apache-2.0 `qwen-tts` package and Qwen3-TTS model. It supports the published multilingual language set, named speakers, and style instructions through the private sidecar. The installer contains only the sidecar source and requirements; Python packages and model weights remain user-managed downloads in the desktop user-data folder.

Word timestamps are available as an opt-in Kokoro mode using `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped`; the extra q8 model stays HF-hosted and powers word-level SRT/VTT plus follow-along highlighting.

## Runtime Licenses

BetterTTS application code is MIT. Runtime dependencies and model paths carry their own licenses:

| Component | License | Used for |
|---|---|---|
| BetterTTS app code | MIT | App shell, UI, queue, exports |
| `kokoro-js`, Kokoro ONNX, Transformers.js, `phonemizer` | Apache-2.0 | Kokoro, timestamps, English phonemization |
| `ephone` / eSpeak NG WASM | GPL-3.0-or-later | Loaded only for multilingual Kokoro voices: Japanese, Mandarin Chinese, Spanish, French, Hindi, Italian, Brazilian Portuguese |
| `electron-updater` | MIT | Opt-in Windows update download and restart install |
| `kitten-tts-webgpu` | MIT | KittenTTS browser runtime; Kitten model weights are Apache-2.0 |
| `piper-plus`, `@piper-plus/g2p`, `onnxruntime-web` | MIT | Experimental Piper-plus engine; Tsukuyomi-chan model assets load on demand |
| `sherpa-onnx-node`, `sherpa-onnx-win-x64` | Apache-2.0 | Windows native Kokoro, MeloTTS, and Piper CPU utility-process runtime |
| whisper.cpp Windows CLI and GGML model path | MIT | Optional desktop imported-audio word alignment; runtime is bundled, model weights are user-managed |
| `qwen-tts`, Qwen3-TTS 0.6B model | Apache-2.0 | Optional Windows desktop sidecar; Python packages and model weights are user-managed and never bundled |
| `rvc-python` | MIT | Optional Windows desktop RVC post-stage; package and model weights are user-managed and installed only after explicit setup |
| User-supplied restricted/non-commercial weights | User-recorded terms | Consent-gated metadata registry only; BetterTTS does not download, copy, or activate these files by default |
| Sherpa Kokoro int8 archive | Apache-2.0 | Pinned multilingual Kokoro model pack, downloaded on first native Kokoro load |
| Sherpa Piper Cori archive | Public domain training data | Pinned English Cori model pack, downloaded on first native English Piper load |
| Sherpa MeloTTS archive | MIT | Pinned Chinese + English VITS model pack, downloaded on first native MeloTTS load |
| Supertonic ONNX model | OpenRAIL | HF-hosted English speed engine |
| `@breezystack/lamejs` | LGPL-3.0 | MP3 export |
| `pdfjs-dist` | Apache-2.0 | Local PDF text extraction |
| `signalsmith-stretch`, `fflate` | MIT | Pitch shift and ZIP/EPUB/DOCX parsing |
| `linkedom` | ISC | Worker-safe EPUB/DOCX document parsing |
| `lucide-react` | ISC | Interface icons |

Review runtime package licenses locally with:

```bash
npm run license:runtime
```

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

[MIT](LICENSE) for BetterTTS application code. See Runtime Licenses above for dependency/model paths.

---

Built with [Kokoro](https://github.com/hexgrad/kokoro) and [Transformers.js](https://github.com/huggingface/transformers.js).
