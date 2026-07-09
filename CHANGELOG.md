# Changelog

## Unreleased

### Added
- Added an offline pack manager in the control console with per-engine cache status, app-shell separation, Kokoro q8 prefetch, and selective cache clearing.
- Added README and in-app runtime license disclosure, including the GPL-3.0-or-later ephone/eSpeak multilingual path and a local runtime license check command.
- Added M4B/WebCodecs AAC capability preflight, browser-specific unsupported messages, and a chaptered ZIP fallback manifest for queue exports.
- Added a diagnostics export panel that copies/downloads a sanitized local support bundle with browser, WebGPU, codec, storage, cache, model-route, and recent warning/error state.
- Added `npm run smoke`, a local Playwright production-build smoke check for desktop/mobile rendering, theme switching, diagnostics copy, queue controls, M4B fallback messaging, screenshots, and unexpected console-noise regression.

### Changed
- Split EPUB parsing and multilingual Kokoro runtime paths into on-demand chunks; the production worker bundle now stays small on first load and the fflate static/dynamic import warning is gone.
- Migrated persistent queue jobs to an engine-aware schema so Kokoro, Supertonic, and KittenTTS jobs preserve their voice/model/settings and v1 Kokoro jobs migrate on read.

## v0.12.0 - 2026-07-09

### Changed
- Reworked the main studio into a premium workstation interface with compact top chrome, runtime status, editor toolbar, output deck tabs, persistent queue/library empty states, inspector-style engine controls, a clearer generation module, and a bottom system rail.
- Refined dark and light theme tokens, table surfaces, empty states, mobile toolbar collapse, toast placement, and responsive queue/library layout for a more consistent professional product feel.

### Fixed
- Added an explicit captions track fallback for generated audio elements so local lint is clean and result playback keeps an accessibility-compatible media structure.

## v0.11.0 - 2026-07-09

### Added
- Migrated the shared `@huggingface/transformers` runtime to 4.2.0 with a root npm override so `kokoro-js`, Supertonic, timestamped Kokoro, and direct tensor paths all resolve to v4; Kokoro WASM q8 and WebGPU fp32 generation were verified in-browser (TF-31).
- Added KittenTTS as a lazy-loaded English WebGPU engine via `kitten-tts-webgpu`, with 8 voices, Nano/Micro/Mini model selection, 0.5x-2.0x speed controls, WAV/MP3/Opus export through the existing pipeline, focused metadata/WAV parser tests, and desktop/mobile browser QA (TF-29).
- Added Kokoro multilingual generation for Spanish, French, Hindi, Italian, and Brazilian Portuguese voices via `ephone`/eSpeak NG phonemization and the direct Kokoro model path; English generation remains on the existing `tts.generate()` path (TF-25).
- Added chaptered M4B audiobook export for completed queue jobs, with WebCodecs AAC encoding, QuickTime `tref/chap` text-track chapters, Nero `chpl` chapter metadata, EPUB TOC title preservation, and focused muxer tests (TF-74).
- Added opt-in word-level Kokoro timestamps via the timestamped q8 ONNX graph, with word-level SRT/VTT and follow-along cues plus browser QA (TF-26).
- Added Supertonic as a lazy-loaded English fp32 speed engine via Transformers.js, with 10 F/M voices, 44.1 kHz exports, engine-aware speed/step controls, and built-preview browser QA (TF-37 revised).

### Changed
- Updated download progress handling to prefer Transformers.js v4 aggregate `progress_total` byte totals while retaining per-file progress fallback.
- Added same-origin-first Kokoro q8 model and voice asset loading for GitHub Pages, with Hugging Face fallback and 429-aware retry; deploy now syncs the 92 MB q8 ONNX, tokenizer/config, and 28 English voice bins into `dist/models` (TF-68).
- Replaced the SoundTouch.js pitch-shift path with Signalsmith Stretch AudioWorklet/WASM offline rendering; +/-4 semitone exports keep exact length and a non-zero tail in Chromium browser QA (TF-70).

### Tests
- 91 -> 114 assertions across 15 suites, adding coverage for M4B muxing, Kokoro timestamps, multilingual Kokoro, KittenTTS metadata/WAV parsing, and Transformers.js v4 ModelRegistry APIs.

## v0.10.0 - 2026-07-08

### Features
- **Voice blending** — weighted mix of 2-4 Kokoro voices via custom style tensors; blend editor with per-voice weight sliders in the Advanced section (TF-22).
- **Opus/WebM export** — via WebCodecs AudioEncoder with a hand-crafted minimal Matroska muxer; capability-detected and hidden when unsupported (TF-73).
- **Persistent job queue** — queue text for batch generation with IndexedDB checkpointing; pause, resume, and ZIP download survive tab close and page reloads (TF-76).
- **EPUB import** — chapter-aware parsing via fflate with NCX/EPUB3-nav TOC title extraction; chapters are queued for batch generation; empty chapters are reported (TF-24).

### Tests
- 87 → 91 assertions across 8 suites (voice-mix, queue, and EPUB parser modules added).

## v0.9.0 - 2026-07-08

### Fixed
- Per-result save button was dead on every Chromium browser (broken `showSaveFilePicker` cast invoked `window` as a function).
- Unpunctuated text over ~300 characters was silently truncated by the tokenizer's 512-token cap — long pastes now hard-split on comma/word boundaries.
- Worker crash during model load or "Reset session" mid-generation soft-locked the app; all pending promises now reject and the worker restarts lazily.
- Streamed playback leaked one AudioContext per run (Safari fails after ~4-6); contexts now close after playback, immediately on cancel.
- Cancel now actually stops sound: scheduled audio halts, Web Speech aborts via `speechSynthesis.cancel()`, cancelled dialog runs no longer report success, and cancelling during the model download acknowledges immediately.
- SRT/VTT downloads were misnamed `.mp3` for MP3 output; subtitle URLs were re-minted on every keystroke.
- MP3 bitrate picker offered 192/320 kbps that silently encoded at 160 (MPEG-2 ceiling at 24 kHz) — options are now honest 96/128/160.
- Pitch-shifted exports clipped the final ~100 ms (SoundTouch latency now flushed); subtitle timestamps could emit invalid `,1000` millisecond fields; blank lines inside cues corrupted SRT blocks.
- Pronunciation rules no longer cascade into each other or corrupt substrings ("cat" → "kat" no longer hits "catalog").
- Stereo background music kept only the left channel; zero-length BGM produced silent NaN exports.
- Voice-preview blob URLs and duration probes could leak or hang; IndexedDB now uses one memoized connection with upgrade handlers.
- Double-clicking Generate interleaved two runs; preview during generate bricked the preview buttons; the worker reloaded the model on every click.

### Added
- **Follow-along transcript** — click-to-seek sentence highlighting synced to playback, with a native caption track on every result.
- **Article import by URL** — Readability extraction in-browser, plus Android PWA share-target support.
- **Text cleanup pipeline** — skip `[12]`-style citations, read URLs as "link", letter-space vowel-less acronyms (SQL → S Q L), strip markdown syntax; each rule toggleable.
- **CPU mode switch** — persistent WASM fallback for GPUs with corrupted WebGPU output, plus automatic WASM retry when WebGPU session init fails.
- **Storage management** — persistent-storage request, usage meter on the engine card, 200 MB clip-library cap with oldest-first eviction, quota-full toasts.
- **Update flow** — per-build service-worker cache versioning, old-cache pruning, "new version ready" toast, first-visit reload loop guard.
- Content-Security-Policy baked into production builds; PWA manifest `id`/`scope`; COEP `credentialless` on Chromium for CDN resilience; zero-flash theme boot; absolute social-card URLs.
- `npm run deploy` — worktree-based gh-pages publish that can never touch (or delete) working-tree files.

### Changed
- `generateKokoro`/`generateDialog` unified into one synthesis loop — dialog mode gains streaming playback, download progress, generation stats, library saves, and indexed collision-free filenames.
- ZIP export switched from jszip to fflate (smaller, maintained, store-level for audio).
- Strict TypeScript enabled repo-wide (tests now typechecked); lint broadened with react-hooks and jsx-a11y plugins.
- Tests: 39 → 70 assertions across 5 suites (encode and library modules now covered).

## v0.8.0 - 2026-07-08

### UI Polish
- System-level interaction states: hover, focus-visible, active/pressed on all buttons, selects, engine cards, voice previews, and result rows.
- Accessible focus ring (box-shadow) on editor textarea, replacing stripped outline.
- Toast entrance animation (fade + slide up).
- Generate button: hover glow, active press feedback, text-shadow for depth.
- Settings panel: visual section dividers between voice, controls, and options groups.
- Empty output state: centered layout with icon and guidance subtext.
- Gen stats: monospace display in surface-2 background pill.
- Progress bar: slimmer 6px track with rounded inner fill.
- Brand mark: subtle scale on hover.
- Heading-action buttons: larger touch targets (28px), hover accent.
- Fatal error screen: centered design with colored icon and styled CTA.
- Result rows: hover border accent.
- ZIP download: success-tinted border treatment.
- Footer: top border for visual closure.
- Technical note: full-width integrated band with tinted background.

### Microcopy
- Starter text rewritten as welcoming first-run guidance.
- Privacy note: "100% private — your text and audio never leave this browser."
- Technical note: renamed "How it works" with user-facing model size info.
- Error boundary: "Something went wrong" with helpful reload button.

### Accessibility
- Editor textarea focus-visible ring via parent :has() selector.
- Pronunciation inputs: proper CSS classes with focus-visible rings and aria-labels.
- Select dropdowns: hover and focus-visible states with accent ring.
- All inline styles on pronunciation panel replaced with CSS classes.

### Mobile
- Voice buttons: 2-column grid at narrow widths (was 1-column).
- Technical note: stacks gracefully at mobile breakpoint.

### Housekeeping
- Added 2 voices (Aoede, Sky) to complete the kokoro-js English catalog (28 total).
- Project renamed from TTS4FREE to BetterTTS.
- New design tokens: --shadow-sm, --ring (both themes).

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

- Initial static React app (originally named TTS4FREE).
- Added in-browser Kokoro 82M generation through `kokoro-js`.
- Added Web Speech playback fallback, WAV downloads, per-line generation, ZIP export, themes, and GitHub Pages build configuration.
