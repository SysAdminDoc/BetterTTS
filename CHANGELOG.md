# Changelog

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
