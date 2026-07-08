# Changelog

## v0.7.0 - 2026-07-08

### Features
- Web Worker for off-main-thread Kokoro inference — UI stays responsive during generation (TF-20).
- Pitch control (±4 semitones) via SoundTouch.js post-processing without tempo change (TF-32).
- Background-music bed mixing — upload audio, loop to speech length, mix at configurable volume (TF-34).

## v0.5.0 - 2026-07-08

### Features
- Streaming playback: audio plays as each sentence generates via Web Audio scheduling (TF-14).
- MP3 export with bitrate picker (128/192/320 kbps) via browser-side LAME.js encoder (TF-15).
- Installable offline PWA: 192px/512px PNG icons, service worker for app-shell caching, og/twitter meta tags, apple-touch-icon (TF-19).
- Media Session lock-screen controls, Web Share for audio files, showSaveFilePicker for native save dialog (TF-27).
- Pronunciation overrides dictionary persisted in localStorage — word/replacement pairs applied before generation (TF-33).
- COOP/COEP header injection via SW for SharedArrayBuffer threaded WASM on GitHub Pages (TF-28).

## v0.4.0 - 2026-07-08

### Features
- Generation stats: elapsed time, chars/s throughput, audio duration, realtime factor (TF-27 partial).
- Persistent clip library backed by IndexedDB — clips survive reloads with re-download and delete controls (TF-17).

## v0.3.0 - 2026-07-08

### Features
- Per-voice preview button with session-cached audio (TF-16).
- Browser-voice picker for Web Speech engine — all system voices selectable (TF-18).
- SRT/VTT subtitle export from sentence-level timing data (TF-23).
- Dialog mode with `[speaker:Name]` line prefixes mapped to voices via settings panel (TF-21).

### Tests
- 39 test assertions across 3 suites (wav, text, subtitles).

## v0.2.0 - 2026-07-08

### Correctness
- Sentence-chunk Kokoro generation to prevent silent truncation at the 510 phoneme token limit (TF-01).
- Real WebGPU adapter probe with automatic WASM fallback; clear poisoned model promise on failure (TF-02).
- Mount ErrorBoundary above App in main.tsx; guard all localStorage access for blocked-storage environments (TF-03).
- Replace fake `[pause]` text insertion with real silence splicing — `[pause Xs]` tags produce actual zero-sample gaps (TF-04).
- Web Speech reliability: async voice loading with voiceschanged, chunked utterances, 20s watchdog, interrupted/canceled handling (TF-05).

### Features
- Honest 5000-char limit UX with over-count indicator, import truncation warning, and generate-time drop notice (TF-06).
- Cancel button during generation; previous output preserved until first successful chunk of new run (TF-07).
- Accurate model-download progress with monotonic MB counter; "Model cached" badge on engine card (TF-09).

### UX / Accessibility
- Default voice changed to Heart (grade A) from Adam (grade F+) (TF-08).
- Spinner animation fixed for lucide-react 1.23+ class rename; toast/progress timer cleanup (TF-08).
- Respect prefers-color-scheme for initial theme when no saved preference exists (TF-11).
- ARIA progressbar with valuenow/min/max; error toasts use role=alert; audio elements labeled; light theme contrast bumped to AA (TF-10).

### Architecture
- Split App.tsx into lib modules: wav.ts, text.ts, kokoro.ts, webspeech.ts, voices.ts (TF-13).
- Typed VoiceId union replaces `as never` cast on voice parameter.
- Vitest harness with 24 assertions across WAV encoding, text chunking, pause parsing, and slug generation (TF-12).

## v0.1.0 - 2026-07-08

- Initial TTS4FREE static React app.
- Added in-browser Kokoro 82M generation through `kokoro-js`.
- Added Web Speech playback fallback, WAV downloads, per-line generation, ZIP export, themes, and GitHub Pages build configuration.
