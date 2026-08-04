# Changelog

## v0.22.0 - 2026-07-29

### Security
- Hardened untrusted desktop and archive boundaries: native inference IPC now validates every renderer message, `app://` navigation no longer serves the shell for missing script/model assets, and portable backups reject duplicate, dangling, inconsistent, or excessive records before replacing local data.
- Document imports now reject empty, invalid-size, and oversized PDF/DOCX/EPUB files before allocating their contents; background audio receives the same empty/invalid-size preflight.
- Release publishing now requires synchronized version metadata, a clean source checkout, and an annotated tag at the exact commit being built. Pages and the static Windows update feed expose that source SHA, while existing GitHub Releases reject binaries from a different source commit; failed live verification now preserves disposable-worktree cleanup.

### Changed
- Reimagined the studio around a calmer editorial script canvas, a prominent render monitor, and a numbered Engine → Voice → Delivery → Output chain. The primary format control is now visible without opening Advanced options, while dark, light, desktop, and mobile layouts share the same flatter signal-focused visual system.
- The render monitor transport now selects generated clips, renders a bounded decoded peak envelope with progress, plays/pauses/seeks, navigates sentence cues, reports elapsed/total time, and explains unavailable actions instead of presenting decorative controls. Result, library, and queue audio share one playback controller and Media Session state.
- Playback resume writes are now throttled to one-second progress intervals while pause/seek state remains immediate. In-memory voice previews and decoded voice bins use bounded least-recently-used caches with object-URL disposal.
- Windows native inference now uses the Apache-2.0 `sherpa-onnx-node` 1.13.4 utility-process runtime. Kokoro int8 and English Piper Cori archives are pinned, resumable, SHA-256 verified, traversal-checked, and extracted atomically; diagnostics expose the active engine, native addon, sample rate, and pack provenance. English Piper uses Sherpa only when the desktop native backend is selected; the browser path is unchanged.
- Added the native MeloTTS Chinese + English engine for Windows. Its MIT Sherpa VITS archive is pinned to an immutable model revision and exact SHA-256, loads lazily at 44.1 kHz, participates in queue/export/OpenAI-compatible API flows, and is hidden from web/PWA builds.
- Expanded the Kokoro catalog to all 54 official v1.0 voice IDs, including Japanese and Mandarin Chinese. Those new languages use lazy `jpx`/`sit` ephone packs through the existing direct browser synthesis path, while native Sherpa remains the fast English route.
- Added an explicit opt-in Chatterbox voice lab. English and 23-language multilingual ONNX variants run in a dedicated lazy worker, accept a bounded in-memory reference clip, reuse its speaker embedding across sentences, expose the emotion exaggeration control, prefer WebGPU with a visible CPU-slow fallback, and disclose the model's retained PerTh watermark. Chatterbox remains direct-only and never enters the persistent queue.
- Added desktop imported-audio captioning through a pinned whisper.cpp v1.9.1 Windows x64 runtime. The isolated host converts bounded audio to temporary 16 kHz mono WAV, creates multilingual word cues with `-ml 1 -sow`, exposes synchronized playback, and downloads SRT/VTT; missing runtime/model recovery is explicit and model weights stay user-managed.
- Added an optional Windows-only Qwen3-TTS 0.6B CustomVoice engine through an isolated Python sidecar. The desktop UI can provision a private Python 3.12 environment, then lazily download `torch`, `qwen-tts`, and model weights into user data; sidecar setup, progress, cancellation, and crash recovery stay on the same bounded desktop bridge while web/PWA mode remains unchanged.
- Added a consent-gated Windows bring-your-own-weights tier for restricted/non-commercial model families. Users can register an existing file or directory only after recording its exact license and provenance; the manager stores metadata and the selected path, performs no downloads or copies, and keeps these entries hidden/adapter-gated until explicitly enabled.
- Added an opt-in loopback-only OpenAI-compatible desktop TTS server. `POST /v1/audio/speech` supports native Kokoro/Piper model and voice selection, WAV/MP3/Opus/FLAC output, bounded SSE base64 chunks, `/health` and `/v1/models`, an explicit port control, and a stop path that closes the listener.
- Added an opt-in Windows-only RVC post-stage. Users can register consented local `.pth`/`.index` models with license and provenance, re-timbre a generated clip after TTS, optionally blend a second model through a bounded second inference pass, and retain the conversion metadata on the saved clip; the optional Python runtime is never bundled.
- Added narrator mode for long-form scripts. Quote-aware and explicit-speaker parsing separates narration from dialogue, per-role voices persist on queue chunks, ZIP manifests retain the assignments, and chaptered M4B export uses the rendered role-specific audio.
- Added a headless `bettertts synth` CLI that reuses the verified native Sherpa host for TXT/EPUB conversion, bounded chunking, WAV/MP3/Opus/FLAC/M4B export, SRT/VTT captions, JSON progress, dry runs, and scriptable exit codes without launching Electron.
- Added opt-in Windows desktop workflow integrations: a clipboard-based global read-selection hotkey, per-user Explorer context-menu entries that queue TXT/EPUB/PDF/DOCX files, and optional Tesseract screen OCR. Each integration is independently disableable and the web/PWA bridge remains absent.
- Added an opt-in Windows desktop Studio cleanup toggle. Native FFmpeg applies `afftdn` denoise plus conservative room-tail reduction after generation/imported-BGM mixing, retains a before-cleanup playback path for the session, and adds no model or installer dependency.
- Added Reader mode for imported EPUBs, articles, PDFs, DOCX files, and text. The chapter-aware book view binds sentence and optional word cues to stable content IDs, supports paragraph-to-playback jumps, per-document local resume, and an optional line-focus presentation without relying on rendered layout coordinates.
- Added EPUB3 Media Overlay export for completed EPUB queue jobs. The writer packages stable text IDs, SMIL sentence/word timing, per-overlay duration metadata, active highlight CSS, and EPUB-compatible audio; WAV queue audio is transcoded to MP3 before packaging.
- Added a staged EPUB chapter-mapping review before queueing. Users can rename, split, merge, reorder, or exclude chapters, assign supported per-chapter voices, and configure weighted Kokoro blends; the persisted mapping flows through resumable synthesis, ZIP manifests, M4B chapters, and EPUB media-overlay exports. The lazy review surface keeps the initial shell within its performance budget, and “Queue with defaults” preserves the one-click import path.

### Fixed
- Persisted queue jobs now recover bounded engine settings, formats, timestamps, chunk indexes, and subtitle cues instead of propagating malformed values after restart.
- Browser speech now surfaces stalled or synchronously failed playback instead of silently skipping text, clears voice-discovery timers promptly, and document workers terminate on transfer or message-decoding failures.
- Portable backup creation records the actual clip blob size, tolerates blocked settings reads, restores data before settings, and attempts every settings write before reporting storage rejection.
- Starting a new script is now recoverable with Undo, while file/article imports block conflicting generation and queue actions. Article fetches can be cancelled explicitly without replacing the current script or being misreported as timeouts.
- Malformed persisted cleanup and pronunciation JSON now falls back safely instead of crashing startup or injecting invalid setting types. Pronunciation entries and field lengths are bounded before regular-expression construction.
- Toast notifications now have a keyboard-accessible dismiss action in addition to their automatic timeout.
- Media Session handlers now follow the active connected audio element, report playback state, and release stale handlers during teardown.
- Legacy clip and queue records are shape-checked and bounded before sorting, rendering, synthesis, or caption playback; malformed metadata no longer reaches React as arbitrary objects.
- The 390 px workspace rail now allows all six destinations to shrink within the viewport instead of clipping Diagnostics and Docs off-canvas.
- Packaged `--smoke` runs now write captures beside the explicit report or into the system temporary directory instead of attempting to write inside read-only `app.asar`.

### Tests
- Added regression coverage for malformed backups and queue records, oversized document imports, worker transfer failures, stalled Web Speech playback, invalid background audio, desktop protocol routing, and native inference IPC validation.
- Browser smoke now verifies recoverable script clearing and cancellable article import, and real-engine smoke exercises the monitor transport. Persisted editor-setting parsers have malformed, type, and size-boundary coverage.
- Added bounded-cache eviction/disposal, playback-write throttling, and malformed IndexedDB clip/queue migration regressions.
- Added packaged/development/report-path coverage for Electron smoke artifact routing.
- Added Sherpa pack validation, immutable archive metadata, native engine IPC routing, and real Windows x64 host probes for Kokoro and Piper synthesis.
- Added Chatterbox language/model selection, reference-clip bounds, prompt-prefix, resampling, cache classification, consent visibility, and non-queueable engine coverage.
- Added whisper.cpp JSON word-cue, timestamp, language, resampling, runtime-guidance, and bounded IPC coverage, plus Electron smoke status for the caption host.
- Added Qwen sidecar IPC/client coverage and Python protocol tests for bounds, deterministic test-mode audio, cancellation, progress, and status recovery.
- Added BYO metadata schema, consent/visibility, provenance bounds, desktop picker IPC, and web-bridge isolation coverage.
- Added OpenAI-compatible request/IPC validation, raw audio and SSE endpoint tests, loopback binding, health/model discovery, and listener shutdown coverage.
- Added RVC model metadata, consent, blend/provenance, conversion IPC/client, Python adapter protocol, missing-runtime/model recovery, and web-bridge isolation coverage.
- Added narrator quote/speaker parsing, unmatched-quote fallback, queue role/voice migration, metadata preservation during regeneration, and packaged Narrator mode UI smoke coverage.
- Added CLI argument/chunk/caption core coverage plus real native WAV/caption and FFmpeg M4B conversion probes.
- Added desktop integration contract coverage for opt-in defaults, persisted-setting sanitization, supported external-file routing, MIME mapping, Explorer command construction, packaged UI controls, and disabled-by-default smoke behavior.
- Added Reader document-coordinate, sentence/word cue-binding, resume-persistence, queue source-identity, and browser smoke coverage for EPUB launch, chapter navigation, paragraph interaction, and line focus (419 tests across 71 files).
- Added EPUB3 Media Overlay package tests, legacy cue fallback coverage, queue source-kind migration coverage, and smoke/EPUBCheck validation of the downloaded package.
- Added immutable EPUB mapping tests for chapter edits and per-chapter blend editing, bounded queue blend migration coverage, and browser smoke assertions for the staged review, split action, voice controls, and defaults-preserving queue path (424 tests across 72 files).
- Added FFmpeg cleanup filter contract coverage, native denoise/Studio/loudness probes, cleanup UI smoke assertions, and the packaged output before/after audit path.
- Added MeloTTS model-pack validation, IPC/queue migration coverage, a real native Chinese + English host probe, packaged UI assertions for Melo and the new Kokoro languages, and headless real-engine synthesis checks for Japanese and Mandarin.

## v0.21.0 - 2026-07-29

### Security
- Native desktop inference now re-hashes every installed model file before creating an ONNX session, validates immutable revisions and safe manifest paths, and fails closed on integrity or license errors. Missing/offline packs are reported separately; mutable model fallback is development-only and is disabled in packaged builds.
- ZIP-backed backups, EPUBs, and DOCX files now enforce format-specific compressed, expanded, entry-count, and compression-ratio budgets before extraction. EPUB import inflates only referenced reading-order assets, rejects excessive chapter/text/chunk counts without silent truncation, and backup restore commits each queue job with its audio blobs in one transaction.

## v0.20.0 - 2026-07-25

### Security
- Patched the production Transformers/ONNX dependency graph to adm-zip 0.6.0 and sharp 0.35.0, and added runtime plus packaged-asar security gates with expiring, owner-labelled exception support.
- Added crafted DOCX and EPUB archive regressions proving declared multi-gigabyte expansions are rejected before fflate inflates user-controlled entries.

### Added
- Added versioned portable browser backups for clip audio, generation queues, and local settings. Backups are checksum-validated and quota-preflighted before a replace-and-restore operation, with rollback to the prior local state if any write fails.
- PDF, DOCX, and EPUB imports now parse in a dedicated bounded worker with phase progress, cancellation, sanitized errors, and unchanged-script recovery on failure.
- Added checked-in raw/gzip budgets for the initial shell and every heavy lazy asset group. Production builds fail on regressions, browser smoke rejects eager engine/parser loads and records time to interactive, and the pinned native probe enforces time to first audio plus real-time factor.
- Added an opt-in real-engine release lane that uses the same immutable Apache-2.0 Kokoro q8 revision in Chromium and the packaged Windows app, decodes generated WAVs, validates cues, cancellation and partial-queue resume, records timing/RTF, and removes its temporary native model cache.
- Added an unsigned Windows static-update path with Pages-hosted `latest.yml`, versioned GitHub Release installer/blockmap assets, six-hour and manual checks, explicit download/restart actions, sanitized failure recovery, packaged bridge/UI smoke coverage, checksum validation, and a live deployment gate.
- Added portable `.bettertts` desktop projects with atomic saves, checksum-validated open/restore, crash-resumable queue and clip assets, debounced autosave, browser-backup migration, and project-wide title/script/filename search.
- Added system-FFmpeg desktop export for WAV, MP3, Ogg Opus, FLAC, and M4B, with bounded IPC/temp files, two-pass EBU R128 normalization, chaptered queue M4B output, optional cover art, capability diagnostics, and actionable installation recovery.
- Promoted Piper-plus to a queueable, lazy desktop catalog engine with persisted language selection and the same project/library/export flow as other local engines; web users retain the explicit experimental gate.

### Changed
- Reimagined the studio as a compact broadcast-console workspace with a wider labeled rail, calmer script stage, complete in-view audio deck, scan-friendly engine inspector, stronger generation dock, and coordinated dark/light responsive themes.

### Fixed
- Settings and crash-recovery text writes now return verified durable/degraded/failed outcomes. Storage-policy, private-mode, and quota failures keep the current session usable while showing one actionable warning, an honest session-only status, and the exact sanitized reason in diagnostics.
- Native FFmpeg exports now preflight decoded duration/bytes, worst-case temporary space, configured ceilings, and actual free disk before processing; failures remove only verified operation-owned temporary roots and report that the destination is unchanged. Browser file-picker writes now abort on write/commit failure instead of closing and committing partial output.
- Desktop project saves now run through one serial queue that drains newer snapshots even after an earlier failure. Each file write compares its revision, SHA-256, mtime, and size before atomic replacement; external changes offer reload, save-copy, explicit overwrite, or cancel, while failures preserve both the previous file and an honest unsaved state.
- Queue generation now uses an atomic IndexedDB compare-and-set lease when Web Locks are unavailable. Concurrent tabs cannot both acquire a job; token-checked renewal, bounded clock-skew recovery, lease-loss cancellation, and stale-owner release guards prevent duplicate synthesis and successor-lease deletion.
- Generation cancellation now aborts pending browser-worker and native-host requests deterministically, releases the active inference process, and keeps cancelled queue chunks resumable. Clip presentation waits for the atomic library write, while queue audio and completed metadata commit in one IndexedDB transaction.
- Queue generation, regeneration, and deletion now use cross-tab leases with crash-expiring fallback locks; queue and library mutations propagate to other open tabs through BroadcastChannel with a storage-event fallback.
- Restored a single ordered workspace heading hierarchy and explicit tab/tabpanel naming for screen-reader navigation; the light-theme muted token now clears WCAG AA against the primary surface.

### Tests
- `npm run typecheck` now covers every Electron TypeScript entry (main, preload, native host/model policy, and tests) plus declared `.mjs` IPC boundaries. Browser smoke uses semantic roles/capability state instead of marketing prose and verifies all eight rendered captures exist and are non-empty before success.
- Added security-policy unit coverage and made web deploys and Windows distributions fail on unresolved high/critical production advisories; packaged distributions also verify the fixed dependency versions inside app.asar.
- Browser smoke now enforces landmarks, heading order, skip-link and focus behavior, reduced-motion and forced-colors rendering, dark/light contrast tokens, and mobile layout.
- `npm run release:smoke` now rebuilds the installer and verifies real synthesis through both browser Worker and packaged Electron utility-process paths while the default smoke stays fast and model-free.

## v0.19.0 - 2026-07-09

### Added
- **Recoverable destructive actions.** Removing a queue job or saved clip, and clearing the clip library, now offers an Undo action backed by complete IndexedDB snapshots; queue chunk audio and clip blobs are restored atomically.
- **Complete mobile workspace.** A compact six-destination rail keeps Studio, Queue, Library, Models, Diagnostics, and Docs available on small screens, while a full-width Generate action now sits beside the mobile script workflow.

### Changed
- **Local-first product shell.** Starter copy, status text, model documentation, privacy guidance, fatal recovery, metadata, and README content now describe the web and Windows editions consistently without browser-only or developer-facing deployment language.
- **Navigation and accessibility.** The shell has a skip link and main landmark, workspace tabs use roving focus with arrow/Home/End navigation, panel actions restore focus, tables have captions, and diagnostics use semantic term/value facts with advanced details collapsed by default.
- **Actionable recovery feedback.** Update-ready and resumable-job notices now include direct actions; initial queue/library load failures are recorded and surfaced instead of failing silently; fatal recovery explains that saved work remains local.
- **Theme and responsive polish.** Browser chrome colors now derive from the same semantic theme tokens as the interface, mobile URL import is compact, and the editor-level primary action spans the available width.
- **Lean verified Windows package.** The x64 installer excludes renderer dependencies already bundled by Vite, native binaries for other operating systems/architectures, probe model caches, and smoke captures. The installer dropped from 395.1 MB to 226.7 MB; an opt-in packaged smoke now loads the verified q8 model through the trimmed native host before release.

### Tests
- 234 -> 238 tests across 29 files, with regression coverage for queue/library snapshot restoration and damaged clip records.
- Playwright smoke coverage now verifies keyboard tabs, mobile navigation, update actions, Queue/Library empty states and Undo flows, and eight rendered views across both themes; failure teardown reliably closes Chromium and the local server.

## v0.18.0 - 2026-07-09

### Added
- **Native desktop inference (TF-99).** The Electron app can now synthesize Kokoro through native ONNX Runtime: an Electron `utilityProcess` hosts kokoro-js on onnxruntime-node's CPU execution provider (DirectML fails Kokoro's ConvTranspose at op level regardless of dtype), mirroring the browser worker protocol over the platform bridge. Desktop settings gain a "Native engine" toggle; blended and multilingual voices transparently fall back to the browser runtime. Measured on this machine: ~1.0-1.2x realtime on CPU, above the browser WASM path. `npm run desktop:probe-host` runs a real end-to-end synthesis probe without a GUI, and the desktop smoke check now proves the host spawns and reports its EP + runtime versions.
- **Verified native model packs (TF-98).** Native Kokoro q8 downloads are driven by a manifest pinned to an immutable Hugging Face revision with per-file SHA-256: downloads resume via HTTP Range, stream-hash while writing, install atomically (a verified copy is never replaced until its replacement passes), and record a verification marker. Non-permissive licenses are blocked from default install behind an explicit opt-in flag. Diagnostics report the pack revision, license, and verification state.
- **Silent-truncation completeness check (TF-129).** Every synthesized sentence is checked against a speech-rate floor (~45 speakable chars/sec, speed-scaled, Indic combining marks counted); implausibly short audio and engine null-returns surface as a post-run warning, diagnostics events, and persistent per-chunk queue warnings with an inline notice pointing at the segment editor.
- **Codec-boundary matrix tests (TF-128).** WAV/MP3/AAC-config paths run a full sample-rate matrix (22.05-96 kHz) in tests; MP3 now rejects non-MPEG rates before encoding instead of producing undefined lamejs output, and empty inputs fail loudly instead of writing empty files.
- **kokoro-js splitter freeze guard (TF-127).** hexgrad/kokoro#343 is open and unfixed upstream: `TextSplitterStream` can freeze the event loop synchronously on inputs like `@handle` + newline. patch-package now applies a `Math.max` advance guard to all three dist bundles, with regression tests on the reproducer.

### Changed
- **Storage quota recovery (TF-132).** A full-storage save now evicts the oldest clips and retries once instead of failing silently forever; the storage meter warns at 90% before saves start failing.
- **Honest error paths (TF-130).** Voice preview reports its real failure instead of always claiming the model isn't loaded; article import distinguishes timeout / HTTP status / unreadable page / invalid URL; storage estimate/persist failures and declined persistence land in diagnostics; queue jobs show per-chunk failure messages inline; non-quota library save errors are recorded.
- **Queue self-healing (TF-102).** A native-host crash fails only the in-flight chunk — the host respawns, reloads once, and retries before surfacing the failure, so long audiobook runs continue instead of failing every later chunk.
- **Keyboard and screen-reader pass (TF-131).** Escape collapses the Advanced, System & diagnostics, and Pronunciations folds and returns focus to their toggles; a successful generation moves focus to the results panel; results, queue, and library are semantic lists that announce item counts.

### Tests
- 191 → 234 tests across 30 suites (native TTS client protocol, model-pack downloader, codec matrix, completeness heuristic, splitter regression, library eviction).

## v0.17.0 - 2026-07-09

### Added
- Native ONNX Runtime probe (`npm run desktop:probe-ort`, `scripts/probe-native-ort.mjs`) — de-risking groundwork for desktop-native inference (ROADMAP TF-99). On this machine onnxruntime-node 1.27 loads the real Kokoro q8 graph; the CPU execution provider runs a clean forward pass (~276 ms / 12-token seq), while DirectML binds but hits a known quantized-ConvTranspose limitation — so native inference will ship CPU-EP-first with fp32-on-DirectML as the GPU follow-up. No app behavior change yet.
- A Windows installer target (`npm run desktop:dist` → electron-builder NSIS x64); the packaged app was verified to launch and render the studio from its asar.
- Desktop app scaffold (Electron, Phase 1). `npm run desktop:build` bundles the existing renderer for an Electron shell that serves it over a custom `app://` scheme with COOP/COEP + CSP set in the main process (crossOriginIsolated, no service worker). Security posture: `contextIsolation` on, `nodeIntegration` off, `sandbox` on, and a single narrow `betterttsPlatform` preload bridge. A `src/platform` seam keeps `App.tsx` platform-agnostic and makes the service worker web-only. `npm run desktop:smoke` verifies the studio renders in-shell via a hidden offscreen window (no focus steal). Native ONNX Runtime inference (onnxruntime-node / DirectML) and FFmpeg export land in later phases; see ROADMAP TF-97/99.

### Changed
- Rebuilt the studio around an image-generated premium desktop concept: persistent Studio/Queue/Library/Models/Diagnostics rail, honest local-session context, a dominant script canvas, compact engine rows, and a fixed two-action generation dock.
- Output, Queue, and Library are now real tab panels instead of stacked anchor destinations. The empty output state is integrated into a functional transport surface, and Clear output moved from the generation inspector to that transport.
- Moved offline packs, diagnostics, and the experimental Piper opt-in behind a dedicated System & diagnostics fold so everyday language, voice, and delivery controls remain reachable in the inspector.
- Replaced the blue-heavy layered palette and decorative gradients with neutral dark/light semantic surfaces, quieter borders, flat selected states, and consistent 4-8px radii.
- Windows packages now carry BetterTTS executable/installer artwork plus complete author and product-description metadata instead of Electron defaults.

### Fixed
- Mobile editor input no longer collapses into a 42px grid track; the toolbar now uses a two-column command grid and the render tabs reflow without overlapping their status heading.
- Smoke coverage now exercises real workspace tabs and the collapsed diagnostics surface, captures stable dark/light/mobile screenshots after theme transitions settle, and validates the redesigned Electron rail rather than removed summary cards.

## v0.16.0 - 2026-07-09

### Fixed
- Restored the production Kokoro engine: GitHub Pages ran Jekyll over the deployed branch and silently dropped Vite's `__vite-browser-external-*` chunks (no `.nojekyll`), 404ing the Kokoro and multilingual lazy imports on the live site. Deploys now ship `.nojekyll`, refuse to run without it, and verify the live site serves the index, entry, and underscore assets after every push.
- Pausing or cancelling a queue run mid-chunk no longer checkpoints a truncated blob as `done` (which silently corrupted that chapter in every later ZIP/M4B export); aborted chunks stay pending and cancelled regenerations keep the previous audio.
- Opus/WebM exports longer than 32.7 seconds no longer carry overflowed block timestamps — the muxer rolls clusters every 5 seconds (SimpleBlock offsets are signed int16), adopts the encoder's real OpusHead as CodecPrivate with CodecDelay/SeekPreRoll, and declares final-frame padding via DiscardPadding.
- Audiobook number cleanup no longer corrupts common English: "1 in 10" and "3 in the morning" previously became "1 inches 10" / "3 inches the morning" (the rule is default-on and was persisted into EPUB queue chunks). Ambiguous units (`in`, `m`, `g`) now expand only before punctuation or end of line.
- EPUB imports resolve URI-encoded manifest/NCX/nav hrefs (encoded filenames silently dropped chapters, up to a whole-book "no readable text" failure) and re-parse non-well-formed XHTML chapters as HTML instead of skipping them.
- M4B export caps AAC candidate sample rates at 48 kHz — on 88.2/96 kHz audio devices the mp4a sample entry (16.16 fixed-point) made muxing throw after the full decode+encode had already run.
- The queue segment editor no longer silently discards an edited draft when regeneration is refused (busy refusals toast and keep the editor open); queueing a job surfaces storage failures instead of doing nothing.
- IndexedDB transaction helpers handle commit-time aborts (lazy quota checks) so queue/library writes can no longer hang forever with the quota toast unreachable; blocked-then-successful DB opens close the orphan connection; persisted zombie `generating` chunks demote to `pending` on load instead of showing a perpetual running pill.
- The v0.15 output-deck tabs actually track the active section now (the active state was hardcoded to Output) with `aria-current`; anchor navigation stops landing under the sticky topbar via scroll margins.
- Editor toolbar moved above the textarea in DOM order — CSS order reshuffling made keyboard focus jump from the textarea back up to the toolbar (WCAG 2.4.3). The notebook ruling now matches the 26px text pitch and scrolls with the content; the line-number gutter (wrong for soft-wrapped prose) was removed.
- Browser/PWA `theme-color` follows the active theme instead of staying near-black under a light UI; light-theme accent-on-tint text (nav links, "How it works" chip, dialog speaker chips) darkened to clear WCAG AA.
- Browser-voice runs clear the previous run's stale "Download all ZIP" link; ZIP/M4B exports are guarded against racing an active generation for the shared status/progress channel; stale progress-reset timers no longer wipe the next run's progress bar.
- Kitten WAV parsing bounds-checks fmt/data chunks (truncated payloads now fail with the parser's own error instead of a raw RangeError); worker model loads are keyed by device:dtype so overlapping loads cannot resolve against the wrong model; the 300-char hard split no longer cuts surrogate pairs; Hindi danda and fullwidth CJK stops count as sentence boundaries.
- EPUB/DOCX extraction caps per-entry decompressed size and DOCX only inflates `word/document.xml` (a size-checked crafted archive could previously balloon toward 25 GB in memory); the smoke server's path guard no longer allows `dist*` sibling-directory escapes.
- Engine status pill shows a warning tint when reporting an unavailable runtime instead of dressing failures in green; disabled buttons no longer light up on hover; Play buttons disable once loaded; warn toasts get a distinct triangle icon and alert role; "1 jobs"/"1 saved clips" pluralization; pitch is no longer promised in the summary strip for engines that ignore it; assorted microcopy and radius-scale cleanup.

### Changed
- Offline prefetch is idempotent (already-cached assets are skipped instead of re-downloading the 92 MB model) and no longer buffers whole payloads in memory through unconsumed response clones; the service worker serves cached shell assets when the network returns 404 after a deploy.
- `deleteJob` uses an IndexedDB key-range delete instead of materializing every stored audio blob to prefix-match keys.
- Tests 177 → 191 (WebM cluster rolling, Opus header adoption, unit-word regressions, unicode chunk boundaries, encoded EPUB hrefs, malformed-XHTML fallback, truncated WAV payloads, queue zombie-status migration).

## v0.15.0 - 2026-07-09

### Changed
- Reworked the studio shell into a more professional workstation layout with a six-tile command summary, side-by-side script/output workbench, tabbed waveform-style output deck, denser queue/library treatment, refreshed control-console modules, and responsive dark/light polish.

### Fixed
- Updated the rendered smoke check to follow the current Script surface label after the interface copy refresh.

## v0.14.0 - 2026-07-09

### Fixed
- Added guardrails and visible recovery messages for slow article imports, oversized files, missing queue/library blobs, failed ZIP exports, and failed clip/library delete actions.
- Improved control semantics, selected-state labels, output-clearing feedback, and model/support copy so secondary controls read correctly in assistive technology and no longer resemble inactive tabs.
- Fixed Opus/WebM native share metadata and ensured stream-preview audio contexts close even when later pitch, background-music, encoding, or ZIP work fails.
- Removed share-target query/hash payloads from diagnostics location data and expanded diagnostic redaction for secret-like URL path segments.
- Hardened premium UI accessibility with contrast-safe action tokens, real active-section navigation, visible engine capability text, labelled dialog voice selectors, status-specific indicators, and coarse-pointer touch targets.
- Prevented the PWA shell cache from storing share-target query payloads or model assets, and capped URL article imports before large cross-origin responses are parsed.
- Rejected corrupt cached Kokoro voice-bin payloads unless they match the exact style tensor size, and blocked oversized or non-audio background music files before decode.
- Added queue export size preflights so ZIP and M4B exports reject oversized batches before materializing every chunk in memory.

## v0.13.0 - 2026-07-09

### Added
- Added an offline pack manager in the control console with per-engine cache status, app-shell separation, Kokoro q8 prefetch, and selective cache clearing.
- Added README and in-app runtime license disclosure, including the GPL-3.0-or-later ephone/eSpeak multilingual path and a local runtime license check command.
- Added M4B/WebCodecs AAC capability preflight, browser-specific unsupported messages, and a chaptered ZIP fallback manifest for queue exports.
- Added a diagnostics export panel that copies/downloads a sanitized local support bundle with browser, WebGPU, codec, storage, cache, model-route, and recent warning/error state.
- Added `npm run smoke`, a local Playwright production-build smoke check for desktop/mobile rendering, theme switching, diagnostics copy, queue controls, M4B fallback messaging, screenshots, and unexpected console-noise regression.
- Expanded text cleanup with reversible controls for footnotes/references, repeated page headers/footers, audiobook number/unit normalization, and ISBN/DOI/cataloging metadata removal.
- Added durable read-along playback resume with previous/next sentence controls for generated clips, saved library clips, and completed queue chunks.
- Added local PDF and DOCX import adapters; PDF text extraction uses lazy PDF.js, DOCX parsing uses existing ZIP/XML tooling, and imports run through the existing cleanup toggles.
- Added inline queue segment/chapter editing with safe single-chunk regeneration; existing audio and exports stay intact until replacement synthesis succeeds.
- Added guarded Cross-Origin Storage detection plus Transformers.js 4.3 upgrade readiness diagnostics without changing the default per-origin model cache behavior.
- Added an experimental Piper-plus engine behind a persisted flag, with lazy `piper-plus`/ONNX Runtime/WASM loading, Tsukuyomi-chan language selection, direct clip generation, diagnostics support, and MIT runtime disclosure.

### Changed
- Split EPUB parsing and multilingual Kokoro runtime paths into on-demand chunks; the production worker bundle now stays small on first load and the fflate static/dynamic import warning is gone.
- Migrated persistent queue jobs to an engine-aware schema so Kokoro, Supertonic, and KittenTTS jobs preserve their voice/model/settings and v1 Kokoro jobs migrate on read.

### Fixed
- Stabilized PDF text extraction under local Vitest/browser-like runs by enabling PDF.js font-face/system-font handling explicitly.

### Tests
- 114 -> 159 assertions across 22 suites, adding coverage for offline cache management, runtime readiness diagnostics, document imports, playback resume, queue segment editing, engine registry behavior, and Piper-plus metadata/audio conversion.

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
