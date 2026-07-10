import {
  AlertCircle,
  Captions,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Info,
  Loader2,
  Moon,
  FilePlus2,
  Play,
  RefreshCw,
  Settings2,
  Share2,
  SquareCode,
  Sun,
  Trash2,
  TriangleAlert,
  Upload,
  Volume2,
  Waves,
  X,
} from 'lucide-react'
import { Component, type ChangeEvent, type ErrorInfo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  collectDiagnostics,
  installGlobalDiagnosticsCapture,
  recordDiagnosticEvent,
  type DiagnosticsSelection,
} from './lib/diagnostics.ts'
import {
  EXPERIMENTAL_PIPER_STORAGE_KEY,
  engineQueueable,
  type EngineId,
} from './lib/engine-registry.ts'
import { type AudioFormat, encodeAudio, formatExtension, formatFromFilename, formatMime, mixBgm, opusSupported, shiftPitch } from './lib/encode.ts'
import { readArticleResponseText } from './lib/article-import.ts'
import { validateBackgroundMusicFile } from './lib/audio-file.ts'
import { queueExportSizeError } from './lib/export-guards.ts'
import { KOKORO_SAMPLE_RATE, type ProgressInfo, type RawAudioLike, loadKokoro, probeWebGpu, resetKokoroSession } from './lib/kokoro.ts'
import { KOKORO_HF_RESOLVE_PREFIX, KOKORO_LOCAL_MODEL_PREFIX, KOKORO_MODEL_ID } from './lib/kokoro-assets.ts'
import { loadTimestampedKokoro, resetTimestampedKokoroSession, synthesizeTimestampedKokoro } from './lib/kokoro-timestamps.ts'
import { needsDirectKokoroPath } from './lib/kokoro-direct.ts'
import { generateWorker, loadKokoroWorker, resetWorker } from './lib/kokoro-worker.ts'
import { generateNative, getNativeRuntimeInfo, loadNativeKokoro, nativeTtsAvailable, resetNativeTts } from './platform/native-tts.ts'
import { type VoiceMixEntry, blendVoiceBins, fetchVoiceBin, formatMixFormula } from './lib/voice-mix.ts'
import { type ClipRecord, type ClipSnapshot, clearLibraryWithSnapshot, deleteClipWithSnapshot, enforceLibraryCap, freeLibrarySpace, getClipBlob, listClips, restoreClipSnapshots, saveClip } from './lib/library.ts'
import { buildM4bFromBlobs, checkM4bCapability, type M4bCapability } from './lib/m4b.ts'
import {
  type EngineCacheStatus,
  type ModelCacheEngineId,
  type ModelCacheSummary,
  clearModelCache,
  prefetchKokoroQ8Pack,
  readModelCacheStatus,
} from './lib/model-cache.ts'
import {
  TRANSFORMERS_RUNTIME_VERSION,
  detectCrossOriginStorage,
  transformersUpgradeReadiness,
} from './lib/runtime-readiness.ts'
import {
  PIPER_PLUS_LANGUAGES,
  PIPER_PLUS_MODEL_ID,
  PIPER_PLUS_MODEL_LABEL,
  PIPER_PLUS_PACKAGE_VERSION,
  PIPER_PLUS_SAMPLE_RATE,
  type PiperPlusLanguage,
  loadPiperPlus,
  piperPlusRuntimeSupport,
  resetPiperPlusSession,
  synthesizePiperPlus,
} from './lib/piper-plus.ts'
import { type QueueEngine, type QueueJob, deleteJobWithSnapshot, getChunkBlob, jobProgress, listJobs, replaceQueueChunk, restoreQueueJob, saveChunkBlob, saveJob } from './lib/queue.ts'
import {
  clampResumeTime,
  clearPlaybackState,
  cueIndexAtTime,
  formatPlaybackTime,
  loadPlaybackState,
  nextCueIndex,
  previousCueIndex,
  savePlaybackState,
} from './lib/playback.ts'
import {
  KITTEN_DEFAULT_MODEL,
  KITTEN_MODELS,
  KITTEN_PREVIEW_TEXT,
  KITTEN_SAMPLE_RATE,
  KITTEN_VOICES,
  type KittenModelSize,
  type KittenVoiceId,
  clampKittenSpeed,
  hasKittenWebGpu,
  synthesizeKitten,
} from './lib/kitten.ts'
import { SUPERTONIC_DEFAULT_STEPS, SUPERTONIC_MODEL_ID, SUPERTONIC_SAMPLE_RATE, SUPERTONIC_VOICES, type SupertonicVoiceId, clampSupertonicSpeed, loadSupertonic, supertonicVoiceUrl, synthesizeSupertonic } from './lib/supertonic.ts'
import { type CleanupOptions, DEFAULT_CLEANUP, PAUSE_TAG, checkSynthesisCompleteness, cleanupText, formatBytes, parseDialogLines, parsePauseTags, slugify, splitInput, splitIntoSentences } from './lib/text.ts'
import { KOKORO_LANGUAGES, VOICES, isEnglishKokoroLocale, kokoroLanguageForLocale, kokoroLanguageForVoice, type KokoroLocale } from './lib/voices.ts'
import { type Cue, toSRT, toVTT } from './lib/subtitles.ts'
import { concatFloat32Arrays, encodeWav } from './lib/wav.ts'
import { speakBrowser } from './lib/webspeech.ts'

const APP_VERSION = '0.19.0'
const MAX_TEXT_CHARS = 5000
const MAX_IMPORT_BYTES = 25 * 1024 * 1024
const ARTICLE_IMPORT_TIMEOUT_MS = 15000
const EMPTY_VTT_URL = 'data:text/vtt;charset=utf-8,WEBVTT%0A%0A'

type Engine = EngineId
type Theme = 'dark' | 'light'
type NavSection = 'studio' | 'models' | 'docs'

type QueueSourceChunk = {
  text: string
  chapterTitle?: string
  chapterIndex?: number
}

type AudioResult = {
  id: string
  filename: string
  label: string
  duration: string
  size: string
  url?: string
  replayText?: string
  cues?: Cue[]
  srtUrl?: string
  vttUrl?: string
}

type Toast = {
  tone: 'ok' | 'warn' | 'error'
  message: string
  action?: {
    label: string
    run: () => void | Promise<void>
  }
}

const STARTER_TEXT = `Welcome to BetterTTS — private text-to-speech that runs entirely on your device.

No account, no cloud processing, no usage caps — up to 5,000 characters per run. Your text and audio stay on this device.

Choose an engine and voice in Properties, then select Generate audio. BetterTTS will synthesize your script locally.

Download as WAV, MP3, or Opus when you're done.`

const WORKSPACE_TABS = [['generated-output', 'Output'], ['queue-panel', 'Queue'], ['library-panel', 'Library']] as const

function handleWorkspaceTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
  const currentIndex = tabs.indexOf(event.currentTarget)
  if (currentIndex < 0 || tabs.length === 0) return

  event.preventDefault()
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? tabs.length - 1
      : (currentIndex + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + tabs.length) % tabs.length
  tabs[nextIndex].focus()
  tabs[nextIndex].click()
}

const MODEL_ROWS = [
  ['Kokoro 82M', 'Kokoro local', '82M', 'EN / ES / FR / HI / IT / PT', 'Ready'],
  ['Kokoro timestamped', 'Kokoro local', '82M', 'Word-level timings', 'Opt-in'],
  ['Supertonic', 'Transformers.js', '66M', 'English speed engine', 'Ready'],
  ['KittenTTS', 'WebGPU shaders', '15M / 40M / 80M', 'English lightweight engine', 'Ready'],
  ['Piper-plus', 'WASM + ONNX Runtime', 'Tsukuyomi-chan', 'JA / EN / ZH / KO / ES / FR / PT / SV', 'Experimental'],
  ['Kokoro multilingual', 'ephone + HF voice bins', '82M', 'ES / FR / HI / IT / PT', 'Ready'],
  ['Browser voices', 'Web Speech', 'Native', 'Device voices', 'Fallback'],
]

const RUNTIME_LICENSE_ROWS = [
  ['BetterTTS app code', 'MIT', 'App shell, UI, queue, exports'],
  ['kokoro-js, Kokoro ONNX, Transformers.js, phonemizer', 'Apache-2.0', 'Kokoro, timestamps, English phonemization'],
  ['ephone / eSpeak NG WASM', 'GPL-3.0-or-later', 'Loaded only for multilingual Kokoro voices: ES / FR / HI / IT / PT-BR'],
  ['KittenTTS browser wrapper', 'MIT', 'Kitten model weights are Apache-2.0'],
  ['piper-plus, @piper-plus/g2p, onnxruntime-web', 'MIT', 'Experimental Piper-plus engine; lazy package/WASM/model path'],
  ['Supertonic ONNX model', 'OpenRAIL', 'HF-hosted English speed engine'],
  ['lamejs MP3 encoder', 'LGPL-3.0', 'MP3 export path'],
  ['pdfjs-dist', 'Apache-2.0', 'Local PDF text extraction'],
  ['signalsmith-stretch, fflate', 'MIT', 'Pitch shift and ZIP/EPUB/DOCX parsing'],
  ['lucide-react', 'ISC', 'Interface icons'],
]

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  try {
    const saved = window.localStorage.getItem('bettertts-theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* storage blocked */ }
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light'
  return 'dark'
}

function getInitialPiperFlag(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const params = new URLSearchParams(window.location.search)
    return params.get('piper') === '1' || window.localStorage.getItem(EXPERIMENTAL_PIPER_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function getActiveNavSection(): NavSection {
  if (typeof window === 'undefined') return 'studio'
  const hash = window.location.hash.replace(/^#/, '')
  return hash === 'models' || hash === 'docs' ? hash : 'studio'
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

function shortUiLabel(value: string, max = 80): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function importSizeError(file: File): Toast | null {
  if (file.size <= MAX_IMPORT_BYTES) return null
  return {
    tone: 'warn',
    message: `${shortUiLabel(file.name, 56)} is ${formatBytes(file.size)}. Import files must be ${formatBytes(MAX_IMPORT_BYTES)} or smaller.`,
  }
}

function queueJobStatus(job: QueueJob): 'ready' | 'running' | 'failed' | 'pending' {
  if (job.chunks.some((chunk) => chunk.status === 'failed')) return 'failed'
  if (job.chunks.some((chunk) => chunk.status === 'generating')) return 'running'
  if (job.chunks.length > 0 && job.chunks.every((chunk) => chunk.status === 'done')) return 'ready'
  return 'pending'
}

function modelStatusClass(status: string): string {
  const normalized = status.toLowerCase()
  if (normalized === 'ready') return 'status-ready'
  if (normalized === 'fallback' || normalized === 'opt-in' || normalized === 'experimental') return 'status-warn'
  return 'status-muted'
}

function cacheStatusText(row: EngineCacheStatus, supported: boolean): string {
  if (!supported) return 'Cache API unavailable'
  if (row.entryCount === 0) return 'Not cached'
  const fileLabel = row.entryCount === 1 ? 'file' : 'files'
  const size = row.sizeBytes > 0 ? formatBytes(row.sizeBytes) : 'size unknown'
  const unknown = row.unknownSizeCount > 0 ? ` + ${row.unknownSizeCount} unknown` : ''
  return `${row.entryCount} ${fileLabel} - ${size}${unknown}`
}

function queueEngineText(job: QueueJob): string {
  if (job.engine === 'supertonic') return `Supertonic - ${job.supertonicSteps ?? SUPERTONIC_DEFAULT_STEPS} steps`
  if (job.engine === 'kitten') return `KittenTTS - ${(job.kittenModel ?? KITTEN_DEFAULT_MODEL).toUpperCase()}`
  return `Kokoro - ${job.language ?? 'English US'}`
}

function m4bCapabilityTone(capability: M4bCapability | null): 'ok' | 'warn' | 'muted' {
  if (capability == null) return 'muted'
  return capability.supported ? 'ok' : 'warn'
}

function m4bCapabilityText(capability: M4bCapability | null): string {
  return capability?.message ?? 'Checking M4B WebCodecs AAC support…'
}

function crossOriginStorageShortLabel(usable: boolean): string {
  return usable ? 'available' : 'not available'
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Clipboard copy is unavailable in this browser.')
  } finally {
    document.body.removeChild(textarea)
  }
}

async function getDurationLabel(blob: Blob) {
  const url = URL.createObjectURL(blob)
  try {
    const audio = document.createElement('audio')
    audio.preload = 'metadata'

    return await new Promise<string>((resolve) => {
      // Some blobs fire neither loadedmetadata nor error; never hang the pipeline.
      const fallback = setTimeout(() => resolve('ready'), 5000)
      audio.onloadedmetadata = () => {
        clearTimeout(fallback)
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0
        resolve(`${duration.toFixed(1)}s`)
      }
      audio.onerror = () => {
        clearTimeout(fallback)
        resolve('ready')
      }
      audio.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

type ResultRowProps = {
  result: AudioResult
  isSpeaking: boolean
  onReplay: (text: string) => void
  onShare: (result: AudioResult) => void
  onSave: (result: AudioResult) => void
}

type PlaybackAudioProps = {
  playbackKey: string
  src: string
  label: string
  cues?: Cue[]
  vttUrl?: string
}

function PlaybackAudio({ playbackKey, src, label, cues: cueList, vttUrl }: PlaybackAudioProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const activeCueRef = useRef<HTMLButtonElement | null>(null)
  const [followAlong, setFollowAlong] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const [resumeNote, setResumeNote] = useState<string | null>(null)
  const restoredRef = useRef(false)
  const cues = useMemo(() => cueList ?? [], [cueList])

  useEffect(() => {
    restoredRef.current = false
    setActiveIdx(-1)
    setResumeNote(null)
  }, [playbackKey, src])

  useEffect(() => {
    const el = audioRef.current
    if (!el) return

    const activeCue = () => cueIndexAtTime(cues, el.currentTime)
    const persist = () => {
      const idx = activeCue()
      setActiveIdx((current) => (current === idx ? current : idx))
      savePlaybackState(playbackKey, {
        timeSec: el.currentTime,
        cueIndex: idx >= 0 ? idx : undefined,
      })
    }
    const restore = () => {
      if (restoredRef.current) return
      restoredRef.current = true
      const saved = loadPlaybackState(playbackKey)
      if (!saved) return
      const resumeAt = clampResumeTime(saved.timeSec, el.duration)
      if (resumeAt <= 0) {
        clearPlaybackState(playbackKey)
        return
      }
      el.currentTime = resumeAt
      const savedCue = typeof saved.cueIndex === 'number' && cues[saved.cueIndex] ? saved.cueIndex : cueIndexAtTime(cues, resumeAt)
      setActiveIdx(savedCue)
      const sentence = savedCue >= 0 ? ` - sentence ${savedCue + 1}` : ''
      setResumeNote(`Resumed at ${formatPlaybackTime(resumeAt)}${sentence}`)
    }

    const end = () => {
      clearPlaybackState(playbackKey)
      setActiveIdx(-1)
      setResumeNote(null)
    }

    el.addEventListener('loadedmetadata', restore)
    el.addEventListener('timeupdate', persist)
    el.addEventListener('pause', persist)
    el.addEventListener('seeked', persist)
    el.addEventListener('ended', end)
    if (el.readyState >= 1) restore()
    return () => {
      el.removeEventListener('loadedmetadata', restore)
      el.removeEventListener('timeupdate', persist)
      el.removeEventListener('pause', persist)
      el.removeEventListener('seeked', persist)
      el.removeEventListener('ended', end)
    }
  }, [playbackKey, cues])

  useEffect(() => {
    if (!followAlong || activeIdx < 0) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    activeCueRef.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
  }, [activeIdx, followAlong])

  const seekCue = (index: number) => {
    const cue = cues[index]
    const el = audioRef.current
    if (!cue || !el) return
    el.currentTime = cue.startSec + 0.001
    savePlaybackState(playbackKey, { timeSec: el.currentTime, cueIndex: index })
    setActiveIdx(index)
    el.play().catch(() => {})
  }

  const seekRelativeCue = (direction: -1 | 1) => {
    const el = audioRef.current
    if (!el || cues.length === 0) return
    const target = direction < 0 ? previousCueIndex(cues, el.currentTime) : nextCueIndex(cues, el.currentTime)
    if (target >= 0) seekCue(target)
  }

  return (
    <div className="playback-block">
      <audio ref={audioRef} controls preload="metadata" src={src} aria-label={label}>
        <track kind="captions" src={vttUrl ?? EMPTY_VTT_URL} srcLang="en" label={vttUrl ? 'English' : 'No captions'} />
      </audio>
      <div className="playback-tools" aria-label={`Playback controls for ${label}`}>
        {cues.length > 0 ? (
          <>
            <button type="button" onClick={() => seekRelativeCue(-1)} aria-label={`Previous sentence for ${label}`}>
              <ChevronLeft size={15} aria-hidden="true" />
              Sentence
            </button>
            <button type="button" onClick={() => seekRelativeCue(1)} aria-label={`Next sentence for ${label}`}>
              Sentence
              <ChevronRight size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setFollowAlong(!followAlong)}
              aria-pressed={followAlong}
              className={followAlong ? 'follow-active' : undefined}
            >
              <Captions size={15} aria-hidden="true" />
              Follow
            </button>
          </>
        ) : (
          <small>{resumeNote ?? 'Position saves locally for this clip.'}</small>
        )}
        {resumeNote && cues.length > 0 ? <small>{resumeNote}</small> : null}
      </div>
      {followAlong && cues.length > 0 ? (
        <div className="read-along" aria-label="Follow along transcript">
          {cues.map((cue, i) => (
            <button
              key={cue.index}
              ref={i === activeIdx ? activeCueRef : null}
              type="button"
              className={i === activeIdx ? 'cue active' : 'cue'}
              onClick={() => seekCue(i)}
            >
              {cue.text}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ResultRow({ result, isSpeaking, onReplay, onShare, onSave }: ResultRowProps) {
  const cues = result.cues ?? []

  return (
    <div className="result-row">
      <div className="result-meta">
        <span className="ready-dot" aria-hidden="true" />
        <strong>{result.filename}</strong>
        <span>{result.duration}</span>
        <span>{result.size}</span>
      </div>
      {result.url ? (
        <PlaybackAudio playbackKey={`clip:${result.id}`} src={result.url} label={result.filename} cues={cues} vttUrl={result.vttUrl} />
      ) : null}
      <div className="result-actions">
        {result.replayText ? (
          <button type="button" onClick={() => onReplay(result.replayText!)} disabled={isSpeaking}>
            {isSpeaking ? <Loader2 size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
            Replay
          </button>
        ) : null}
        {result.url && 'showSaveFilePicker' in window ? (
          <button type="button" onClick={() => onSave(result)}>
            <Download size={16} aria-hidden="true" />
            {result.filename.endsWith('.mp3') ? 'MP3' : result.filename.endsWith('.webm') ? 'Opus' : 'WAV'}
          </button>
        ) : result.url ? (
          <a href={result.url} download={result.filename}>
            <Download size={16} aria-hidden="true" />
            {result.filename.endsWith('.mp3') ? 'MP3' : result.filename.endsWith('.webm') ? 'Opus' : 'WAV'}
          </a>
        ) : null}
        {result.url && typeof navigator !== 'undefined' && 'canShare' in navigator ? (
          <button type="button" onClick={() => onShare(result)} aria-label={`Share ${result.filename}`}>
            <Share2 size={16} aria-hidden="true" />
          </button>
        ) : null}
        {result.srtUrl && result.vttUrl ? (
          <>
            <a href={result.srtUrl} download={result.filename.replace(/\.\w+$/, '.srt')}>
              <FileText size={16} aria-hidden="true" />
              SRT
            </a>
            <a href={result.vttUrl} download={result.filename.replace(/\.\w+$/, '.vtt')}>
              <FileText size={16} aria-hidden="true" />
              VTT
            </a>
          </>
        ) : null}
      </div>
    </div>
  )
}

type LibraryClipRowProps = {
  clip: ClipRecord
  onDeleted: (snapshot: ClipSnapshot) => void
  onNotice: (toast: Toast) => void
}

function cueDataUrl(cues?: Cue[]): string | undefined {
  if (!cues?.length) return undefined
  return `data:text/vtt;charset=utf-8,${encodeURIComponent(toVTT(cues))}`
}

function LibraryClipRow({ clip, onDeleted, onNotice }: LibraryClipRowProps) {
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState<'load' | 'download' | 'delete' | null>(null)
  const vttUrl = useMemo(() => cueDataUrl(clip.cues), [clip.cues])

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [url])

  const loadPlayer = async () => {
    if (url) return
    setBusy('load')
    try {
      const blob = await getClipBlob(clip.id)
      if (!blob) {
        onNotice({ tone: 'warn', message: 'Saved audio is missing for this clip.' })
        return
      }
      setUrl(URL.createObjectURL(blob))
    } catch {
      onNotice({ tone: 'error', message: 'Could not load saved audio.' })
    } finally {
      setBusy(null)
    }
  }

  const downloadClip = async () => {
    setBusy('download')
    try {
      const blob = await getClipBlob(clip.id)
      if (!blob) {
        onNotice({ tone: 'warn', message: 'Saved audio is missing for this clip.' })
        return
      }
      const downloadUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = downloadUrl
      a.download = clip.filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
    } catch {
      onNotice({ tone: 'error', message: 'Could not download saved audio.' })
    } finally {
      setBusy(null)
    }
  }

  const removeClip = async () => {
    setBusy('delete')
    try {
      const snapshot = await deleteClipWithSnapshot(clip.id)
      if (!snapshot) throw new Error('Saved audio is missing for this clip.')
      if (url) URL.revokeObjectURL(url)
      onDeleted(snapshot)
    } catch (error) {
      onNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not remove this saved clip.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="result-row library-row">
      <div className="result-meta">
        <span className="ready-dot" aria-hidden="true" />
        <strong>{clip.label}</strong>
        <span>{clip.duration}</span>
        <span>{formatBytes(clip.size)}</span>
        {clip.cues?.length ? <span>{clip.cues.length} cues</span> : <span>time resume</span>}
      </div>
      {url ? (
        <PlaybackAudio playbackKey={`clip:${clip.id}`} src={url} label={clip.filename} cues={clip.cues} vttUrl={vttUrl} />
      ) : null}
      <div className="result-actions">
        <button type="button" onClick={loadPlayer} disabled={busy !== null || url !== null}>
          {busy === 'load' ? <Loader2 size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          {url ? 'Loaded' : 'Play'}
        </button>
        <button type="button" onClick={downloadClip} disabled={busy !== null}>
          {busy === 'download' ? <Loader2 size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
          Download
        </button>
        <button type="button" onClick={removeClip} disabled={busy !== null} aria-label={`Remove ${clip.label}`}>
          {busy === 'delete' ? <Loader2 size={16} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}

type QueueChunkPlayerProps = {
  jobId: string
  chunk: QueueJob['chunks'][number]
  format: AudioFormat
  regenerating: boolean
  onRegenerate: (jobId: string, chunkIndex: number, nextText: string, nextTitle?: string) => Promise<boolean>
  onNotice: (toast: Toast) => void
}

function QueueChunkPlayer({ jobId, chunk, format, regenerating, onRegenerate, onNotice }: QueueChunkPlayerProps) {
  const [url, setUrl] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftText, setDraftText] = useState(chunk.text)
  const [draftTitle, setDraftTitle] = useState(chunk.chapterTitle ?? '')
  const [loading, setLoading] = useState(false)
  const vttUrl = useMemo(() => cueDataUrl(chunk.cues), [chunk.cues])
  const label = `Chunk ${chunk.index + 1}: ${chunk.chapterTitle ?? chunk.text.slice(0, 38)}`

  useEffect(() => {
    if (!editing) {
      setDraftText(chunk.text)
      setDraftTitle(chunk.chapterTitle ?? '')
    }
  }, [chunk.text, chunk.chapterTitle, editing])

  useEffect(() => {
    setUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
  }, [chunk.text, chunk.duration])

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [url])

  const loadPlayer = async () => {
    if (url) return
    setLoading(true)
    try {
      const blob = await getChunkBlob(jobId, chunk.index)
      if (!blob) {
        onNotice({ tone: 'warn', message: `Audio is missing for chunk ${chunk.index + 1}. Resume the job, then try again.` })
        return
      }
      setUrl(URL.createObjectURL(blob))
    } catch {
      onNotice({ tone: 'error', message: `Could not load chunk ${chunk.index + 1}.` })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="queue-chunk-row">
      <div className="queue-chunk-meta">
        <strong>{String(chunk.index + 1).padStart(3, '0')}</strong>
        <span>{chunk.chapterTitle ?? chunk.text}</span>
        <small>
          {chunk.duration ?? format.toUpperCase()}
          {chunk.cues?.length ? ` - ${chunk.cues.length} cues` : ' - time resume'}
        </small>
      </div>
      <button type="button" onClick={loadPlayer} disabled={loading || regenerating || url !== null}>
        {loading ? <Loader2 size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
        {url ? 'Loaded' : 'Play'}
      </button>
      <button type="button" onClick={() => setEditing((value) => !value)} disabled={regenerating}>
        <FileText size={15} aria-hidden="true" />
        {editing ? 'Close' : 'Edit'}
      </button>
      {url ? (
        <PlaybackAudio playbackKey={`queue:${jobId}:${chunk.index}`} src={url} label={label} cues={chunk.cues} vttUrl={vttUrl} />
      ) : null}
      {editing ? (
        <div className="queue-chunk-editor">
          <label>
            Chapter title
            <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} placeholder="Chapter title" />
          </label>
          <label>
            Segment text
            <textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} rows={4} />
          </label>
          <div className="queue-chunk-editor-actions">
            <button
              type="button"
              onClick={() => {
                setDraftText(chunk.text)
                setDraftTitle(chunk.chapterTitle ?? '')
                setEditing(false)
              }}
              disabled={regenerating}
            >
              <X size={15} aria-hidden="true" />
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                // Close the editor (discarding the draft) only when the change
                // was actually applied — a busy refusal or failure keeps it open.
                onRegenerate(jobId, chunk.index, draftText, draftTitle)
                  .then((applied) => {
                    if (applied) setEditing(false)
                  })
                  .catch(() => {})
              }}
              disabled={regenerating || !draftText.trim()}
            >
              {regenerating ? <Loader2 size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
              {draftText === chunk.text ? 'Save title' : 'Regenerate'}
            </button>
          </div>
          <small>Old audio stays available until the replacement segment finishes successfully.</small>
        </div>
      ) : null}
    </div>
  )
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    recordDiagnosticEvent('error', error, 'react.error-boundary')
    console.error(error, info.componentStack)
  }

  override render() {
    if (this.state.error) {
      return (
        <main className="fatal-shell">
          <section className="fatal-panel" role="alert" aria-labelledby="fatal-title">
            <AlertCircle size={32} aria-hidden="true" />
            <h1 id="fatal-title">BetterTTS needs to restart</h1>
            <p>An unexpected interface error interrupted this session. Reload to recover; saved clips and queued jobs remain on this device.</p>
            <button type="button" onClick={() => window.location.reload()}>
              <RefreshCw size={16} aria-hidden="true" />
              Reload BetterTTS
            </button>
          </section>
        </main>
      )
    }

    return this.props.children
  }
}

function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [activeNavSection, setActiveNavSection] = useState<NavSection>(getActiveNavSection)
  const [activeWorkspaceHash, setActiveWorkspaceHash] = useState<string>(() => (
    typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, '')
  ))
  const [engine, setEngine] = useState<Engine>('kokoro')
  const [locale, setLocale] = useState<KokoroLocale>('en-us')
  const [voiceId, setVoiceId] = useState('af_heart')
  const [supertonicVoiceId, setSupertonicVoiceId] = useState<SupertonicVoiceId>('F1')
  const [supertonicSteps, setSupertonicSteps] = useState(SUPERTONIC_DEFAULT_STEPS)
  const [kittenVoiceId, setKittenVoiceId] = useState<KittenVoiceId>('Bella')
  const [kittenModelSize, setKittenModelSize] = useState<KittenModelSize>(KITTEN_DEFAULT_MODEL)
  const [piperLanguage, setPiperLanguage] = useState<PiperPlusLanguage>('ja')
  const [experimentalPiperEnabled, setExperimentalPiperEnabled] = useState(getInitialPiperFlag)
  const [speed, setSpeed] = useState(1)
  const [separateLines, setSeparateLines] = useState(false)
  const [streamPlay, setStreamPlay] = useState(true)
  const [audioFormat, setAudioFormat] = useState<AudioFormat>('wav')
  const [mp3Bitrate, setMp3Bitrate] = useState(160)
  const [useWorker, setUseWorker] = useState(true)
  const [wordTimestamps, setWordTimestamps] = useState(false)
  const [pitchSemitones, setPitchSemitones] = useState(0)
  const [bgmFile, setBgmFile] = useState<File | null>(null)
  const [bgmVolume, setBgmVolume] = useState(0.15)
  const [dialogMode, setDialogMode] = useState(false)
  const [speakerMap, setSpeakerMap] = useState<Record<string, string>>({})
  const [pronunciations, setPronunciations] = useState<Record<string, string>>(() => {
    try {
      const saved = window.localStorage.getItem('bettertts-pronunciations')
      return saved ? JSON.parse(saved) : {}
    } catch { return {} }
  })
  const [cleanup, setCleanup] = useState<CleanupOptions>(() => {
    try {
      const saved = window.localStorage.getItem('bettertts-cleanup')
      return saved ? { ...DEFAULT_CLEANUP, ...JSON.parse(saved) } : DEFAULT_CLEANUP
    } catch { return DEFAULT_CLEANUP }
  })
  const [text, setText] = useState(STARTER_TEXT)
  const [results, setResults] = useState<AudioResult[]>([])
  const [zipUrl, setZipUrl] = useState<string | null>(null)
  const [zipName, setZipName] = useState('bettertts-audio.zip')
  const [toast, setToast] = useState<Toast | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [status, setStatus] = useState('Ready')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [pauseDuration, setPauseDuration] = useState(1)
  const [forceWasm, setForceWasm] = useState(() => {
    try {
      return window.localStorage.getItem('bettertts-backend') === 'wasm'
    } catch {
      return false
    }
  })
  const nativeAvailable = nativeTtsAvailable()
  const [forceNative, setForceNative] = useState(() => {
    if (!nativeTtsAvailable()) return false
    try {
      return window.localStorage.getItem('bettertts-backend') === 'native'
    } catch {
      return false
    }
  })
  const [runtimeLabel, setRuntimeLabel] = useState(
    typeof navigator !== 'undefined' && 'gpu' in navigator ? 'WebGPU fp32' : 'WebAssembly q8',
  )
  const [modelCache, setModelCache] = useState<ModelCacheSummary | null>(null)
  const [cacheAction, setCacheAction] = useState<string | null>(null)
  const [diagnosticsAction, setDiagnosticsAction] = useState<'copy' | 'download' | null>(null)
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([])
  const [browserVoiceUri, setBrowserVoiceUri] = useState('')
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null)
  const [genStats, setGenStats] = useState<{ elapsed: number; chars: number; audioDuration: number } | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showSystemTools, setShowSystemTools] = useState(false)
  const [showPronunciations, setShowPronunciations] = useState(false)
  const [voiceMixEnabled, setVoiceMixEnabled] = useState(false)
  const [voiceMixEntries, setVoiceMixEntries] = useState<VoiceMixEntry[]>([
    { voiceId: 'af_heart', weight: 2 },
    { voiceId: 'af_bella', weight: 1 },
  ])
  const [newWord, setNewWord] = useState('')
  const [newPronunciation, setNewPronunciation] = useState('')
  const [importUrlValue, setImportUrlValue] = useState('')
  const [importingUrl, setImportingUrl] = useState(false)
  const [library, setLibrary] = useState<ClipRecord[]>([])
  const [storageEstimate, setStorageEstimate] = useState<string | null>(null)
  const [queueJobs, setQueueJobs] = useState<QueueJob[]>([])
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [regeneratingChunkKey, setRegeneratingChunkKey] = useState<string | null>(null)
  const [m4bExportingJobId, setM4bExportingJobId] = useState<string | null>(null)
  const [zipExportingJobId, setZipExportingJobId] = useState<string | null>(null)
  const [m4bCapability, setM4bCapability] = useState<M4bCapability | null>(null)
  const persistRequestedRef = useRef(false)
  const storagePressureWarnedRef = useRef(false)
  const outputPanelRef = useRef<HTMLElement | null>(null)
  const advancedToggleRef = useRef<HTMLButtonElement | null>(null)
  const advancedSectionRef = useRef<HTMLDivElement | null>(null)
  const systemToolsToggleRef = useRef<HTMLButtonElement | null>(null)
  const systemToolsSectionRef = useRef<HTMLDivElement | null>(null)
  const pronunciationsToggleRef = useRef<HTMLButtonElement | null>(null)
  const pronunciationsSectionRef = useRef<HTMLDivElement | null>(null)

  // Escape while focus is inside an expanded fold collapses it and returns
  // focus to its toggle, so keyboard users are never stranded in a
  // collapsed-away subtree. Scoped by containment — Escape elsewhere is inert.
  useEffect(() => {
    function onEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      const target = event.target instanceof Node ? event.target : null
      if (!target) return
      const folds: Array<[HTMLElement | null, () => void, HTMLButtonElement | null]> = [
        [advancedSectionRef.current, () => setShowAdvanced(false), advancedToggleRef.current],
        [systemToolsSectionRef.current, () => setShowSystemTools(false), systemToolsToggleRef.current],
        [pronunciationsSectionRef.current, () => setShowPronunciations(false), pronunciationsToggleRef.current],
      ]
      for (const [container, collapse, toggle] of folds) {
        if (container?.contains(target)) {
          collapse()
          toggle?.focus()
          return
        }
      }
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [])
  const previewCacheRef = useRef<Map<string, string>>(new Map())
  const bgmInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const objectUrlsRef = useRef<string[]>([])
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const progressTimerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const abortRef = useRef(false)
  const generatingRef = useRef(false)

  // A run scheduled 700 ms after the previous one ends must not have its
  // progress bar wiped by the previous run's reset timer.
  function clearProgressResetTimer() {
    if (progressTimerRef.current) {
      clearTimeout(progressTimerRef.current)
      progressTimerRef.current = null
    }
  }

  const availableVoices = useMemo(() => VOICES.filter((voice) => voice.locale === locale), [locale])
  const selectedVoice = VOICES.find((voice) => voice.id === voiceId) ?? VOICES[0]
  const selectedSupertonicVoice = SUPERTONIC_VOICES.find((voice) => voice.id === supertonicVoiceId) ?? SUPERTONIC_VOICES[0]
  const selectedKittenVoice = KITTEN_VOICES.find((voice) => voice.id === kittenVoiceId) ?? KITTEN_VOICES[0]
  const selectedKittenModel = KITTEN_MODELS.find((model) => model.id === kittenModelSize) ?? KITTEN_MODELS[0]
  const selectedPiperLanguage = PIPER_PLUS_LANGUAGES.find((language) => language.id === piperLanguage) ?? PIPER_PLUS_LANGUAGES[0]
  const selectedKokoroLanguage = kokoroLanguageForLocale(locale)
  const englishKokoro = isEnglishKokoroLocale(locale)
  const blendableVoices = useMemo(() => VOICES.filter((voice) => isEnglishKokoroLocale(voice.locale)), [])
  const kokoroRuntimeLabel = runtimeLabel.startsWith('Supertonic') ? (forceWasm ? 'WebAssembly q8' : 'WebGPU fp32 / WebAssembly q8') : runtimeLabel
  const kittenRuntimeReady = hasKittenWebGpu()
  const speedMin = engine === 'supertonic' ? 0.8 : 0.5
  const speedMax = engine === 'supertonic' ? 1.2 : engine === 'kitten' ? 2 : 1.5
  const usableText = text.slice(0, MAX_TEXT_CHARS)
  const overLimit = text.length > MAX_TEXT_CHARS
  const wordCount = useMemo(() => text.trim().split(/\s+/).filter(Boolean).length, [text])
  const lineCount = useMemo(() => text.split(/\r?\n/).length, [text])
  const cacheRows = modelCache?.engines ?? []
  const modelCached = (cacheRows.find((row) => row.id === 'kokoro')?.entryCount ?? 0) > 0
  const m4bExportReady = m4bCapability?.supported === true
  const crossOriginStorage = useMemo(() => detectCrossOriginStorage(), [])
  const transformersReadiness = useMemo(() => transformersUpgradeReadiness(), [])
  const piperPlusSupport = useMemo(() => piperPlusRuntimeSupport(), [])
  const queueDisabledReason = engine === 'browser'
    ? 'Queue export is unavailable for Browser voices.'
    : engine === 'piper'
      ? 'Experimental Piper-plus jobs can generate clips but are not queueable yet.'
    : !usableText.trim()
      ? 'Enter text before queueing.'
      : null
  const engineStatus =
    engine === 'kokoro'
      ? `${selectedKokoroLanguage.label} - ${kokoroRuntimeLabel}${modelCached ? ' - cached' : ''}${storageEstimate ? ` - ${storageEstimate}` : ''}`
      : engine === 'supertonic'
        ? 'English speed engine - 44.1 kHz fp32'
        : engine === 'kitten'
          ? `${selectedKittenModel.label} - ${selectedKittenModel.params} - ${kittenRuntimeReady ? 'WebGPU available' : 'WebGPU unavailable'}`
          : engine === 'piper'
            ? `${PIPER_PLUS_MODEL_LABEL} - ${selectedPiperLanguage.label} - experimental lazy engine`
          : 'Device-native speech playback'
  const activeEngineName =
    engine === 'kokoro'
      ? 'Kokoro 82M'
      : engine === 'supertonic'
        ? 'Supertonic'
        : engine === 'kitten'
          ? 'KittenTTS'
          : engine === 'piper'
            ? 'Piper-plus'
            : 'Browser voices'
  const activeVoiceName =
    engine === 'kokoro'
      ? selectedVoice.name
      : engine === 'supertonic'
        ? selectedSupertonicVoice.name
        : engine === 'kitten'
          ? selectedKittenVoice.name
          : engine === 'piper'
            ? selectedPiperLanguage.label
            : browserVoices.find((voice) => voice.voiceURI === browserVoiceUri)?.name ?? 'Default voice'
  const activeSampleRate =
    engine === 'supertonic'
      ? `${(SUPERTONIC_SAMPLE_RATE / 1000).toFixed(1)} kHz`
      : engine === 'piper'
        ? `${(PIPER_PLUS_SAMPLE_RATE / 1000).toFixed(2)} kHz`
        : `${(KOKORO_SAMPLE_RATE / 1000).toFixed(0)} kHz`
  const outputFormatLabel =
    engine === 'browser'
      ? 'Live playback'
      : audioFormat === 'mp3'
        ? `MP3 - ${mp3Bitrate} kbps`
        : audioFormat === 'opus'
          ? 'Opus/WebM'
          : `WAV - ${activeSampleRate}`
  const captionModeLabel = wordTimestamps && englishKokoro ? 'Word-level captions' : engine === 'browser' ? 'Live only' : 'SRT + VTT'
  const editorModeLabel = dialogMode ? 'Dialog script' : separateLines ? 'Line export' : 'Single clip'
  const completedQueueChunks = queueJobs.reduce((total, job) => total + job.chunks.filter((chunk) => chunk.status === 'done').length, 0)
  const totalQueueChunks = queueJobs.reduce((total, job) => total + job.chunks.length, 0)
  const queueSummaryLabel = queueJobs.length > 0
    ? `${queueJobs.length} job${queueJobs.length === 1 ? '' : 's'} / ${completedQueueChunks}/${totalQueueChunks} chunks`
    : 'No queued jobs'
  const librarySummaryLabel = library.length > 0 ? `${library.length} saved clip${library.length === 1 ? '' : 's'}` : 'No saved clips'
  const cleanupSummary = Object.values(cleanup).some(Boolean) ? 'Cleanup on' : 'Cleanup off'
  const engineStatusTone = engine === 'kitten' && !kittenRuntimeReady ? 'warn' : 'ok'
  // Pitch shift only ever applies to the Kokoro export path — never promise it
  // for other engines.
  const speedSummary = engine === 'kokoro' && pitchSemitones !== 0
    ? `${speed.toFixed(2)}x / ${pitchSemitones > 0 ? `+${pitchSemitones}` : pitchSemitones} st`
    : `${speed.toFixed(2)}x`

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    // Keep the browser/PWA chrome color in sync — a light UI under a
    // near-black Android status bar reads as a theming bug.
    const chromeColor = window.getComputedStyle(document.documentElement).getPropertyValue('--bg-strong').trim()
    if (chromeColor) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', chromeColor)
    try { window.localStorage.setItem('bettertts-theme', theme) } catch { /* storage blocked */ }
  }, [theme])

  useEffect(() => {
    const syncActiveSection = () => {
      setActiveNavSection(getActiveNavSection())
      setActiveWorkspaceHash(window.location.hash.replace(/^#/, ''))
    }
    syncActiveSection()
    window.addEventListener('hashchange', syncActiveSection)
    return () => window.removeEventListener('hashchange', syncActiveSection)
  }, [])

  useEffect(() => {
    try { window.localStorage.setItem('bettertts-pronunciations', JSON.stringify(pronunciations)) } catch {}
  }, [pronunciations])

  useEffect(() => {
    try { window.localStorage.setItem('bettertts-cleanup', JSON.stringify(cleanup)) } catch {}
  }, [cleanup])

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPERIMENTAL_PIPER_STORAGE_KEY, experimentalPiperEnabled ? '1' : '0')
    } catch {}
    if (!experimentalPiperEnabled && engine === 'piper') setEngine('kokoro')
  }, [experimentalPiperEnabled, engine])

  useEffect(() => {
    if (forceNative) {
      setRuntimeLabel('Native ORT CPU q8')
    } else if (forceWasm) {
      setRuntimeLabel('WebAssembly q8')
    } else {
      probeWebGpu().then((hasGpu) => setRuntimeLabel(hasGpu ? 'WebGPU fp32' : 'WebAssembly q8'))
    }
  }, [forceWasm, forceNative])

  useEffect(() => {
    setSpeed((current) => {
      if (engine === 'supertonic') return clampSupertonicSpeed(current)
      if (engine === 'kitten') return clampKittenSpeed(current)
      return Math.min(1.5, Math.max(0.5, current))
    })
  }, [engine])

  useEffect(() => {
    refreshModelCacheStatus().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => installGlobalDiagnosticsCapture(), [])

  useEffect(() => {
    let cancelled = false
    checkM4bCapability()
      .then((capability) => {
        if (!cancelled) setM4bCapability(capability)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setM4bCapability({
            supported: false,
            reason: 'check-failed',
            message: err instanceof Error ? err.message : 'Could not verify M4B AAC support.',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!availableVoices.some((voice) => voice.id === voiceId)) {
      setVoiceId(availableVoices[0]?.id ?? 'af_heart')
    }
  }, [availableVoices, voiceId])

  useEffect(() => {
    if (!englishKokoro) {
      if (wordTimestamps) setWordTimestamps(false)
      if (voiceMixEnabled) setVoiceMixEnabled(false)
    }
  }, [englishKokoro, voiceMixEnabled, wordTimestamps])

  function refreshStorageEstimate() {
    navigator.storage
      ?.estimate?.()
      .then(({ usage, quota }) => {
        if (usage != null && quota != null && quota > 0) {
          setStorageEstimate(`${formatBytes(usage)} of ${formatBytes(quota)} used`)
          // Warn before the quota wall, not after saves start failing.
          if (usage / quota > 0.9 && !storagePressureWarnedRef.current) {
            storagePressureWarnedRef.current = true
            showToast({ tone: 'warn', message: `Storage is ${Math.round((usage / quota) * 100)}% full — new clips will evict the oldest saved ones.` })
          }
        }
      })
      .catch((err) => {
        recordDiagnosticEvent('warn', err, 'storage.estimate')
      })
  }

  async function refreshModelCacheStatus() {
    const summary = await readModelCacheStatus()
    setModelCache(summary)
    return summary
  }

  async function handlePrefetchKokoroPack() {
    if (isGenerating) return
    setCacheAction('prefetch-kokoro')
    try {
      const count = await prefetchKokoroQ8Pack(selectedVoice.id, (done, total, path) => {
        setStatus(`Prefetching Kokoro q8 pack (${done}/${total}) - ${path}`)
      })
      await refreshModelCacheStatus()
      refreshStorageEstimate()
      setStatus('Ready')
      showToast({ tone: 'ok', message: `Cached ${count} Kokoro q8 assets for ${selectedVoice.name}.` })
    } catch (err) {
      setStatus('Ready')
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'Kokoro prefetch failed.' })
    } finally {
      setCacheAction(null)
    }
  }

  async function handleClearModelCache(engineId: ModelCacheEngineId) {
    if (isGenerating) return
    setCacheAction(`clear-${engineId}`)
    try {
      const deleted = await clearModelCache(engineId)
      await refreshModelCacheStatus()
      refreshStorageEstimate()
      showToast({ tone: 'ok', message: deleted > 0 ? `Cleared ${deleted} cached ${engineId} entries.` : `No cached ${engineId} entries found.` })
    } catch (err) {
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'Could not clear cache entries.' })
    } finally {
      setCacheAction(null)
    }
  }

  function buildDiagnosticsSelection(): DiagnosticsSelection {
    const baseUrl = typeof location === 'undefined' ? 'https://sysadmindoc.github.io' : location.origin
    const normalizedBase = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`
    const modelRoutes: Record<string, string> = {
      kokoroModel: KOKORO_MODEL_ID,
      kokoroRemoteBase: KOKORO_HF_RESOLVE_PREFIX,
      kokoroLocalBase: new URL(`${normalizedBase}${KOKORO_LOCAL_MODEL_PREFIX}`, baseUrl).toString(),
      supertonicModel: SUPERTONIC_MODEL_ID,
      kittenPackage: 'kitten-tts-webgpu',
      piperPlusPackage: `piper-plus ${PIPER_PLUS_PACKAGE_VERSION}`,
      piperPlusModel: PIPER_PLUS_MODEL_ID,
    }

    if (engine === 'supertonic') modelRoutes.supertonicVoice = supertonicVoiceUrl(selectedSupertonicVoice.id)
    if (engine === 'kokoro') modelRoutes.kokoroVoice = selectedVoice.id
    if (engine === 'kitten') modelRoutes.kittenModel = selectedKittenModel.id
    if (engine === 'piper') modelRoutes.piperPlusLanguage = piperLanguage

    const nativeRuntime = nativeAvailable ? getNativeRuntimeInfo() : null
    if (nativeRuntime) {
      modelRoutes.nativeRuntime = `onnxruntime-node ${nativeRuntime.ortVersion} (${nativeRuntime.ep})`
      if (nativeRuntime.modelPack) {
        const pack = nativeRuntime.modelPack
        modelRoutes.nativeModelPack = `${pack.modelId}@${pack.revision.slice(0, 12)} · ${pack.license.spdx} · ${pack.verified ? 'verified' : pack.installed ? 'present (unverified)' : 'not installed'}`
      }
    }

    return {
      engine,
      engineStatus,
      runtime: runtimeLabel,
      voice: engine === 'kokoro'
        ? selectedVoice.id
        : engine === 'supertonic'
          ? selectedSupertonicVoice.id
          : engine === 'kitten'
            ? selectedKittenVoice.id
            : engine === 'piper'
              ? PIPER_PLUS_MODEL_LABEL
              : browserVoiceUri || 'browser-default',
      language: engine === 'kokoro' ? locale : engine === 'piper' ? piperLanguage : undefined,
      format: audioFormat,
      bitrate: mp3Bitrate,
      speed,
      selectedModel: engine === 'kokoro'
        ? `${KOKORO_MODEL_ID} (${kokoroRuntimeLabel})`
        : engine === 'supertonic'
          ? SUPERTONIC_MODEL_ID
          : engine === 'kitten'
            ? `kitten-tts-webgpu ${selectedKittenModel.id}`
            : engine === 'piper'
              ? `${PIPER_PLUS_MODEL_ID} via piper-plus ${PIPER_PLUS_PACKAGE_VERSION}`
              : 'Web Speech API',
      modelRoutes,
    }
  }

  async function buildDiagnosticsJson(): Promise<string> {
    const diagnostics = await collectDiagnostics({
      appVersion: APP_VERSION,
      selection: buildDiagnosticsSelection(),
    })
    return JSON.stringify(diagnostics, null, 2)
  }

  async function handleCopyDiagnostics() {
    if (diagnosticsAction) return
    setDiagnosticsAction('copy')
    try {
      await copyTextToClipboard(await buildDiagnosticsJson())
      showToast({ tone: 'ok', message: 'Diagnostics copied to clipboard.' })
    } catch (err) {
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'Could not copy diagnostics.' })
    } finally {
      setDiagnosticsAction(null)
    }
  }

  async function handleDownloadDiagnostics() {
    if (diagnosticsAction) return
    setDiagnosticsAction('download')
    try {
      const json = await buildDiagnosticsJson()
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `bettertts-diagnostics-${timestamp()}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      showToast({ tone: 'ok', message: 'Diagnostics JSON downloaded.' })
    } catch (err) {
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'Could not export diagnostics.' })
    } finally {
      setDiagnosticsAction(null)
    }
  }

  useEffect(() => {
    listClips().then(setLibrary).catch((error) => {
      recordDiagnosticEvent('error', error, 'library.initial-load')
      showToast({ tone: 'error', message: 'Saved clips could not be loaded. Reload BetterTTS; existing audio has not been removed.' })
    })
    listJobs().then((jobs) => {
      setQueueJobs(jobs)
      const incomplete = jobs.find((j) => j.chunks.some((c) => c.status === 'pending'))
      if (incomplete) {
        showToast({
          tone: 'ok',
          message: `"${incomplete.title}" is ${jobProgress(incomplete).pct}% complete and ready to resume.`,
          action: { label: 'Open queue', run: () => openWorkspacePanel('queue-panel') },
        })
      }
    }).catch((error) => {
      recordDiagnosticEvent('error', error, 'queue.initial-load')
      showToast({ tone: 'error', message: 'Queued jobs could not be loaded. Reload BetterTTS; existing jobs have not been removed.' })
    })
    refreshStorageEstimate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onUpdateReady = () =>
      showToast({
        tone: 'ok',
        message: 'A new version is ready. Saved clips and queued jobs will remain available.',
        action: { label: 'Refresh now', run: () => window.location.reload() },
      })
    window.addEventListener('bettertts-update-ready', onUpdateReady)
    return () => window.removeEventListener('bettertts-update-ready', onUpdateReady)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const load = () => setBrowserVoices(window.speechSynthesis.getVoices())
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const shell = document.querySelector('.app-shell')
    if (!shell) return
    const handler = (e: Event) => {
      const el = e.target as HTMLAudioElement
      if (el.tagName !== 'AUDIO') return
      const label = el.getAttribute('aria-label') ?? 'BetterTTS'
      navigator.mediaSession.metadata = new MediaMetadata({ title: label, artist: 'BetterTTS' })
      navigator.mediaSession.setActionHandler('play', () => el.play())
      navigator.mediaSession.setActionHandler('pause', () => el.pause())
    }
    shell.addEventListener('play', handler, true)
    return () => shell.removeEventListener('play', handler, true)
  }, [])

  useEffect(() => {
    const objectUrls = objectUrlsRef.current
    const previewCache = previewCacheRef.current
    return () => {
      for (const url of objectUrls) {
        URL.revokeObjectURL(url)
      }
      for (const url of previewCache.values()) {
        URL.revokeObjectURL(url)
      }
      previewCache.clear()
    }
  }, [])

  function rememberUrl(url: string) {
    objectUrlsRef.current.push(url)
    return url
  }

  function clearOutputs() {
    for (const url of objectUrlsRef.current) {
      URL.revokeObjectURL(url)
    }
    objectUrlsRef.current = []
    setResults([])
    setZipUrl(null)
  }

  function handleClearOutputs() {
    const hadOutputs = results.length > 0
    clearOutputs()
    showToast({
      tone: 'ok',
      message: hadOutputs ? 'Output list cleared.' : 'No generated output to clear.',
    })
  }

  function showToast(nextToast: Toast) {
    if (nextToast.tone === 'warn' || nextToast.tone === 'error') {
      recordDiagnosticEvent(nextToast.tone, nextToast.message, 'toast')
    }
    setToast(nextToast)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => {
      setToast((current) => (current?.message === nextToast.message ? null : current))
      toastTimerRef.current = null
    }, nextToast.action ? 8500 : 5500)
  }

  function openWorkspacePanel(target: typeof WORKSPACE_TABS[number][0]) {
    setActiveWorkspaceHash(target)
    setActiveNavSection('studio')
    window.history.replaceState(null, '', `#${target}`)
    window.requestAnimationFrame(() => {
      const panel = document.getElementById(target)
      panel?.scrollIntoView({ block: 'start' })
      panel?.focus({ preventScroll: true })
    })
  }

  async function runToastAction(action: NonNullable<Toast['action']>) {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current)
      toastTimerRef.current = null
    }
    setToast(null)
    try {
      await action.run()
    } catch {
      showToast({ tone: 'error', message: 'Could not restore the removed item.' })
    }
  }

  function applyPronunciations(input: string): string {
    const entries = Object.entries(pronunciations).filter(([word]) => word)
    if (entries.length === 0) return input
    const map = new Map(entries)
    // Single pass so one rule's output can never feed another rule; longest key
    // first so overlapping entries match greedily; word-bounded so "cat" -> "kat"
    // cannot corrupt "catalog".
    const pattern = entries
      .map(([word]) => word)
      .sort((a, b) => b.length - a.length)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')
    const re = new RegExp(`(?<!\\w)(?:${pattern})(?!\\w)`, 'g')
    return input.replace(re, (match) => map.get(match) ?? match)
  }

  async function buildResult(blob: Blob, label: string, filename: string, replayText?: string): Promise<AudioResult> {
    const url = replayText ? undefined : rememberUrl(URL.createObjectURL(blob))
    const duration = replayText ? 'playback' : await getDurationLabel(blob)

    return {
      id: crypto.randomUUID(),
      filename,
      label,
      duration,
      size: replayText ? 'native' : formatBytes(blob.size),
      url,
      replayText,
    }
  }

  type SynthJob = {
    text: string
    voice: string
    label: string
    filenamePrefix: string
    voiceBin?: Float32Array
  }

  type SynthesizedAudio = {
    samples: Float32Array
    sampleRate: number
    wordCues?: Omit<Cue, 'index'>[]
  }

  type LoadedEngine = {
    synthesize: (text: string, voice: string, speed: number, voiceBin?: Float32Array) => Promise<SynthesizedAudio | null>
  }

  type LoadedQueueEngine = LoadedEngine & {
    sampleRate: number
  }

  async function ensureKokoroEngine(
    onProgress: (info: ProgressInfo) => void,
    opts: { wordTimestamps?: boolean } = { wordTimestamps: wordTimestamps && englishKokoro },
  ): Promise<LoadedEngine> {
    if (opts.wordTimestamps) {
      const tts = await loadTimestampedKokoro(onProgress)
      setRuntimeLabel('WebAssembly q8 + word timestamps')
      return {
        synthesize: (text, voice, spd, bin) => synthesizeTimestampedKokoro(tts, text, voice, spd, bin),
      }
    }

    if (forceNative && nativeAvailable) {
      const runtime = await loadNativeKokoro(onProgress)
      const packSuffix = runtime.modelPack?.verified ? ' · verified pack' : ''
      setRuntimeLabel(`Native ORT ${runtime.ep.toUpperCase()} q8 · onnxruntime-node ${runtime.ortVersion}${packSuffix}`)
      return {
        synthesize: async (text, voice, spd, bin) => {
          if (needsDirectKokoroPath(voice, bin)) {
            // Blended and multilingual voices still route through the browser
            // runtime — the native host covers the standard English path first.
            await loadKokoroWorker('wasm', 'q8', onProgress)
            return { samples: await generateWorker(text, voice, spd, bin), sampleRate: KOKORO_SAMPLE_RATE }
          }
          try {
            return { samples: await generateNative(text, voice, spd), sampleRate: KOKORO_SAMPLE_RATE }
          } catch (err) {
            // A host crash fails only the in-flight chunk; the process respawns
            // lazily, so reload once and retry before surfacing the failure —
            // long queue runs self-heal instead of failing every later chunk.
            if (err instanceof Error && /crashed|not loaded/i.test(err.message)) {
              recordDiagnosticEvent('warn', err, 'native.synthesize-retry')
              await loadNativeKokoro(onProgress)
              return { samples: await generateNative(text, voice, spd), sampleRate: KOKORO_SAMPLE_RATE }
            }
            throw err
          }
        },
      }
    }

    const hasGpu = !forceWasm && (await probeWebGpu())
    if (useWorker) {
      try {
        await loadKokoroWorker(hasGpu ? 'webgpu' : 'wasm', hasGpu ? 'fp32' : 'q8', onProgress)
        setRuntimeLabel(hasGpu ? 'WebGPU fp32' : 'WebAssembly q8')
      } catch (err) {
        if (!hasGpu) throw err
        await loadKokoroWorker('wasm', 'q8', onProgress)
        setRuntimeLabel('WebAssembly q8')
      }
      return {
        synthesize: async (text, voice, spd, bin) => ({
          samples: await generateWorker(text, voice, spd, bin),
          sampleRate: KOKORO_SAMPLE_RATE,
        }),
      }
    }
    const tts = await loadKokoro(onProgress)
    return {
      synthesize: async (text, voice, spd, bin) => {
        if (needsDirectKokoroPath(voice, bin)) {
          const { synthesizeDirectKokoro } = await import('./lib/kokoro-multilingual.ts')
          return synthesizeDirectKokoro(tts, text, voice, spd, bin)
        }
        const audio = (await tts.generate(text, { voice: voice as never, speed: spd })) as RawAudioLike
        return audio.audio ? { samples: audio.audio, sampleRate: KOKORO_SAMPLE_RATE } : null
      },
    }
  }

  async function ensureEngine(onProgress: (info: ProgressInfo) => void): Promise<LoadedEngine> {
    if (engine === 'supertonic') {
      const tts = await loadSupertonic(onProgress)
      setRuntimeLabel('Supertonic fp32')
      return { synthesize: (text, voice, spd) => synthesizeSupertonic(tts, text, voice as SupertonicVoiceId, spd, supertonicSteps) }
    }
    if (engine === 'kitten') {
      setRuntimeLabel('KittenTTS WebGPU')
      return {
        synthesize: (text, voice, spd) =>
          synthesizeKitten(text, voice as KittenVoiceId, spd, kittenModelSize, (stage) => {
            setStatus(stage)
          }),
      }
    }
    if (engine === 'piper') {
      if (!piperPlusSupport.supported) throw new Error('Piper-plus requires WebAssembly and IndexedDB support in this browser.')
      const tts = await loadPiperPlus(onProgress)
      setRuntimeLabel(`Piper-plus ${PIPER_PLUS_PACKAGE_VERSION}`)
      return {
        synthesize: (text, _voice, spd) => synthesizePiperPlus(tts, text, piperLanguage, spd),
      }
    }
    return ensureKokoroEngine(onProgress)
  }

  async function ensureQueueEngine(job: QueueJob, onProgress: (info: ProgressInfo) => void): Promise<LoadedQueueEngine> {
    if (job.engine === 'supertonic') {
      const tts = await loadSupertonic(onProgress)
      setRuntimeLabel('Supertonic fp32')
      return {
        sampleRate: SUPERTONIC_SAMPLE_RATE,
        synthesize: (text, voice, spd) =>
          synthesizeSupertonic(tts, text, voice as SupertonicVoiceId, spd, job.supertonicSteps ?? SUPERTONIC_DEFAULT_STEPS),
      }
    }

    if (job.engine === 'kitten') {
      setRuntimeLabel('KittenTTS WebGPU')
      return {
        sampleRate: KITTEN_SAMPLE_RATE,
        synthesize: (text, voice, spd) =>
          synthesizeKitten(text, voice as KittenVoiceId, spd, job.kittenModel ?? KITTEN_DEFAULT_MODEL, (stage) => {
            setStatus(stage)
          }),
      }
    }

    return {
      sampleRate: KOKORO_SAMPLE_RATE,
      ...(await ensureKokoroEngine(onProgress, { wordTimestamps: false })),
    }
  }

  async function runSynthesis(jobs: SynthJob[], opts: { zipPrefix: string; successMessage?: string }) {
    const loadingLabel = engine === 'supertonic'
      ? 'Loading Supertonic model'
      : engine === 'kitten'
        ? 'Loading KittenTTS model'
        : engine === 'piper'
          ? 'Loading Piper-plus model'
          : 'Loading Kokoro model'
    setStatus(loadingLabel)
    setProgress(3)

    const fileTotals = new Map<string, { loaded: number; total: number }>()
    const onProgress = (info: { status?: string; name?: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
      if (info.status === 'progress_total' && typeof info.loaded === 'number' && typeof info.total === 'number') {
        const pct = info.total > 0 ? info.loaded / info.total : 0
        setStatus(`Downloading ${formatBytes(info.loaded)} / ${formatBytes(info.total)}`)
        setProgress(Math.min(35, Math.max(3, Math.round(pct * 35))))
      } else if (info.status === 'progress' && info.file && typeof info.loaded === 'number' && typeof info.total === 'number') {
        fileTotals.set(info.file, { loaded: info.loaded, total: info.total })
        let sumLoaded = 0
        let sumTotal = 0
        for (const v of fileTotals.values()) {
          sumLoaded += v.loaded
          sumTotal += v.total
        }
        const pct = sumTotal > 0 ? sumLoaded / sumTotal : 0
        setStatus(`Downloading ${formatBytes(sumLoaded)} / ${formatBytes(sumTotal)}`)
        setProgress(Math.min(35, Math.max(3, Math.round(pct * 35))))
      } else if (info.status === 'ready') {
        setStatus('Model ready')
        setProgress(35)
      } else if (info.name || info.file || info.status) {
        setStatus(info.name ?? info.file ?? info.status ?? loadingLabel)
        if (typeof info.progress === 'number') setProgress(Math.min(35, Math.max(3, Math.round(info.progress * 35))))
      }
    }

    const { synthesize } = await ensureEngine(onProgress)
    refreshModelCacheStatus().catch(() => {})

    if (abortRef.current) {
      setStatus('Cancelled')
      showToast({ tone: 'warn', message: 'Generation cancelled.' })
      return
    }

    setStatus('Generating local audio')
    const genStart = performance.now()
    let totalSamples = 0
    const outputSampleRate = engine === 'supertonic'
      ? SUPERTONIC_SAMPLE_RATE
      : engine === 'kitten'
        ? KITTEN_SAMPLE_RATE
        : engine === 'piper'
          ? PIPER_PLUS_SAMPLE_RATE
          : KOKORO_SAMPLE_RATE
    let totalChars = 0
    const generated: AudioResult[] = []
    const zipFiles: Record<string, Blob> = {}
    let clearedPrevious = false
    let warnedBgmEmpty = false
    let warnedQuota = false

    let audioCtx: AudioContext | null = null
    let nextPlayTime = 0
    if (streamPlay) {
      audioCtx = new AudioContext({ sampleRate: outputSampleRate })
      nextPlayTime = audioCtx.currentTime + 0.05
    }
    let streamCloseScheduled = false
    const closeStreamContext = (delayMs = 0) => {
      if (!audioCtx || streamCloseScheduled) return
      const ctx = audioCtx
      audioCtx = null
      streamCloseScheduled = true
      if (delayMs <= 0) {
        ctx.close().catch(() => {})
        return
      }
      setTimeout(() => {
        ctx.close().catch(() => {})
      }, delayMs)
    }

    try {
    const jobPlans = jobs.map((job) => {
      const segments = parsePauseTags(job.text)
      return segments.map((seg) =>
        seg.type === 'pause' ? seg : { ...seg, sentences: splitIntoSentences(seg.content) },
      )
    })
    let totalSentences = 0
    for (const plan of jobPlans) {
      for (const seg of plan) if (seg.type === 'text') totalSentences += seg.sentences.length
    }
    let done = 0
    let flaggedSentences = 0

    for (let index = 0; index < jobs.length; index += 1) {
      if (abortRef.current) break
      const job = jobs[index]
      const plan = jobPlans[index]
      const audioParts: Float32Array[] = []
      const cues: Cue[] = []
      let sampleOffset = 0
      let cueIndex = 1

      for (const seg of plan) {
        if (abortRef.current) break
        if (seg.type === 'pause') {
          const silence = new Float32Array(Math.round(seg.duration * outputSampleRate))
          audioParts.push(silence)
          totalSamples += silence.length
          sampleOffset += silence.length
          continue
        }
        for (const sentence of seg.sentences) {
          if (abortRef.current) break
          const audio = await synthesize(applyPronunciations(sentence), job.voice, speed, job.voiceBin)
          if (audio) {
            if (audio.sampleRate !== outputSampleRate) throw new Error('Generated chunks used mixed sample rates.')
            const completeness = checkSynthesisCompleteness(sentence, audio.samples.length / outputSampleRate, speed)
            if (completeness.suspect) {
              flaggedSentences += 1
              recordDiagnosticEvent(
                'warn',
                `Possible truncation: ${completeness.speakableChars} speakable chars produced ${(audio.samples.length / outputSampleRate).toFixed(1)}s of audio (floor ${completeness.minExpectedSeconds.toFixed(1)}s).`,
                'synthesis.completeness',
              )
            }
            audioParts.push(audio.samples)
            totalSamples += audio.samples.length
            totalChars += sentence.length
            const startSec = sampleOffset / outputSampleRate
            sampleOffset += audio.samples.length
            const endSec = sampleOffset / outputSampleRate
            if (audio.wordCues?.length) {
              for (const cue of audio.wordCues) {
                const wordStart = Math.max(startSec, Math.min(endSec, startSec + cue.startSec))
                const wordEnd = Math.max(wordStart, Math.min(endSec, startSec + cue.endSec))
                if (wordEnd > wordStart) cues.push({ index: cueIndex++, startSec: wordStart, endSec: wordEnd, text: cue.text })
              }
            } else {
              cues.push({ index: cueIndex++, startSec, endSec, text: sentence })
            }
            if (audioCtx) {
              const buf = audioCtx.createBuffer(1, audio.samples.length, outputSampleRate)
              buf.getChannelData(0).set(audio.samples)
              const src = audioCtx.createBufferSource()
              src.buffer = buf
              src.connect(audioCtx.destination)
              src.start(nextPlayTime)
              nextPlayTime = Math.max(nextPlayTime, audioCtx.currentTime) + buf.duration
            }
          } else if (!abortRef.current) {
            // A null return silently drops the sentence from the output — the
            // exact truncation class the completeness check exists to catch.
            flaggedSentences += 1
            recordDiagnosticEvent('warn', `Engine produced no audio for a ${sentence.length}-char sentence — it is missing from the output.`, 'synthesis.completeness')
          }
          done++
          if (totalSentences > 0) {
            setProgress(35 + Math.round((done / totalSentences) * 55))
            setStatus(`Generated ${done} / ${totalSentences}`)
          }
        }
      }

      if (abortRef.current && audioParts.length === 0) break

      if (!clearedPrevious) {
        clearOutputs()
        clearedPrevious = true
      }

      const raw = concatFloat32Arrays(audioParts)
      let processed = engine === 'kokoro' && pitchSemitones !== 0 ? await shiftPitch(raw, pitchSemitones, outputSampleRate) : raw
      if (engine === 'kokoro' && bgmFile) {
        const { mixed, bgmEmpty } = await mixBgm(processed, bgmFile, bgmVolume, outputSampleRate)
        processed = mixed
        if (bgmEmpty && !warnedBgmEmpty) {
          warnedBgmEmpty = true
          showToast({ tone: 'warn', message: 'Background music file contained no audio — exported speech only.' })
        }
      }
      const ext = formatExtension(audioFormat)
      const blob = await encodeAudio(processed, outputSampleRate, audioFormat, mp3Bitrate)
      const filename = `${job.filenamePrefix}-${timestamp()}${ext}`
      const result = await buildResult(blob, job.label, filename)
      if (cues.length > 0) {
        result.cues = cues
        result.srtUrl = rememberUrl(URL.createObjectURL(new Blob([toSRT(cues)], { type: 'text/plain' })))
        result.vttUrl = rememberUrl(URL.createObjectURL(new Blob([toVTT(cues)], { type: 'text/vtt' })))
      }

      generated.push(result)
      zipFiles[filename] = blob
      setResults([...generated])
      const clipRecord: ClipRecord = { id: result.id, filename, label: result.label, voice: job.voice, speed, createdAt: Date.now(), size: blob.size, duration: result.duration, cues: result.cues }
      saveClip(clipRecord, blob)
        .then(() => enforceLibraryCap())
        .catch(async (err: unknown) => {
          if (err instanceof DOMException && err.name === 'QuotaExceededError') {
            // Recover instead of failing silently: evict oldest clips to make
            // room, then retry this save once.
            try {
              const { evicted } = await freeLibrarySpace(Math.max(blob.size * 2, 32 * 1024 * 1024))
              if (evicted > 0) {
                await saveClip(clipRecord, blob)
                listClips().then(setLibrary).catch(() => {})
                showToast({ tone: 'warn', message: `Storage was full — freed ${evicted} old clip${evicted === 1 ? '' : 's'} to save this one.` })
                return
              }
            } catch (recoveryErr) {
              recordDiagnosticEvent('warn', recoveryErr, 'library.quota-recovery')
            }
            if (!warnedQuota) {
              warnedQuota = true
              showToast({ tone: 'error', message: 'Storage is full and nothing could be freed — clip not saved. Export it manually and clear space.' })
            }
          } else {
            recordDiagnosticEvent('warn', err, 'library.save')
          }
        })
    }

    if (audioCtx) {
      closeStreamContext(abortRef.current ? 0 : Math.max(0, (nextPlayTime - audioCtx.currentTime) * 1000) + 200)
    }

    if (generated.length > 1) {
      const { zip } = await import('fflate')
      const entries: Record<string, Uint8Array> = {}
      for (const [filename, blob] of Object.entries(zipFiles)) {
        entries[filename] = new Uint8Array(await blob.arrayBuffer())
      }
      // level 0: WAV/MP3 payloads don't deflate; storing keeps exports instant.
      const zipped = await new Promise<Uint8Array>((resolve, reject) => {
        zip(entries, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data)))
      })
      const zipBlob = new Blob([zipped as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
      setZipUrl(rememberUrl(URL.createObjectURL(zipBlob)))
      setZipName(`${opts.zipPrefix}-${timestamp()}.zip`)
    }

    setProgress(100)
    if (generated.length > 0) {
      refreshModelCacheStatus().catch(() => {})
      if (!persistRequestedRef.current) {
        // Ask the browser to exempt our storage (model cache + clip library)
        // from automatic eviction; Safari ITP purges unpersisted origins.
        persistRequestedRef.current = true
        navigator.storage?.persist?.()
          .then((granted) => {
            if (granted === false) {
              recordDiagnosticEvent('warn', 'Persistent storage was declined — cached models and clips may be evicted under storage pressure.', 'storage.persist')
            }
          })
          .catch((err) => {
            recordDiagnosticEvent('warn', err, 'storage.persist')
          })
      }
    }
    listClips().then(setLibrary).catch(() => {})
    refreshStorageEstimate()
    const elapsed = (performance.now() - genStart) / 1000
    const audioDuration = totalSamples / outputSampleRate
    setGenStats({ elapsed, chars: totalChars, audioDuration })
    if (abortRef.current) {
      setStatus(generated.length > 0 ? 'Cancelled — partial output kept' : 'Cancelled')
      showToast({ tone: 'warn', message: 'Generation cancelled.' })
    } else if (flaggedSentences > 0) {
      setStatus('Local audio ready — completeness check flagged output')
      showToast({ tone: 'warn', message: `Audio ready, but ${flaggedSentences} sentence${flaggedSentences === 1 ? ' was' : 's were'} flagged as possibly truncated or missing — details in Diagnostics.` })
    } else {
      setStatus('Local audio ready')
      showToast({ tone: 'ok', message: opts.successMessage ?? 'Audio generated locally on this device.' })
    }
    if (!abortRef.current && generated.length > 0) {
      // Land keyboard/screen-reader focus on the fresh results instead of
      // leaving it stranded on the Generate button.
      outputPanelRef.current?.focus()
    }
    } finally {
      closeStreamContext()
    }
  }

  async function generateKokoro(chunks: string[]) {
    let mixBin: Float32Array | undefined
    if (englishKokoro && voiceMixEnabled && voiceMixEntries.length >= 2) {
      setStatus('Loading voice blend…')
      const bins = await Promise.all(
        voiceMixEntries.map(async (e) => ({
          data: await fetchVoiceBin(e.voiceId),
          weight: e.weight,
        })),
      )
      mixBin = blendVoiceBins(bins)
    }

    const jobs: SynthJob[] = chunks.map((chunk, index) => ({
      text: chunk,
      voice: selectedVoice.id,
      label: chunk.slice(0, 64),
      filenamePrefix: chunks.length === 1 ? slugify(chunk) : `${String(index + 1).padStart(3, '0')}-${slugify(chunk)}`,
      voiceBin: mixBin,
    }))
    await runSynthesis(jobs, { zipPrefix: 'bettertts' })
  }

  async function generateSupertonic(chunks: string[]) {
    const jobs: SynthJob[] = chunks.map((chunk, index) => ({
      text: chunk,
      voice: supertonicVoiceId,
      label: `${selectedSupertonicVoice.name}: ${chunk.slice(0, 56)}`,
      filenamePrefix: chunks.length === 1 ? slugify(chunk) : `${String(index + 1).padStart(3, '0')}-${slugify(chunk)}`,
    }))
    await runSynthesis(jobs, { zipPrefix: 'bettertts-supertonic', successMessage: 'Supertonic audio generated locally.' })
  }

  async function generateKitten(chunks: string[]) {
    const jobs: SynthJob[] = chunks.map((chunk, index) => ({
      text: chunk,
      voice: kittenVoiceId,
      label: `${selectedKittenVoice.name}: ${chunk.slice(0, 56)}`,
      filenamePrefix: chunks.length === 1 ? slugify(chunk) : `${String(index + 1).padStart(3, '0')}-${slugify(chunk)}`,
    }))
    await runSynthesis(jobs, {
      zipPrefix: 'bettertts-kitten',
      successMessage: `${selectedKittenModel.label} KittenTTS audio generated locally.`,
    })
  }

  async function generatePiperPlus(chunks: string[]) {
    const jobs: SynthJob[] = chunks.map((chunk, index) => ({
      text: chunk,
      voice: piperLanguage,
      label: `${PIPER_PLUS_MODEL_LABEL} ${selectedPiperLanguage.label}: ${chunk.slice(0, 48)}`,
      filenamePrefix: chunks.length === 1 ? slugify(chunk) : `${String(index + 1).padStart(3, '0')}-${slugify(chunk)}`,
    }))
    await runSynthesis(jobs, {
      zipPrefix: 'bettertts-piper',
      successMessage: 'Experimental Piper-plus audio generated locally.',
    })
  }

  async function generateBrowser(chunks: string[]) {
    // Drop the previous run's results and ZIP link — a stale "Download all
    // ZIP" must never render under the new browser-playback row.
    clearOutputs()
    setStatus('Starting browser speech')
    setProgress(5)
    const cleanText = chunks.join('\n\n').replace(PAUSE_TAG, ' ')
    const chosenVoice = browserVoices.find((v) => v.voiceURI === browserVoiceUri)
    await speakBrowser(cleanText, speed, chosenVoice, () => abortRef.current)
    if (abortRef.current) {
      setProgress(100)
      setStatus('Cancelled')
      showToast({ tone: 'warn', message: 'Browser playback cancelled.' })
      return
    }
    const markerBlob = new Blob([cleanText], { type: 'text/plain' })
    const result = await buildResult(markerBlob, 'Browser speech playback', 'browser-playback.txt', cleanText)

    setResults([result])
    setProgress(100)
    setStatus('Browser playback complete')
    showToast({
      tone: 'warn',
      message: 'Browser fallback can play speech but cannot export WAV files.',
    })
  }

  async function generateDialog(sourceText: string) {
    const lines = parseDialogLines(sourceText)
    if (lines.length === 0) return

    const unmapped = new Set<string>()
    const jobs: SynthJob[] = lines.map((line, i) => {
      const mappedVoiceId = line.speaker ? (speakerMap[line.speaker] || null) : null
      if (line.speaker && !mappedVoiceId) unmapped.add(line.speaker)
      return {
        text: line.text,
        voice: mappedVoiceId ?? selectedVoice.id,
        label: `${line.speaker ? `[${line.speaker}] ` : ''}${line.text.slice(0, 50)}`,
        filenamePrefix: `${String(i + 1).padStart(3, '0')}-${line.speaker ? slugify(line.speaker) : 'line'}-${slugify(line.text)}`,
      }
    })

    await runSynthesis(jobs, { zipPrefix: 'bettertts-dialog', successMessage: 'Dialog generated.' })
    if (unmapped.size > 0 && !abortRef.current) {
      showToast({ tone: 'warn', message: `Unmapped speakers used default voice: ${[...unmapped].join(', ')}` })
    }
  }

  async function handleGenerate() {
    if (generatingRef.current) return
    const effectiveDialog = dialogMode && engine === 'kokoro'
    const sourceText = cleanupText(usableText, cleanup)
    const chunks = effectiveDialog ? [] : splitInput(sourceText, separateLines)

    if (!effectiveDialog && chunks.length === 0) {
      showToast({ tone: 'warn', message: 'Enter text before generating audio.' })
      return
    }
    if (effectiveDialog && parseDialogLines(sourceText).length === 0) {
      showToast({ tone: 'warn', message: 'Enter text with [speaker:Name] prefixes.' })
      return
    }

    if (overLimit) {
      showToast({
        tone: 'warn',
        message: `Text exceeds ${MAX_TEXT_CHARS} characters — the last ${text.length - MAX_TEXT_CHARS} characters will be dropped.`,
      })
    }

    if (isSpeaking && 'speechSynthesis' in window) window.speechSynthesis.cancel()
    setIsSpeaking(false)
    clearProgressResetTimer()
    abortRef.current = false
    setGenStats(null)
    generatingRef.current = true
    setIsGenerating(true)

    try {
      if (effectiveDialog) {
        await generateDialog(sourceText)
      } else if (engine === 'kokoro') {
        await generateKokoro(chunks)
      } else if (engine === 'supertonic') {
        await generateSupertonic(chunks)
      } else if (engine === 'kitten') {
        await generateKitten(chunks)
      } else if (engine === 'piper') {
        await generatePiperPlus(chunks)
      } else {
        await generateBrowser(chunks)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Generation failed.'
      setStatus('Generation failed')
      showToast({ tone: 'error', message })
      console.error(error)
    } finally {
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current)
      progressTimerRef.current = setTimeout(() => {
        setProgress(null)
        progressTimerRef.current = null
      }, 700)
      generatingRef.current = false
      setIsGenerating(false)
    }
  }

  function cancelGeneration() {
    abortRef.current = true
    setStatus('Cancelling…')
  }

  async function previewVoice(id: string, sampleText = kokoroLanguageForVoice(id).previewText) {
    if (previewingVoice || isGenerating) return
    setPreviewingVoice(id)
    try {
      const cached = previewCacheRef.current.get(id)
      if (cached) {
        const audio = new Audio(cached)
        await audio.play()
        setPreviewingVoice(null)
        return
      }
      const engineImpl = await ensureEngine(() => {})
      const preview = await engineImpl.synthesize(sampleText, id, 1)
      if (preview) {
        const blob = new Blob([encodeWav(preview.samples, preview.sampleRate)], { type: 'audio/wav' })
        const url = URL.createObjectURL(blob)
        previewCacheRef.current.set(id, url)
        const player = new Audio(url)
        await player.play()
        refreshModelCacheStatus().catch(() => {})
      }
    } catch (err) {
      // Report the real failure — "load the model first" hid OOM/network/WASM
      // errors behind a misleading hint.
      recordDiagnosticEvent('warn', err, 'voice.preview')
      const detail = err instanceof Error && err.message ? shortUiLabel(err.message, 90) : ''
      showToast({ tone: 'warn', message: detail ? `Preview failed: ${detail}` : 'Preview failed — try loading the model with Generate first.' })
    } finally {
      setPreviewingVoice(null)
    }
  }

  async function replayBrowser(textToReplay: string) {
    if (isGenerating) return
    setIsSpeaking(true)
    try {
      const chosenVoice = browserVoices.find((v) => v.voiceURI === browserVoiceUri)
      await speakBrowser(textToReplay.replace(PAUSE_TAG, ' '), speed, chosenVoice)
    } catch (error) {
      showToast({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Browser playback failed.',
      })
    } finally {
      setIsSpeaking(false)
    }
  }

  async function shareResult(result: AudioResult) {
    if (!result.url || !navigator.canShare) return
    try {
      const res = await fetch(result.url)
      const blob = await res.blob()
      const file = new File([blob], result.filename, {
        type: formatMime(formatFromFilename(result.filename)),
      })
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: result.label })
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        showToast({ tone: 'warn', message: 'Share cancelled or unavailable.' })
      }
    }
  }

  async function saveWithPicker(result: AudioResult) {
    if (!result.url) return
    let writable: FileSystemWritableFileStream | null = null
    try {
      const ext = result.filename.slice(result.filename.lastIndexOf('.'))
      const typeMap: Record<string, { description: string; accept: Record<string, string[]> }> = {
        '.mp3': { description: 'MP3 Audio', accept: { 'audio/mpeg': ['.mp3'] } },
        '.webm': { description: 'Opus Audio', accept: { 'audio/webm': ['.webm'] } },
        '.wav': { description: 'WAV Audio', accept: { 'audio/wav': ['.wav'] } },
      }
      const picker = window as unknown as { showSaveFilePicker(opts: unknown): Promise<FileSystemFileHandle> }
      const handle = await picker.showSaveFilePicker({
        suggestedName: result.filename,
        types: [typeMap[ext] ?? typeMap['.wav']],
      })
      writable = await handle.createWritable()
      const res = await fetch(result.url)
      const blob = await res.blob()
      await writable.write(blob)
      await writable.close()
      writable = null
      showToast({ tone: 'ok', message: `Saved ${result.filename}` })
    } catch (err) {
      if (writable) {
        try {
          await writable.close()
        } catch { /* discard partial native-save handle */ }
      }
      if (err instanceof Error && err.name !== 'AbortError') {
        showToast({ tone: 'warn', message: err.name === 'NotAllowedError' ? 'Save cancelled.' : 'Could not save this audio file.' })
      }
    }
  }

  async function importFromUrl(rawUrl: string) {
    const url = rawUrl.trim()
    if (!url || importingUrl) return
    setImportingUrl(true)
    setStatus('Fetching article…')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), ARTICLE_IMPORT_TIMEOUT_MS)
    try {
      const target = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
      if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('Unsupported protocol')
      const res = await fetch(target.toString(), { mode: 'cors', signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const html = await readArticleResponseText(res)
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const { Readability } = await import('@mozilla/readability')
      const article = new Readability(doc).parse()
      const textContent = (article?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
      if (!textContent) throw new Error('No readable text found')
      const truncated = textContent.length > MAX_TEXT_CHARS
      setText(textContent.slice(0, MAX_TEXT_CHARS))
      setImportUrlValue('')
      const title = shortUiLabel(article?.title ?? 'article')
      showToast(
        truncated
          ? { tone: 'warn', message: `Imported "${title}" — trimmed to ${MAX_TEXT_CHARS} characters.` }
          : { tone: 'ok', message: `Imported "${title}".` },
      )
    } catch (err) {
      // Tell the user what actually failed — timeout, HTTP status, unreadable
      // page, and CORS blocks are different problems with different fixes.
      recordDiagnosticEvent('warn', err, 'article.import')
      let message = 'Could not read that page — most sites block cross-origin reads. Paste the article text instead.'
      if (err instanceof DOMException && err.name === 'AbortError') {
        message = 'Article import timed out. Paste the text instead.'
      } else if (err instanceof Error && /^HTTP \d+$/.test(err.message)) {
        message = `The site answered ${err.message} for that URL. Check the address or paste the text instead.`
      } else if (err instanceof Error && err.message === 'No readable text found') {
        message = 'No readable article text found on that page. Paste the text instead.'
      } else if (err instanceof Error && (err.message === 'Unsupported protocol' || err instanceof TypeError && /Invalid URL/i.test(err.message))) {
        message = 'That does not look like a valid http(s) URL.'
      }
      showToast({ tone: 'warn', message })
    } finally {
      window.clearTimeout(timeout)
      setImportingUrl(false)
      setStatus('Ready')
    }
  }

  useEffect(() => {
    // PWA share target: Android shares land here as ?url= / ?text= params.
    const params = new URLSearchParams(window.location.search)
    const explicitUrl = params.get('url')
    const sharedText = params.get('text')
    const urlFromText = sharedText?.match(/https?:\/\/\S+/)?.[0] ?? null
    const sharedUrl = explicitUrl || urlFromText
    if (sharedUrl) {
      importFromUrl(sharedUrl)
    } else if (sharedText) {
      setText(sharedText.slice(0, MAX_TEXT_CHARS))
    }
    if (sharedUrl || sharedText) {
      window.history.replaceState(null, '', window.location.pathname)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function createQueueJob(title: string, chunks: QueueSourceChunk[]): QueueJob | null {
    if (!engineQueueable(engine)) return null
    const queueEngine = engine as QueueEngine
    return {
      schemaVersion: 2,
      id: crypto.randomUUID(),
      title,
      createdAt: Date.now(),
      engine: queueEngine,
      voice: queueEngine === 'kokoro'
        ? selectedVoice.id
        : queueEngine === 'supertonic'
          ? selectedSupertonicVoice.id
          : selectedKittenVoice.id,
      language: queueEngine === 'kokoro' ? locale : undefined,
      speed,
      format: audioFormat,
      bitrate: mp3Bitrate,
      supertonicSteps: queueEngine === 'supertonic' ? supertonicSteps : undefined,
      kittenModel: queueEngine === 'kitten' ? kittenModelSize : undefined,
      chunks: chunks.map((chunk, index) => ({
        index,
        text: chunk.text,
        chapterTitle: chunk.chapterTitle,
        chapterIndex: chunk.chapterIndex,
        status: 'pending',
      })),
    }
  }

  async function queueCurrentText() {
    if (!usableText.trim()) return
    const chunks = splitInput(cleanupText(usableText, cleanup), separateLines)
    if (chunks.length === 0) return
    const job = createQueueJob(
      usableText.slice(0, 50).replace(/\s+/g, ' ').trim(),
      chunks.map((text) => ({ text })),
    )
    if (!job) {
      showToast({ tone: 'warn', message: queueDisabledReason ?? 'This engine cannot be queued for file export.' })
      return
    }
    try {
      await saveJob(job)
    } catch {
      showToast({ tone: 'error', message: 'Could not save the job to the queue — storage may be full or blocked.' })
      return
    }
    setQueueJobs((prev) => [job, ...prev])
    showToast({ tone: 'ok', message: `Queued "${job.title}" — ${job.chunks.length} chunks.` })
  }

  async function synthesizeQueueChunkBlob(
    job: QueueJob,
    text: string,
    synthesize: LoadedQueueEngine['synthesize'],
    sampleRate: number,
  ): Promise<{ blob: Blob; duration: string; cues?: Cue[]; warning?: string } | null> {
    const sentences = splitIntoSentences(applyPronunciations(text))
    const parts: Float32Array[] = []
    const cues: Cue[] = []
    let sampleOffset = 0
    let cueIndex = 1
    let aborted = false
    let flagged = 0
    for (const sentence of sentences) {
      if (abortRef.current) {
        aborted = true
        break
      }
      const audio = await synthesize(sentence, job.voice, job.speed)
      if (audio) {
        if (checkSynthesisCompleteness(sentence, audio.samples.length / sampleRate, job.speed).suspect) flagged += 1
        const startSec = sampleOffset / sampleRate
        parts.push(audio.samples)
        sampleOffset += audio.samples.length
        const endSec = sampleOffset / sampleRate
        if (audio.wordCues?.length) {
          for (const cue of audio.wordCues) {
            const wordStart = Math.max(startSec, Math.min(endSec, startSec + cue.startSec))
            const wordEnd = Math.max(wordStart, Math.min(endSec, startSec + cue.endSec))
            if (wordEnd > wordStart) cues.push({ index: cueIndex++, startSec: wordStart, endSec: wordEnd, text: cue.text })
          }
        } else {
          cues.push({ index: cueIndex++, startSec, endSec, text: sentence })
        }
      } else {
        flagged += 1
      }
    }
    // A pause/cancel mid-chunk must never be checkpointed: a partial blob saved
    // as 'done' would silently truncate the chapter in every later export.
    if (aborted) return null
    if (parts.length === 0) throw new Error('No audio produced')
    const raw = concatFloat32Arrays(parts)
    return {
      blob: await encodeAudio(raw, sampleRate, job.format, job.bitrate),
      duration: `${(raw.length / sampleRate).toFixed(1)}s`,
      cues: cues.length > 0 ? cues : undefined,
      warning: flagged > 0
        ? `${flagged} of ${sentences.length} sentence${sentences.length === 1 ? '' : 's'} flagged as possibly truncated or missing`
        : undefined,
    }
  }

  async function resumeJob(jobId: string) {
    if (generatingRef.current) return
    const jobs = await listJobs()
    const job = jobs.find((j) => j.id === jobId)
    if (!job) return

    generatingRef.current = true
    setIsGenerating(true)
    setActiveJobId(jobId)
    clearProgressResetTimer()
    abortRef.current = false

    try {
      const onProgress = (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (info.status === 'ready') setStatus('Model ready')
      }
      const { synthesize, sampleRate } = await ensureQueueEngine(job, onProgress)

      for (const chunk of job.chunks) {
        if (abortRef.current) break
        if (chunk.status === 'done') continue
        chunk.status = 'generating'
        await saveJob(job)
        setQueueJobs((prev) => prev.map((j) => (j.id === jobId ? { ...job } : j)))

        try {
          const replacement = await synthesizeQueueChunkBlob(job, chunk.text, synthesize, sampleRate)
          if (!replacement) {
            chunk.status = 'pending'
          } else {
            await saveChunkBlob(jobId, chunk.index, replacement.blob)
            chunk.duration = replacement.duration
            chunk.cues = replacement.cues
            chunk.warning = replacement.warning
            chunk.status = 'done'
          }
        } catch (err) {
          chunk.status = 'failed'
          chunk.error = err instanceof Error ? err.message : 'Failed'
        }
        await saveJob(job)
        setQueueJobs((prev) => prev.map((j) => (j.id === jobId ? { ...job } : j)))
        const { pct } = jobProgress(job)
        setStatus(`Queue: ${pct}% done`)
        setProgress(pct)
      }

      if (abortRef.current) {
        showToast({ tone: 'warn', message: 'Queue paused — resume anytime.' })
      } else {
        showToast({ tone: 'ok', message: `Job "${job.title}" complete.` })
      }
    } catch (err) {
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'The queue run failed.' })
    } finally {
      generatingRef.current = false
      setIsGenerating(false)
      setActiveJobId(null)
      setProgress(null)
      setStatus('Ready')
    }
  }

  async function regenerateQueueChunk(jobId: string, chunkIndex: number, nextText: string, nextTitle?: string): Promise<boolean> {
    if (generatingRef.current || regeneratingChunkKey) {
      showToast({ tone: 'warn', message: 'Another generation is running — your edit is kept, try again when it finishes.' })
      return false
    }
    const cleanText = nextText.trim()
    if (!cleanText) {
      showToast({ tone: 'warn', message: 'Segment text cannot be empty.' })
      return false
    }

    const chunkKey = `${jobId}:${chunkIndex}`
    const currentJob = queueJobs.find((job) => job.id === jobId)
    const currentChunk = currentJob?.chunks.find((chunk) => chunk.index === chunkIndex)
    if (!currentJob || !currentChunk) {
      showToast({ tone: 'error', message: 'This queue segment no longer exists.' })
      return false
    }
    const chapterTitle = nextTitle?.trim() || undefined

    if (cleanText === currentChunk.text) {
      const nextJob = replaceQueueChunk(currentJob, chunkIndex, {
        text: cleanText,
        status: currentChunk.status,
        chapterTitle,
        chapterIndex: currentChunk.chapterIndex,
        duration: currentChunk.duration,
        cues: currentChunk.cues,
      })
      await saveJob(nextJob)
      setQueueJobs((prev) => prev.map((job) => (job.id === jobId ? nextJob : job)))
      showToast({ tone: 'ok', message: 'Chapter metadata updated.' })
      return true
    }

    generatingRef.current = true
    setIsGenerating(true)
    setRegeneratingChunkKey(chunkKey)
    setActiveJobId(jobId)
    clearProgressResetTimer()
    abortRef.current = false
    setStatus(`Regenerating chunk ${chunkIndex + 1}`)
    setProgress(5)

    try {
      const jobs = await listJobs()
      const job = jobs.find((j) => j.id === jobId)
      const chunk = job?.chunks.find((c) => c.index === chunkIndex)
      if (!job || !chunk) throw new Error('Queue chunk was removed.')
      const onProgress = (info: { status?: string }) => {
        if (info.status === 'ready') setStatus('Model ready')
      }
      const { synthesize, sampleRate } = await ensureQueueEngine(job, onProgress)
      const replacement = await synthesizeQueueChunkBlob(job, cleanText, synthesize, sampleRate)
      if (!replacement) {
        showToast({ tone: 'warn', message: `Regeneration cancelled — chunk ${chunkIndex + 1} kept its previous audio.` })
        return false
      }
      await saveChunkBlob(jobId, chunkIndex, replacement.blob)
      const nextJob = replaceQueueChunk(job, chunkIndex, {
        text: cleanText,
        status: 'done',
        chapterTitle,
        chapterIndex: chunk.chapterIndex,
        duration: replacement.duration,
        cues: replacement.cues,
      })
      await saveJob(nextJob)
      setQueueJobs((prev) => prev.map((item) => (item.id === jobId ? nextJob : item)))
      setProgress(100)
      showToast({ tone: 'ok', message: `Chunk ${chunkIndex + 1} regenerated. ZIP/M4B exports will use the replacement audio.` })
      return true
    } catch (err) {
      showToast({ tone: 'error', message: err instanceof Error ? `${err.message} Old audio kept.` : 'Regeneration failed. Old audio kept.' })
      return false
    } finally {
      generatingRef.current = false
      setIsGenerating(false)
      setRegeneratingChunkKey(null)
      setActiveJobId(null)
      setProgress(null)
      setStatus('Ready')
    }
  }

  async function downloadJobZip(jobId: string) {
    // Exports share the status/progress channel with generation — never let
    // the two interleave, and never build two ZIPs from a double-click.
    if (generatingRef.current || zipExportingJobId || m4bExportingJobId) return
    const job = queueJobs.find((j) => j.id === jobId)
    if (!job) return
    const doneChunks = job.chunks.filter((c) => c.status === 'done')
    if (doneChunks.length === 0) return

    setZipExportingJobId(jobId)
    setStatus('Building ZIP export…')
    try {
      const { zip } = await import('fflate')
      const entries: Record<string, Uint8Array> = {}
      const manifestChunks: Array<{
        index: number
        filename: string
        text: string
        chapterTitle?: string
        chapterIndex?: number
      }> = []
      const blobEntries: Array<{ filename: string; blob: Blob }> = []
      for (const chunk of doneChunks) {
        const blob = await getChunkBlob(jobId, chunk.index)
        if (blob) {
          const ext = formatExtension(job.format)
          const filename = `${String(chunk.index + 1).padStart(3, '0')}-${slugify(chunk.text)}${ext}`
          blobEntries.push({ filename, blob })
          manifestChunks.push({
            index: chunk.index,
            filename,
            text: chunk.text,
            chapterTitle: chunk.chapterTitle,
            chapterIndex: chunk.chapterIndex,
          })
        }
      }
      if (manifestChunks.length === 0) {
        showToast({ tone: 'warn', message: 'No completed audio blobs were available for this ZIP export. Resume the job, then try again.' })
        return
      }
      const exportError = queueExportSizeError(blobEntries.map((entry) => entry.blob))
      if (exportError) {
        showToast({ tone: 'warn', message: exportError })
        return
      }
      for (const entry of blobEntries) {
        entries[entry.filename] = new Uint8Array(await entry.blob.arrayBuffer())
      }
      entries['chapters.json'] = new TextEncoder().encode(JSON.stringify({
        app: 'BetterTTS',
        title: job.title,
        engine: job.engine,
        voice: job.voice,
        format: job.format,
        bitrate: job.bitrate,
        exportedAt: new Date().toISOString(),
        chunks: manifestChunks,
      }, null, 2))
      const zipped = await new Promise<Uint8Array>((resolve, reject) => {
        zip(entries, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data)))
      })
      const zipBlob = new Blob([zipped as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
      const url = URL.createObjectURL(zipBlob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${slugify(job.title)}.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      showToast({ tone: 'ok', message: `ZIP ready with ${manifestChunks.length} audio files.` })
    } catch (err) {
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'ZIP export failed.' })
    } finally {
      setZipExportingJobId(null)
      setStatus('Ready')
    }
  }

  async function downloadJobM4b(jobId: string) {
    if (generatingRef.current || zipExportingJobId) return
    const job = queueJobs.find((j) => j.id === jobId)
    if (!job || m4bExportingJobId) return
    if (job.chunks.some((chunk) => chunk.status !== 'done')) {
      showToast({ tone: 'warn', message: 'Finish every queue chunk before exporting M4B.' })
      return
    }
    let capability = m4bCapability
    if (capability == null) {
      capability = await checkM4bCapability()
      setM4bCapability(capability)
    }
    if (!capability.supported) {
      showToast({ tone: 'warn', message: capability.message })
      return
    }

    setM4bExportingJobId(jobId)
    clearProgressResetTimer()
    setStatus('Building M4B audiobook…')
    setProgress(1)
    try {
      const chunks = []
      for (const chunk of job.chunks) {
        const blob = await getChunkBlob(jobId, chunk.index)
        if (!blob) throw new Error(`Missing audio for chunk ${chunk.index + 1}. Resume the job, then export again.`)
        chunks.push({
          blob,
          text: chunk.text,
          chapterTitle: chunk.chapterTitle,
          chapterIndex: chunk.chapterIndex,
        })
      }
      const exportError = queueExportSizeError(chunks.map((chunk) => chunk.blob))
      if (exportError) {
        showToast({ tone: 'warn', message: exportError })
        return
      }

      const { blob, chapterCount } = await buildM4bFromBlobs({
        title: job.title,
        chunks,
        bitrate: Math.max(64, Math.min(192, job.bitrate)) * 1000,
        onProgress(info) {
          const phaseBase = info.phase === 'decode' ? 5 : info.phase === 'encode' ? 35 : 90
          const phaseSpan = info.phase === 'decode' ? 30 : info.phase === 'encode' ? 55 : 10
          const pct = info.total > 0 ? phaseBase + Math.round((info.done / info.total) * phaseSpan) : phaseBase
          setProgress(Math.min(99, pct))
          setStatus(info.phase === 'decode' ? 'Decoding queue audio…' : info.phase === 'encode' ? 'Encoding AAC…' : 'Writing M4B chapters…')
        },
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${slugify(job.title)}.m4b`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setProgress(100)
      showToast({ tone: 'ok', message: `M4B ready with ${chapterCount} chapters.` })
    } catch (err) {
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'M4B export failed.' })
    } finally {
      setM4bExportingJobId(null)
      setProgress(null)
      setStatus('Ready')
    }
  }

  async function removeQueueJob(jobId: string, title: string) {
    try {
      const snapshot = await deleteJobWithSnapshot(jobId)
      if (!snapshot) throw new Error('Queue job not found.')
      setQueueJobs((prev) => prev.filter((job) => job.id !== jobId))
      showToast({
        tone: 'ok',
        message: `Removed queue job "${shortUiLabel(title, 56)}".`,
        action: {
          label: 'Undo',
          run: async () => {
            await restoreQueueJob(snapshot)
            setQueueJobs((prev) => [snapshot.job, ...prev.filter((job) => job.id !== snapshot.job.id)].sort((a, b) => b.createdAt - a.createdAt))
            showToast({ tone: 'ok', message: `Restored queue job "${shortUiLabel(title, 56)}".` })
          },
        },
      })
    } catch {
      showToast({ tone: 'error', message: 'Could not remove this queue job.' })
    }
  }

  async function clearSavedLibrary() {
    try {
      const snapshots = await clearLibraryWithSnapshot()
      setLibrary([])
      showToast({
        tone: 'ok',
        message: snapshots.length > 0 ? `Cleared ${snapshots.length} saved clip${snapshots.length === 1 ? '' : 's'}.` : 'The clip library is already empty.',
        action: snapshots.length > 0 ? {
          label: 'Undo',
          run: async () => {
            await restoreClipSnapshots(snapshots)
            setLibrary((await listClips()))
            showToast({ tone: 'ok', message: `Restored ${snapshots.length} saved clip${snapshots.length === 1 ? '' : 's'}.` })
          },
        } : undefined,
      })
    } catch {
      showToast({ tone: 'error', message: 'Could not clear the clip library.' })
    }
  }

  async function handleEpubImport(file: File) {
    const sizeError = importSizeError(file)
    if (sizeError) {
      showToast(sizeError)
      return
    }
    const fileLabel = shortUiLabel(file.name, 72)
    try {
      setStatus('Parsing EPUB…')
      const { parseEpub } = await import('./lib/epub.ts')
      const chapters = await parseEpub(file)
      const allChunks = chapters.flatMap((ch, chapterIndex) => {
        const cleaned = cleanupText(ch.text, cleanup)
        return splitInput(cleaned, false).map((text) => ({ title: ch.title, chapterIndex, text }))
      })
      if (allChunks.length === 0) {
        showToast({ tone: 'warn', message: 'No readable text found in this EPUB.' })
        return
      }
      const job = createQueueJob(
        file.name.replace(/\.epub$/i, ''),
        allChunks.map((chunk) => ({
          text: chunk.text.slice(0, MAX_TEXT_CHARS),
          chapterTitle: chunk.title,
          chapterIndex: chunk.chapterIndex,
        })),
      )
      if (!job) {
        showToast({ tone: 'warn', message: queueDisabledReason ?? 'This engine cannot queue EPUB text for file export.' })
        return
      }
      await saveJob(job)
      setQueueJobs((prev) => [job, ...prev])
      const skipped = chapters.filter((ch) => !ch.text.trim()).length
      showToast({
        tone: 'ok',
        message: `Imported "${shortUiLabel(job.title)}" — ${chapters.length} chapters, ${job.chunks.length} chunks.${skipped > 0 ? ` ${skipped} empty chapters skipped.` : ''}`,
      })
    } catch (err) {
      showToast({ tone: 'error', message: err instanceof Error ? err.message : `${fileLabel} import failed.` })
    } finally {
      setStatus('Ready')
    }
  }

  async function handleDocumentImport(file: File) {
    const sizeError = importSizeError(file)
    if (sizeError) {
      showToast(sizeError)
      return
    }
    const fileLabel = shortUiLabel(file.name, 72)
    try {
      const extension = file.name.toLowerCase().endsWith('.pdf') ? 'PDF' : 'DOCX'
      setStatus(`Parsing ${extension}…`)
      const { importDocumentFile } = await import('./lib/document-import.ts')
      const imported = await importDocumentFile(file)
      const cleaned = cleanupText(imported.text, cleanup)
      if (!cleaned.trim()) {
        showToast({ tone: 'warn', message: `No readable text found in ${fileLabel} after cleanup.` })
        return
      }

      const trimmed = cleaned.slice(0, MAX_TEXT_CHARS)
      const chunkCount = splitInput(trimmed, false).length
      setText(trimmed)
      showToast({
        tone: cleaned.length > MAX_TEXT_CHARS ? 'warn' : 'ok',
        message: cleaned.length > MAX_TEXT_CHARS
          ? `${fileLabel} imported from ${imported.kind.toUpperCase()} and trimmed to ${MAX_TEXT_CHARS} characters; ${chunkCount} cleaned chunks ready.`
          : `${fileLabel} imported from ${imported.kind.toUpperCase()}; ${chunkCount} cleaned chunks ready.`,
      })
    } catch (err) {
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'Document import failed.' })
    } finally {
      setStatus('Ready')
    }
  }

  function handleFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''

    if (!file) {
      return
    }

    const sizeError = importSizeError(file)
    if (sizeError) {
      showToast(sizeError)
      return
    }
    const fileLabel = shortUiLabel(file.name, 72)
    const lowerName = file.name.toLowerCase()
    if (lowerName.endsWith('.epub')) {
      handleEpubImport(file)
      return
    }

    if (lowerName.endsWith('.pdf') || lowerName.endsWith('.docx') || file.type === 'application/pdf' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      handleDocumentImport(file)
      return
    }

    if (!lowerName.endsWith('.txt') && file.type !== 'text/plain') {
      showToast({ tone: 'warn', message: 'Import supports .txt, .epub, .pdf, and .docx files.' })
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const raw = String(reader.result ?? '')
      const truncated = raw.length > MAX_TEXT_CHARS
      setText(raw.slice(0, MAX_TEXT_CHARS))
      showToast(
        truncated
          ? { tone: 'warn', message: `${fileLabel} truncated from ${raw.length} to ${MAX_TEXT_CHARS} characters.` }
          : { tone: 'ok', message: `${fileLabel} imported.` },
      )
    }
    reader.onerror = () => showToast({ tone: 'error', message: `${fileLabel} import failed.` })
    reader.readAsText(file)
  }

  function handleBgmFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null
    event.currentTarget.value = ''
    if (!file) return

    const message = validateBackgroundMusicFile(file)
    if (message) {
      showToast({ tone: 'warn', message })
      return
    }

    setBgmFile(file)
    showToast({ tone: 'ok', message: `Background music selected: ${shortUiLabel(file.name, 48)}` })
  }

  return (
      <div className="app-shell">
        <a className="skip-link" href="#script-editor">Skip to script editor</a>
        <header className="topbar">
          <a className="brand" href="#studio" aria-label="BetterTTS home">
            <span className="brand-mark" aria-hidden="true">
              <Waves size={25} strokeWidth={2.2} />
            </span>
            <span>BetterTTS</span>
          </a>
          <div className="project-context" aria-label="Current workspace">
            <strong>Local studio</strong>
            <span><span className="status-dot" aria-hidden="true" /> Session active</span>
          </div>
          <div className="topbar-status" aria-label="Runtime status">
            <span className="status-dot" aria-hidden="true" />
            <span>No cloud</span>
            <span>100% local</span>
          </div>
          <button
            type="button"
            className="theme-button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
            <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
        </header>

        <nav className="app-rail" aria-label="Workspace">
          <a
            href="#studio"
            className={activeNavSection === 'studio' && !['queue-panel', 'library-panel', 'diagnostics-panel'].includes(activeWorkspaceHash) ? 'rail-link active' : 'rail-link'}
            aria-current={activeNavSection === 'studio' && !['queue-panel', 'library-panel', 'diagnostics-panel'].includes(activeWorkspaceHash) ? 'page' : undefined}
          >
            <Waves size={21} aria-hidden="true" />
            <span>Studio</span>
          </a>
          <a
            href="#queue-panel"
            className={activeWorkspaceHash === 'queue-panel' ? 'rail-link active' : 'rail-link'}
            aria-current={activeWorkspaceHash === 'queue-panel' ? 'page' : undefined}
            title={queueSummaryLabel}
            onClick={(event) => {
              event.preventDefault()
              openWorkspacePanel('queue-panel')
            }}
          >
            <FileText size={20} aria-hidden="true" />
            <span>Queue</span>
            {queueJobs.length > 0 ? <small>{queueJobs.length}</small> : null}
          </a>
          <a
            href="#library-panel"
            className={activeWorkspaceHash === 'library-panel' ? 'rail-link active' : 'rail-link'}
            aria-current={activeWorkspaceHash === 'library-panel' ? 'page' : undefined}
            title={librarySummaryLabel}
            onClick={(event) => {
              event.preventDefault()
              openWorkspacePanel('library-panel')
            }}
          >
            <Download size={20} aria-hidden="true" />
            <span>Library</span>
            {library.length > 0 ? <small>{library.length}</small> : null}
          </a>
          <a href="#models" className={activeNavSection === 'models' ? 'rail-link active' : 'rail-link'} aria-current={activeNavSection === 'models' ? 'page' : undefined}>
            <SquareCode size={20} aria-hidden="true" />
            <span>Models</span>
          </a>
          <a
            href="#diagnostics-panel"
            className={activeWorkspaceHash === 'diagnostics-panel' ? 'rail-link active' : 'rail-link'}
            aria-current={activeWorkspaceHash === 'diagnostics-panel' ? 'page' : undefined}
            onClick={() => setShowSystemTools(true)}
          >
            <Settings2 size={20} aria-hidden="true" />
            <span>Diagnostics</span>
          </a>
          <a href="#docs" className={activeNavSection === 'docs' ? 'rail-link rail-link-bottom active' : 'rail-link rail-link-bottom'} aria-current={activeNavSection === 'docs' ? 'page' : undefined}>
            <Info size={20} aria-hidden="true" />
            <span>Docs</span>
          </a>
        </nav>

        <main className="app-content">
        <section className="studio-grid" id="studio">
          <div className="studio-workbench">
            <div className="editor-column">
              <div className="section-heading">
                <span>Script</span>
                <span className={overLimit ? 'danger-text' : ''}>
                  {text.length} / {MAX_TEXT_CHARS}
                  {overLimit ? ` (${text.length - MAX_TEXT_CHARS} over)` : ''}
                </span>
              </div>
              <div className="editor-actions">
                <button
                  type="button"
                  onClick={() => {
                    if (!text) return
                    setText('')
                    showToast({ tone: 'ok', message: 'Script cleared.' })
                  }}
                >
                  <FilePlus2 size={16} aria-hidden="true" />
                  New
                </button>
                <button type="button" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={16} aria-hidden="true" />
                  Open
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.epub,.pdf,.docx,text/plain,application/epub+zip,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={handleFileUpload}
                  hidden
                />
                <select
                  className="pause-select"
                  value={pauseDuration}
                  onChange={(e) => setPauseDuration(Number(e.target.value))}
                  aria-label="Pause duration"
                >
                  <option value={0.5}>0.5s</option>
                  <option value={1}>1s</option>
                  <option value={2}>2s</option>
                  <option value={5}>5s</option>
                </select>
                <button
                  type="button"
                  onClick={() => setText((current) => `${current.trimEnd()} [pause ${pauseDuration}s] `)}
                >
                  <FileText size={16} aria-hidden="true" />
                  Insert pause
                </button>
                <div className="url-import">
                  <input
                    type="url"
                    value={importUrlValue}
                    onChange={(e) => setImportUrlValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') importFromUrl(importUrlValue)
                    }}
                    placeholder="Paste article URL…"
                    aria-label="Article URL to import"
                  />
                  <button
                    type="button"
                    onClick={() => importFromUrl(importUrlValue)}
                    disabled={importingUrl || !importUrlValue.trim()}
                  >
                    {importingUrl ? <Loader2 size={16} aria-hidden="true" /> : <ExternalLink size={16} aria-hidden="true" />}
                    Import
                  </button>
                </div>
                <button
                  type="button"
                  className={isGenerating ? 'mobile-generate cancel' : 'mobile-generate'}
                  onClick={isGenerating ? cancelGeneration : handleGenerate}
                >
                  {isGenerating ? <X size={17} aria-hidden="true" /> : <Waves size={17} aria-hidden="true" />}
                  {isGenerating ? 'Cancel generation' : 'Generate audio'}
                </button>
              </div>
              <div className="editor-frame">
                <textarea
                  id="script-editor"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  spellCheck={false}
                  aria-label="Text to synthesize"
                />
              </div>
              <div className="editor-statusbar" aria-label="Editor status">
                <span>{wordCount} words</span>
                <span>{text.length} characters</span>
                <span>{lineCount} lines</span>
                <span>{editorModeLabel}</span>
                <span>{cleanupSummary}</span>
              </div>
            </div>

            <div className="workspace-column">
              <div className="workspace-header">
                <div className="section-heading">
                  <span>Render monitor</span>
                  <span aria-live="polite">{status}</span>
                </div>
                <div className="workspace-tabs" role="tablist" aria-label="Render workspace">
                {WORKSPACE_TABS.map(([target, label]) => {
                  const isActive = activeWorkspaceHash === target || (target === 'generated-output' && !['queue-panel', 'library-panel'].includes(activeWorkspaceHash))
                  return (
                    <button
                      type="button"
                      role="tab"
                      key={target}
                      className={isActive ? 'active' : undefined}
                      aria-selected={isActive}
                      aria-controls={target}
                      tabIndex={isActive ? 0 : -1}
                      onKeyDown={handleWorkspaceTabKeyDown}
                      onClick={() => openWorkspacePanel(target)}
                    >
                      {label}
                      {target === 'queue-panel' && queueJobs.length > 0 ? <small>{queueJobs.length}</small> : null}
                      {target === 'library-panel' && library.length > 0 ? <small>{library.length}</small> : null}
                    </button>
                  )
                })}
                </div>
              </div>
              <section
                className={`output-panel output-deck workspace-panel ${!['queue-panel', 'library-panel'].includes(activeWorkspaceHash) ? 'active' : ''}`}
                id="generated-output"
                role="tabpanel"
                aria-label="Generated audio"
                ref={outputPanelRef}
                tabIndex={-1}
              >
              <div className="output-session-card">
                <div>
                  <span>Current output</span>
                  <strong>{results.length > 0 ? `${results.length} generated clip${results.length === 1 ? '' : 's'}` : 'Ready for synthesis'}</strong>
                  <small>{activeEngineName} - {outputFormatLabel} - {captionModeLabel}</small>
                </div>
                <div className="output-session-meta">
                  <strong>{engine === 'browser' ? 'Device audio' : activeSampleRate}</strong>
                  <small>{status}</small>
                </div>
                <div className="output-waveform" aria-hidden="true">
                  {results.length === 0 ? (
                    <span className="waveform-empty">
                      <Volume2 size={22} aria-hidden="true" />
                      <span>Generate audio to begin the waveform</span>
                    </span>
                  ) : null}
                </div>
                <div className="output-transport" aria-label="Output transport">
                  <button type="button" disabled={results.length === 0} aria-label="Play current output">
                    <Play size={16} aria-hidden="true" />
                  </button>
                  <strong>{results.length > 0 ? results[0].duration : '00:00'}</strong>
                  <span className="transport-track" aria-hidden="true" />
                  <span>{engine === 'browser' ? 'Device' : activeSampleRate}</span>
                  <button
                    type="button"
                    className="output-clear"
                    onClick={handleClearOutputs}
                    disabled={results.length === 0 && zipUrl === null}
                    aria-label="Clear generated output"
                    title="Clear generated output"
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </div>
              </div>
              {results.length === 0 ? (
                <p className="output-empty-note">Choose a voice, review the script, then generate a preview or queue a resumable export.</p>
              ) : (
                <ul className="result-list" aria-label="Generated clips">
                  {results.map((result) => (
                    <li key={result.id}>
                      <ResultRow
                        result={result}
                        isSpeaking={isSpeaking}
                        onReplay={replayBrowser}
                        onShare={shareResult}
                        onSave={saveWithPicker}
                      />
                    </li>
                  ))}
                  {zipUrl ? (
                    <li>
                      <a className="zip-download" href={zipUrl} download={zipName}>
                        <Download size={17} aria-hidden="true" />
                        Download all ZIP
                      </a>
                    </li>
                  ) : null}
                </ul>
              )}
              <p className="privacy-note">
                <Info size={16} aria-hidden="true" />
                100% private — your text and audio stay on this device. Model files are cached locally after first use.
              </p>
            </section>

              <div className="workspace-secondary-grid">
            {queueJobs.length > 0 ? (
              <section className={`output-panel queue-panel workspace-panel ${activeWorkspaceHash === 'queue-panel' ? 'active' : ''}`} id="queue-panel" role="tabpanel" aria-label="Generation queue" tabIndex={-1}>
                <div className="section-heading">
                  <span>Queue ({queueJobs.length})</span>
                </div>
                <div className={`capability-strip ${m4bCapabilityTone(m4bCapability)}`}>
                  <Info size={15} aria-hidden="true" />
                  <span>{m4bCapabilityText(m4bCapability)}</span>
                </div>
                <ul className="result-list" aria-label="Queued jobs">
                  {queueJobs.map((job) => {
                    const { done, total, pct } = jobProgress(job)
                    const isActive = activeJobId === job.id
                    const doneChunks = job.chunks.filter((chunk) => chunk.status === 'done')
                    const queueStatus = queueJobStatus(job)
                    const failedChunks = job.chunks.filter((chunk) => chunk.status === 'failed')
                    const warnedChunks = job.chunks.filter((chunk) => chunk.status === 'done' && chunk.warning)
                    return (
                      <li key={job.id}>
                      <div className="result-row queue-job-row">
                        <div className="result-meta">
                          <span className={`ready-dot ${queueStatus}`} aria-hidden="true" />
                          <strong>{job.title}</strong>
                          <span>{queueEngineText(job)}</span>
                          <span>{job.format.toUpperCase()}</span>
                          <span className={`queue-status ${queueStatus}`}>{queueStatus}</span>
                          <span>{done}/{total} chunks</span>
                          <span>{pct}%</span>
                        </div>
                        {failedChunks.length > 0 ? (
                          <div className="capability-strip warn" role="status">
                            <Info size={15} aria-hidden="true" />
                            <span>
                              {failedChunks.length === 1
                                ? `Chunk ${failedChunks[0].index + 1} failed: ${shortUiLabel(failedChunks[0].error ?? 'Unknown error', 120)}`
                                : `${failedChunks.length} chunks failed — first at chunk ${failedChunks[0].index + 1}: ${shortUiLabel(failedChunks[0].error ?? 'Unknown error', 100)}`}
                              {' '}Resume retries failed chunks.
                            </span>
                          </div>
                        ) : null}
                        {warnedChunks.length > 0 ? (
                          <div className="capability-strip warn" role="status">
                            <Info size={15} aria-hidden="true" />
                            <span>
                              Completeness check: chunk {warnedChunks[0].index + 1} — {shortUiLabel(warnedChunks[0].warning ?? '', 110)}
                              {warnedChunks.length > 1 ? ` (+${warnedChunks.length - 1} more)` : ''}. Edit &amp; regenerate the chunk below.
                            </span>
                          </div>
                        ) : null}
                        <div className="result-actions">
                          {pct < 100 && !isActive ? (
                            <button type="button" onClick={() => resumeJob(job.id)} disabled={isGenerating}>
                              <Play size={16} aria-hidden="true" />
                              {done > 0 ? 'Resume' : 'Start'}
                            </button>
                          ) : null}
                          {isActive ? (
                            <button type="button" onClick={() => { abortRef.current = true }}>
                              <X size={16} aria-hidden="true" />
                              Pause
                            </button>
                          ) : null}
                          {done > 0 ? (
                            <button
                              type="button"
                              onClick={() => downloadJobZip(job.id)}
                              disabled={isGenerating || zipExportingJobId !== null || m4bExportingJobId !== null}
                              title={done === total && !m4bExportReady ? 'Download chaptered ZIP fallback with chapters.json.' : 'Download completed chunks as a chaptered ZIP.'}
                            >
                              {zipExportingJobId === job.id ? <Loader2 size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
                              {done === total && !m4bExportReady ? 'ZIP fallback' : 'ZIP'}
                            </button>
                          ) : null}
                          {done === total && total > 0 ? (
                            <button
                              type="button"
                              onClick={() => downloadJobM4b(job.id)}
                              disabled={isGenerating || m4bExportingJobId !== null || zipExportingJobId !== null || !m4bExportReady}
                              title={m4bExportReady ? 'Export chaptered M4B' : m4bCapabilityText(m4bCapability)}
                            >
                              {m4bExportingJobId === job.id ? <Loader2 size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
                              M4B
                            </button>
                          ) : null}
                          {!isActive ? (
                            <button
                              type="button"
                              onClick={() => removeQueueJob(job.id, job.title)}
                              aria-label={`Remove queue job ${job.title}`}
                            >
                              <Trash2 size={16} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                        {doneChunks.length > 0 ? (
                          <ul className="queue-chunk-list" aria-label={`${job.title} completed chunks`}>
                            {doneChunks.map((chunk) => (
                              <li key={chunk.index}>
                                <QueueChunkPlayer
                                  jobId={job.id}
                                  chunk={chunk}
                                  format={job.format}
                                  regenerating={regeneratingChunkKey === `${job.id}:${chunk.index}`}
                                  onRegenerate={regenerateQueueChunk}
                                  onNotice={showToast}
                                />
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : (
              <section className={`output-panel queue-panel workspace-panel ${activeWorkspaceHash === 'queue-panel' ? 'active' : ''}`} id="queue-panel" role="tabpanel" aria-label="Generation queue" tabIndex={-1}>
                <div className="section-heading">
                  <span>Queue (0)</span>
                </div>
                <div className="compact-empty">
                  <FileText size={28} aria-hidden="true" />
                  <strong>Queue is empty</strong>
                  <span>Use Queue in Properties to create a resumable long-form or chapter export.</span>
                </div>
              </section>
            )}

            {library.length > 0 ? (
              <section className={`output-panel library-panel workspace-panel ${activeWorkspaceHash === 'library-panel' ? 'active' : ''}`} id="library-panel" role="tabpanel" aria-label="Clip library" tabIndex={-1}>
                <div className="section-heading">
                  <span>Library ({library.length})</span>
                  <button
                    type="button"
                    className="heading-action"
                    onClick={clearSavedLibrary}
                  >
                    Clear library
                  </button>
                </div>
                <ul className="result-list" aria-label="Saved clips">
                  {library.map((clip) => (
                    <li key={clip.id}>
                      <LibraryClipRow
                        clip={clip}
                        onDeleted={(snapshot) => {
                          setLibrary((prev) => prev.filter((item) => item.id !== snapshot.record.id))
                          showToast({
                            tone: 'ok',
                            message: `Removed ${shortUiLabel(snapshot.record.label, 48)} from the library.`,
                            action: {
                              label: 'Undo',
                              run: async () => {
                                await restoreClipSnapshots([snapshot])
                                setLibrary((prev) => [snapshot.record, ...prev.filter((item) => item.id !== snapshot.record.id)].sort((a, b) => b.createdAt - a.createdAt))
                                showToast({ tone: 'ok', message: `Restored ${shortUiLabel(snapshot.record.label, 48)}.` })
                              },
                            },
                          })
                        }}
                        onNotice={showToast}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <section className={`output-panel library-panel workspace-panel ${activeWorkspaceHash === 'library-panel' ? 'active' : ''}`} id="library-panel" role="tabpanel" aria-label="Clip library" tabIndex={-1}>
                <div className="section-heading">
                  <span>Library (0)</span>
                </div>
                <div className="compact-empty">
                  <Download size={28} aria-hidden="true" />
                  <strong>No saved clips</strong>
                  <span>Generated clips saved on this device appear here with playback and export controls.</span>
                </div>
              </section>
            )}
              </div>
            </div>
          </div>

          <aside className="settings-panel" aria-label="Voice settings">
            <div className="settings-scroll">
            <div className="section-heading">
              <span>Properties</span>
              <span>v{APP_VERSION}</span>
            </div>
            <div className="inspector-summary" aria-label="Current render settings">
              <span><small>Engine</small><strong>{activeEngineName}</strong></span>
              <span><small>Voice</small><strong>{activeVoiceName}</strong></span>
              <span><small>Delivery</small><strong>{speedSummary}</strong></span>
              <span><small>Output</small><strong>{outputFormatLabel}</strong></span>
            </div>

            <fieldset className="control-module engine-module">
              <legend>Engine</legend>
              <div className="engine-grid">
                <button
                  type="button"
                  className={engine === 'kokoro' ? 'engine-card selected' : 'engine-card'}
                  onClick={() => setEngine('kokoro')}
                  aria-pressed={engine === 'kokoro'}
                >
                  <span>{engine === 'kokoro' ? <Check size={17} aria-hidden="true" /> : null}</span>
                  <strong>Kokoro 82M</strong>
                  <small>
                    {selectedKokoroLanguage.label}. {kokoroRuntimeLabel}. WAV export.{kokoroRuntimeLabel === 'WebAssembly q8' ? ' Pages-hosted English model.' : ' HF model.'}{modelCached ? ' Model cached.' : ''}
                    {storageEstimate ? ` ${storageEstimate}.` : ''}
                  </small>
                </button>
                <button
                  type="button"
                  className={engine === 'supertonic' ? 'engine-card selected' : 'engine-card'}
                  onClick={() => setEngine('supertonic')}
                  aria-pressed={engine === 'supertonic'}
                >
                  <span>{engine === 'supertonic' ? <Check size={17} aria-hidden="true" /> : null}</span>
                  <strong>Supertonic</strong>
                  <small>English speed engine. 44.1 kHz fp32, lazy-loaded from HF.</small>
                </button>
                <button
                  type="button"
                  className={engine === 'kitten' ? 'engine-card selected' : 'engine-card'}
                  onClick={() => setEngine('kitten')}
                  aria-pressed={engine === 'kitten'}
                >
                  <span>{engine === 'kitten' ? <Check size={17} aria-hidden="true" /> : null}</span>
                  <strong>KittenTTS</strong>
                  <small>{selectedKittenModel.label} {selectedKittenModel.params}. English WebGPU engine, {selectedKittenModel.weightSize} on first use.</small>
                </button>
                {experimentalPiperEnabled ? (
                  <button
                    type="button"
                    className={engine === 'piper' ? 'engine-card selected' : 'engine-card'}
                    onClick={() => setEngine('piper')}
                    aria-pressed={engine === 'piper'}
                  >
                    <span>{engine === 'piper' ? <Check size={17} aria-hidden="true" /> : null}</span>
                    <strong>Piper-plus</strong>
                    <small>{PIPER_PLUS_MODEL_LABEL}. {selectedPiperLanguage.label}. MIT runtime, lazy model.</small>
                  </button>
                ) : null}
                <button
                  type="button"
                  className={engine === 'browser' ? 'engine-card selected' : 'engine-card'}
                  onClick={() => setEngine('browser')}
                  aria-pressed={engine === 'browser'}
                >
                  <span>{engine === 'browser' ? <Check size={17} aria-hidden="true" /> : null}</span>
                  <strong>Browser</strong>
                  <small>Native speech playback when Kokoro cannot run.</small>
                </button>
              </div>
              <div className={`engine-status ${engineStatusTone}`}>
                <span className="status-dot" aria-hidden="true" />
                <span>{engineStatus}</span>
              </div>
              <button
                type="button"
                className="advanced-toggle system-tools-toggle"
                id="diagnostics-panel"
                ref={systemToolsToggleRef}
                onClick={() => setShowSystemTools(!showSystemTools)}
                aria-expanded={showSystemTools}
              >
                <Settings2 size={15} aria-hidden="true" />
                System & diagnostics
                <ChevronDown size={15} aria-hidden="true" className={showSystemTools ? 'chevron-open' : ''} />
              </button>
              {showSystemTools ? (
              <div className="system-tools-section" role="group" aria-label="System and diagnostics" ref={systemToolsSectionRef}>
                <label className="toggle-row experimental-engine-toggle" htmlFor="experimental-piper" aria-label="Enable experimental Piper-plus">
                  <input
                    id="experimental-piper"
                    type="checkbox"
                    checked={experimentalPiperEnabled}
                    onChange={(event) => setExperimentalPiperEnabled(event.target.checked)}
                  />
                  <span>
                    <strong>Enable experimental Piper-plus</strong>
                    <small>{piperPlusSupport.supported ? 'Loads the Piper runtime and Tsukuyomi-chan model only when selected.' : 'Requires WebAssembly and IndexedDB support.'}</small>
                  </span>
                </label>
                <div className="cache-manager" aria-label="Offline pack manager">
                <div className="cache-manager-head">
                  <span>
                    <strong>Offline packs</strong>
                    <small>Model cache is separate from the app shell.</small>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setCacheAction('refresh')
                      refreshModelCacheStatus()
                        .then(() => refreshStorageEstimate())
                        .catch(() => showToast({ tone: 'error', message: 'Could not inspect model cache.' }))
                        .finally(() => setCacheAction(null))
                    }}
                    disabled={cacheAction !== null}
                  >
                    {cacheAction === 'refresh' ? <Loader2 size={13} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
                    Refresh
                  </button>
                </div>
                {cacheRows.length > 0 ? (
                  <div className="cache-rows">
                    {cacheRows.map((row) => (
                      <div className="cache-row" key={row.id}>
                        <span>
                          <strong>{row.label}</strong>
                          <small>{cacheStatusText(row, modelCache?.supported ?? false)}</small>
                        </span>
                        <div className="cache-row-actions">
                          {row.id === 'kokoro' ? (
                            <button
                              type="button"
                              onClick={handlePrefetchKokoroPack}
                              disabled={!modelCache?.supported || cacheAction !== null || isGenerating}
                            >
                              {cacheAction === 'prefetch-kokoro' ? <Loader2 size={13} aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
                              Prefetch
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => handleClearModelCache(row.id)}
                            disabled={!modelCache?.supported || row.entryCount === 0 || cacheAction !== null || isGenerating}
                          >
                            {cacheAction === `clear-${row.id}` ? <Loader2 size={13} aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
                            Clear
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="cache-empty">Checking model cache…</p>
                )}
              </div>
                <div className="diagnostics-panel" aria-label="Diagnostics export">
                <div className="cache-manager-head">
                  <span>
                    <strong>Diagnostics</strong>
                    <small>Local support bundle. No script text or imported URLs.</small>
                  </span>
                </div>
                <dl className="diagnostics-facts">
                  <div><dt>Runtime</dt><dd title={runtimeLabel}>{runtimeLabel}</dd></div>
                  <div><dt>Opus export</dt><dd>{opusSupported() ? 'Available' : 'Unavailable'}</dd></div>
                  <div><dt>M4B export</dt><dd>{m4bCapability?.supported ? 'AAC ready' : 'ZIP fallback'}</dd></div>
                  <div><dt>Storage</dt><dd title={storageEstimate ?? 'Unknown'}>{storageEstimate ?? 'Unknown'}</dd></div>
                  <div><dt>Storage mode</dt><dd title={crossOriginStorage.message}>{crossOriginStorageShortLabel(crossOriginStorage.usable)}</dd></div>
                  <div>
                    <dt>Transformers</dt>
                    <dd title={transformersReadiness.criteria.map((criterion) => `${criterion.label}: ${criterion.met ? 'pass' : 'pending'}`).join(' | ')}>{TRANSFORMERS_RUNTIME_VERSION}</dd>
                  </div>
                  <div><dt>Piper-plus</dt><dd title={piperPlusSupport.notes.join(' ')}>{piperPlusSupport.supported ? 'Available' : 'Unavailable'}</dd></div>
                </dl>
                <details className="diagnostics-technical">
                  <summary>Runtime details</summary>
                  <small className="diagnostics-detail">
                    Storage isolation: {crossOriginStorage.message} Transformers upgrade: {transformersReadiness.readyToSwitch ? 'ready for 4.3.' : 'holding current runtime.'} Piper-plus: {piperPlusSupport.notes.join(' ')}
                  </small>
                </details>
                <div className="diagnostics-actions">
                  <button type="button" onClick={handleCopyDiagnostics} disabled={diagnosticsAction !== null}>
                    {diagnosticsAction === 'copy' ? <Loader2 size={13} aria-hidden="true" /> : <SquareCode size={13} aria-hidden="true" />}
                    Copy JSON
                  </button>
                  <button type="button" onClick={handleDownloadDiagnostics} disabled={diagnosticsAction !== null}>
                    {diagnosticsAction === 'download' ? <Loader2 size={13} aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
                    Download JSON
                  </button>
                </div>
                <small>{m4bCapabilityText(m4bCapability)}</small>
              </div>
              </div>
              ) : null}
            </fieldset>

            {engine === 'kokoro' ? (
              <>
                <label className="control-label" htmlFor="locale">
                  Language
                </label>
                <select id="locale" value={locale} onChange={(event) => setLocale(event.target.value as KokoroLocale)}>
                  {KOKORO_LANGUAGES.map((language) => (
                    <option value={language.id} key={language.id}>{language.label}</option>
                  ))}
                </select>

                <label className="control-label" htmlFor="voice">
                  Voice
                </label>
                <select id="voice" value={voiceId} onChange={(event) => setVoiceId(event.target.value)}>
                  {availableVoices.map((voice) => (
                    <option value={voice.id} key={voice.id}>
                      {voice.name} ({voice.gender}, grade {voice.grade})
                    </option>
                  ))}
                </select>

                <div className="voice-buttons" aria-label="Favorite voices">
                    {availableVoices.slice(0, 6).map((voice) => (
                    <div className="voice-btn-row" key={voice.id}>
                      <button
                        type="button"
                        className={voice.id === voiceId ? 'selected' : ''}
                        onClick={() => setVoiceId(voice.id)}
                        aria-pressed={voice.id === voiceId}
                      >
                        {voice.name}
                      </button>
                      <button
                        type="button"
                        className="voice-preview"
                        onClick={() => previewVoice(voice.id)}
                        disabled={previewingVoice !== null}
                        aria-label={`Preview ${voice.name}`}
                      >
                        {previewingVoice === voice.id ? (
                          <Loader2 size={13} aria-hidden="true" />
                        ) : (
                          <Play size={13} aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : engine === 'supertonic' ? (
              <>
                <label className="control-label" htmlFor="supertonic-voice">
                  Voice
                </label>
                <select
                  id="supertonic-voice"
                  value={supertonicVoiceId}
                  onChange={(event) => setSupertonicVoiceId(event.target.value as SupertonicVoiceId)}
                >
                  {SUPERTONIC_VOICES.map((voice) => (
                    <option value={voice.id} key={voice.id}>
                      {voice.name} ({voice.gender})
                    </option>
                  ))}
                </select>
              </>
            ) : engine === 'kitten' ? (
              <>
                <label className="control-label" htmlFor="kitten-model">
                  Model
                </label>
                <select
                  id="kitten-model"
                  value={kittenModelSize}
                  onChange={(event) => setKittenModelSize(event.target.value as KittenModelSize)}
                >
                  {KITTEN_MODELS.map((model) => (
                    <option value={model.id} key={model.id}>
                      {model.label} ({model.params}, {model.weightSize})
                    </option>
                  ))}
                </select>

                <label className="control-label" htmlFor="kitten-voice">
                  Voice
                </label>
                <select
                  id="kitten-voice"
                  value={kittenVoiceId}
                  onChange={(event) => setKittenVoiceId(event.target.value as KittenVoiceId)}
                >
                  {KITTEN_VOICES.map((voice) => (
                    <option value={voice.id} key={voice.id}>
                      {voice.name} ({voice.gender})
                    </option>
                  ))}
                </select>

                <div className="voice-buttons" aria-label="KittenTTS voices">
                  {KITTEN_VOICES.slice(0, 6).map((voice) => (
                    <div className="voice-btn-row" key={voice.id}>
                      <button
                        type="button"
                        className={voice.id === kittenVoiceId ? 'selected' : ''}
                        onClick={() => setKittenVoiceId(voice.id)}
                        aria-pressed={voice.id === kittenVoiceId}
                      >
                        {voice.name}
                      </button>
                      <button
                        type="button"
                        className="voice-preview"
                        onClick={() => previewVoice(voice.id, KITTEN_PREVIEW_TEXT)}
                        disabled={previewingVoice !== null}
                        aria-label={`Preview ${voice.name}`}
                      >
                        {previewingVoice === voice.id ? (
                          <Loader2 size={13} aria-hidden="true" />
                        ) : (
                          <Play size={13} aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : engine === 'piper' ? (
              <>
                <label className="control-label" htmlFor="piper-language">
                  Piper language
                </label>
                <select
                  id="piper-language"
                  value={piperLanguage}
                  onChange={(event) => setPiperLanguage(event.target.value as PiperPlusLanguage)}
                >
                  {PIPER_PLUS_LANGUAGES.map((language) => (
                    <option value={language.id} key={language.id}>
                      {language.label}
                    </option>
                  ))}
                </select>
                <p className="engine-note">
                  {PIPER_PLUS_MODEL_LABEL} uses Piper-plus {PIPER_PLUS_PACKAGE_VERSION}; model and WASM assets load only on first Piper generation.
                </p>
              </>
            ) : (
              <>
                <label className="control-label" htmlFor="browser-voice">
                  Browser voice
                </label>
                <select
                  id="browser-voice"
                  value={browserVoiceUri}
                  onChange={(event) => setBrowserVoiceUri(event.target.value)}
                >
                  <option value="">Default (first English)</option>
                  {browserVoices.map((v) => (
                    <option value={v.voiceURI} key={v.voiceURI}>
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </select>
              </>
            )}

            <div className="range-row">
              <label htmlFor="speed">Speed</label>
              <span>{speed.toFixed(2)}x</span>
              <input
                id="speed"
                type="range"
                min={speedMin}
                max={speedMax}
                step="0.05"
                value={speed}
                onChange={(event) => setSpeed(Number(event.target.value))}
              />
            </div>

            <button
              type="button"
              className="advanced-toggle"
              ref={advancedToggleRef}
              onClick={() => setShowAdvanced(!showAdvanced)}
              aria-expanded={showAdvanced}
            >
              <Settings2 size={15} aria-hidden="true" />
              Advanced options
              <ChevronDown size={15} aria-hidden="true" className={showAdvanced ? 'chevron-open' : ''} />
            </button>

            {showAdvanced ? (
              <div className="advanced-section" role="group" aria-label="Advanced options" ref={advancedSectionRef}>
                {engine === 'kokoro' ? (
                  <div className="range-row">
                    <label htmlFor="pitch">Pitch</label>
                    <span>{pitchSemitones > 0 ? `+${pitchSemitones}` : pitchSemitones} st</span>
                    <input
                      id="pitch"
                      type="range"
                      min="-4"
                      max="4"
                      step="1"
                      value={pitchSemitones}
                      onChange={(event) => setPitchSemitones(Number(event.target.value))}
                    />
                  </div>
                ) : null}

                {engine === 'supertonic' ? (
                  <div className="range-row">
                    <label htmlFor="supertonic-steps">Steps</label>
                    <span>{supertonicSteps}</span>
                    <input
                      id="supertonic-steps"
                      type="range"
                      min="1"
                      max="10"
                      step="1"
                      value={supertonicSteps}
                      onChange={(event) => setSupertonicSteps(Number(event.target.value))}
                    />
                  </div>
                ) : null}

                {engine !== 'browser' ? (
                  <div className="format-row">
                    <label className="control-label" htmlFor="format">Format</label>
                    <select id="format" value={audioFormat} onChange={(e) => setAudioFormat(e.target.value as AudioFormat)}>
                      <option value="wav">WAV (lossless)</option>
                      <option value="mp3">MP3</option>
                      {opusSupported() ? <option value="opus">Opus (WebM)</option> : null}
                    </select>
                    {audioFormat === 'mp3' ? (
                      <select value={mp3Bitrate} onChange={(e) => setMp3Bitrate(Number(e.target.value))} aria-label="MP3 bitrate">
                        <option value={96}>96 kbps</option>
                        <option value={128}>128 kbps</option>
                        <option value={160}>{engine === 'kokoro' || engine === 'kitten' ? '160 kbps (max at 24 kHz)' : '160 kbps'}</option>
                      </select>
                    ) : null}
                  </div>
                ) : null}

                {engine === 'kokoro' ? (
                  <div className="bgm-row">
                    <span className="control-label">Background music</span>
                    <div className="bgm-controls">
                      <button type="button" onClick={() => bgmInputRef.current?.click()}>
                        <Upload size={14} aria-hidden="true" />
                        {bgmFile ? bgmFile.name.slice(0, 20) : 'Upload BGM'}
                      </button>
                      {bgmFile ? (
                        <button type="button" onClick={() => setBgmFile(null)}>
                          <X size={14} aria-hidden="true" />
                          <span className="sr-only">Remove background music</span>
                        </button>
                      ) : null}
                      <input ref={bgmInputRef} type="file" accept="audio/*" onChange={handleBgmFileChange} hidden />
                    </div>
                    {bgmFile ? (
                      <div className="range-row bgm-volume-row">
                        <label htmlFor="bgm-vol">BGM volume</label>
                        <span>{Math.round(bgmVolume * 100)}%</span>
                        <input id="bgm-vol" type="range" min="0" max="0.5" step="0.01" value={bgmVolume} onChange={(e) => setBgmVolume(Number(e.target.value))} />
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <label className="toggle-row">
                  <input type="checkbox" checked={separateLines} onChange={(event) => setSeparateLines(event.target.checked)} />
                  <span>
                    Separate lines
                    <small>Generate one audio file per non-empty line.</small>
                  </span>
                </label>

                <span className="control-label">Text cleanup</span>
                {(
                  [
                    ['citations', 'Skip citations', 'Remove [12]-style reference markers.'],
                    ['urls', 'Shorten URLs', 'Read web addresses as "link".'],
                    ['acronyms', 'Spell acronyms', 'Letter-space SQL, HTML, and similar.'],
                    ['markdown', 'Strip markdown', 'Drop #, *, backticks, and link syntax.'],
                    ['pageArtifacts', 'Drop page headers', 'Remove repeated headers, footers, and page numbers.'],
                    ['footnotes', 'Skip footnotes', 'Remove note markers and references sections.'],
                    ['numbers', 'Normalize numbers', 'Read currency, decimals, units, and percentages clearly.'],
                    ['metadata', 'Drop book metadata', 'Remove ISBN, DOI, and cataloging lines.'],
                  ] as const
                ).map(([key, title, hint]) => (
                  <label className="toggle-row" key={key}>
                    <input
                      type="checkbox"
                      checked={cleanup[key]}
                      onChange={(event) => setCleanup((prev) => ({ ...prev, [key]: event.target.checked }))}
                    />
                    <span>
                      {title}
                      <small>{hint}</small>
                    </span>
                  </label>
                ))}

                {engine === 'kokoro' ? (
                  <>
                    <label className="toggle-row">
                      <input type="checkbox" checked={streamPlay} onChange={(event) => setStreamPlay(event.target.checked)} />
                      <span>
                        Stream playback
                        <small>Play audio as it generates. Pitch and music apply to the exported file.</small>
                      </span>
                    </label>
                    <label className="toggle-row">
                      <input
                        type="checkbox"
                        checked={useWorker && !wordTimestamps}
                        disabled={wordTimestamps}
                        onChange={(event) => setUseWorker(event.target.checked)}
                      />
                      <span>
                        Background worker
                        <small>{wordTimestamps ? 'Disabled while word timestamps are on.' : 'Run inference off main thread for smoother UI.'}</small>
                      </span>
                    </label>
                    <label className="toggle-row">
                      <input
                        type="checkbox"
                        checked={forceWasm}
                        disabled={isGenerating || forceNative}
                        onChange={(event) => {
                          const next = event.target.checked
                          setForceWasm(next)
                          setForceNative(false)
                          try {
                            window.localStorage.setItem('bettertts-backend', next ? 'wasm' : 'auto')
                          } catch { /* storage blocked */ }
                          resetKokoroSession()
                          resetTimestampedKokoroSession()
                          resetWorker()
                        }}
                      />
                      <span>
                        CPU mode (WASM)
                        <small>{forceNative ? 'Managed by the native desktop engine.' : 'Use if audio sounds corrupted or distorted on your GPU.'}</small>
                      </span>
                    </label>
                    {nativeAvailable ? (
                      <label className="toggle-row">
                        <input
                          type="checkbox"
                          checked={forceNative}
                          disabled={isGenerating}
                          onChange={(event) => {
                            const next = event.target.checked
                            setForceNative(next)
                            if (next) setForceWasm(false)
                            try {
                              window.localStorage.setItem('bettertts-backend', next ? 'native' : 'auto')
                            } catch { /* storage blocked */ }
                            resetKokoroSession()
                            resetTimestampedKokoroSession()
                            resetWorker()
                            resetNativeTts()
                          }}
                        />
                        <span>
                          Native engine (desktop)
                          <small>Synthesize with onnxruntime-node on the CPU — outside browser WASM limits.</small>
                        </span>
                      </label>
                    ) : null}
                    <label className="toggle-row">
                      <input
                        type="checkbox"
                        checked={wordTimestamps && englishKokoro}
                        disabled={isGenerating || !englishKokoro}
                        onChange={(event) => {
                          setWordTimestamps(event.target.checked)
                          resetTimestampedKokoroSession()
                        }}
                      />
                      <span>
                        Word timestamps
                        <small>{englishKokoro ? 'Opt in to the timestamped q8 model for word-level SRT/VTT and follow-along highlighting.' : 'Available for English Kokoro voices only.'}</small>
                      </span>
                    </label>
                  </>
                ) : null}

                {engine === 'kokoro' ? (
                  <label className="toggle-row">
                    <input type="checkbox" checked={dialogMode} onChange={(event) => setDialogMode(event.target.checked)} />
                    <span>
                      Dialog mode
                      <small>Map [speaker:Name] prefixes to voices.</small>
                    </span>
                  </label>
                ) : null}

                {dialogMode && engine === 'kokoro' ? (
                  <div className="speaker-map">
                    {[...new Set(parseDialogLines(usableText).map((d) => d.speaker).filter(Boolean))].map((name) => (
                      <div className="speaker-row" key={name}>
                        <span>{name}</span>
                        <select
                          aria-label={`Voice for ${name}`}
                          value={speakerMap[name!] ?? ''}
                          onChange={(e) => setSpeakerMap((prev) => ({ ...prev, [name!]: e.target.value }))}
                        >
                          <option value="">Default ({selectedVoice.name})</option>
                          {availableVoices.map((v) => (
                            <option value={v.id} key={v.id}>
                              {v.name} ({v.gender})
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                ) : null}

                {engine === 'kokoro' && englishKokoro ? (
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={voiceMixEnabled}
                      onChange={(event) => setVoiceMixEnabled(event.target.checked)}
                    />
                    <span>
                      Voice blend
                      <small>Mix two or more voices with adjustable weights.</small>
                    </span>
                  </label>
                ) : null}

                {voiceMixEnabled && engine === 'kokoro' && englishKokoro ? (
                  <div className="speaker-map">
                    {voiceMixEntries.map((entry, idx) => (
                      <div className="speaker-row" key={idx}>
                        <select
                          value={entry.voiceId}
                          onChange={(e) =>
                            setVoiceMixEntries((prev) =>
                              prev.map((ent, i) => (i === idx ? { ...ent, voiceId: e.target.value as typeof ent.voiceId } : ent)),
                            )
                          }
                          aria-label={`Mix voice ${idx + 1}`}
                        >
                          {blendableVoices.map((v) => (
                            <option value={v.id} key={v.id}>
                              {v.name} ({v.gender})
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          min={0.1}
                          max={10}
                          step={0.1}
                          value={entry.weight}
                          onChange={(e) =>
                            setVoiceMixEntries((prev) =>
                              prev.map((ent, i) =>
                                i === idx ? { ...ent, weight: Math.max(0.1, Number(e.target.value) || 1) } : ent,
                              ),
                            )
                          }
                          aria-label={`Weight for voice ${idx + 1}`}
                          className="mix-weight-input"
                        />
                        {voiceMixEntries.length > 2 ? (
                          <button
                            type="button"
                            className="heading-action"
                            onClick={() => setVoiceMixEntries((prev) => prev.filter((_, i) => i !== idx))}
                            aria-label={`Remove mix voice ${idx + 1}`}
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    ))}
                    {voiceMixEntries.length < 4 ? (
                      <button
                        type="button"
                        className="heading-action"
                        onClick={() =>
                          setVoiceMixEntries((prev) => [...prev, { voiceId: 'af_nova', weight: 1 }])
                        }
                      >
                        Add voice
                      </button>
                    ) : null}
                    <small className="mix-formula">
                      {formatMixFormula(voiceMixEntries)}
                    </small>
                  </div>
                ) : null}

                {engine === 'kokoro' ? (
                  <>
                    <button
                      type="button"
                      className="heading-action pron-toggle"
                      ref={pronunciationsToggleRef}
                      onClick={() => setShowPronunciations(!showPronunciations)}
                      aria-expanded={showPronunciations}
                    >
                      Pronunciations ({Object.keys(pronunciations).length})
                    </button>
                    {showPronunciations ? (
                      <div className="speaker-map" role="group" aria-label="Pronunciation dictionary" ref={pronunciationsSectionRef}>
                        {Object.entries(pronunciations).map(([word, pron]) => (
                          <div className="speaker-row" key={word}>
                            <span>{word}</span>
                            <span className="pron-replacement">{pron}</span>
                            <button
                              type="button"
                              className="heading-action"
                              aria-label={`Remove pronunciation for ${word}`}
                              onClick={() => setPronunciations((prev) => {
                                const next = { ...prev }
                                delete next[word]
                                return next
                              })}
                            >
                              <X size={12} aria-hidden="true" />
                            </button>
                          </div>
                        ))}
                        <div className="speaker-row">
                          <input
                            type="text"
                            className="pron-input"
                            placeholder="Word"
                            value={newWord}
                            onChange={(e) => setNewWord(e.target.value)}
                            aria-label="Pronunciation word"
                          />
                          <input
                            type="text"
                            className="pron-input"
                            placeholder="Sounds like"
                            value={newPronunciation}
                            onChange={(e) => setNewPronunciation(e.target.value)}
                            aria-label="Pronunciation replacement"
                          />
                          <button
                            type="button"
                            className="heading-action"
                            onClick={() => {
                              if (newWord.trim() && newPronunciation.trim()) {
                                setPronunciations((prev) => ({ ...prev, [newWord.trim()]: newPronunciation.trim() }))
                                setNewWord('')
                                setNewPronunciation('')
                              }
                            }}
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
            </div>

            <div className="settings-actions">
              <div className="generation-head">
                <span>Generation</span>
                <span>{progress !== null ? `${progress}%` : status}</span>
              </div>
              {progress !== null ? (
                <div
                  className="progress-wrap"
                  role="progressbar"
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Generation progress"
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
              ) : null}

              {genStats && !isGenerating ? (
                <div className="gen-stats">
                  <span>{genStats.elapsed.toFixed(1)}s elapsed</span>
                  <span>{Math.round(genStats.chars / genStats.elapsed)} chars/s</span>
                  <span>{genStats.audioDuration.toFixed(1)}s audio</span>
                  <span>{(genStats.audioDuration / genStats.elapsed).toFixed(1)}x realtime</span>
                </div>
              ) : null}

              {isGenerating ? (
                <button
                  type="button"
                  className="generate-button cancel"
                  onClick={cancelGeneration}
                >
                  <X size={18} aria-hidden="true" />
                  Cancel
                </button>
              ) : (
                <button type="button" className="generate-button" onClick={handleGenerate}>
                  <Waves size={18} aria-hidden="true" />
                  Generate audio
                </button>
              )}

              <button
                type="button"
                className="secondary-action"
                onClick={queueCurrentText}
                disabled={isGenerating || queueDisabledReason !== null}
                title={queueDisabledReason ?? 'Queue current text for file export.'}
              >
                <FileText size={16} aria-hidden="true" />
                Queue
              </button>
              {queueDisabledReason ? <small className="queue-disabled-note">{queueDisabledReason}</small> : null}
            </div>
          </aside>
        </section>

        <section className="technical-note" id="docs">
          <span>Local-first by design</span>
          <p>
            BetterTTS synthesizes on this device. The web edition uses WebGPU or WebAssembly; the desktop edition can use a verified native CPU model pack. Models download only when first needed and remain cached for reuse.
          </p>
          <a href="https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX" target="_blank" rel="noreferrer">
            Model card <ExternalLink size={15} aria-hidden="true" />
          </a>
        </section>

        <section className="lower-grid">
          <div className="model-panel" id="models">
            <div className="section-heading">
              <span>Model library</span>
              <a href="https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX" target="_blank" rel="noreferrer">
                View model
              </a>
            </div>
            <table>
              <caption className="sr-only">Available local speech engines and models</caption>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Engine</th>
                  <th>Size</th>
                  <th>Type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {MODEL_ROWS.map((row) => (
                  <tr key={row[0]}>
                    {row.map((cell, index) => (
                      <td key={cell} className={index === 4 ? `status-cell ${modelStatusClass(cell)}` : undefined}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p>Kokoro voices are wired for English, Spanish, French, Hindi, Italian, and Brazilian Portuguese. Kokoro Japanese and Chinese remain unavailable until a browser-safe G2P path is available; Piper-plus covers additional languages on device.</p>
            <div className="runtime-license-panel" aria-label="Runtime licenses">
              <div className="section-heading">
                <span>Runtime licenses</span>
              </div>
              <table>
                <caption className="sr-only">Licenses for runtime components</caption>
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>License</th>
                    <th>Used for</th>
                  </tr>
                </thead>
                <tbody>
                  {RUNTIME_LICENSE_ROWS.map((row) => (
                    <tr key={row[0]}>
                      {row.map((cell) => <td key={cell}>{cell}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>The GPL ephone/eSpeak path is not used for English Kokoro, Supertonic, KittenTTS, experimental Piper-plus, Browser voices, or normal export utilities.</p>
            </div>
          </div>

          <div className="hosting-panel">
            <div className="section-heading">
              <span>Privacy &amp; portability</span>
              <Info size={18} aria-hidden="true" />
            </div>
            <ul className="trust-list">
              <li><Check size={16} aria-hidden="true" /><span>No account, telemetry, or cloud render queue.</span></li>
              <li><Check size={16} aria-hidden="true" /><span>Scripts, generated audio, diagnostics, and imported text stay on this device.</span></li>
              <li><Check size={16} aria-hidden="true" /><span>Saved clips, queue jobs, and model caches remain under your control.</span></li>
            </ul>
            <a href="https://github.com/SysAdminDoc/BetterTTS#readme" target="_blank" rel="noreferrer">
              Project documentation <ExternalLink size={15} aria-hidden="true" />
            </a>
          </div>
        </section>
        </main>

        <footer>
          <div className="system-rail" aria-label="System status">
            <span>BetterTTS v{APP_VERSION}</span>
            <span><span className="status-dot" aria-hidden="true" /> Local only</span>
            <span>{runtimeLabel}</span>
            <span>{storageEstimate ?? 'Storage ready'}</span>
          </div>
          <button
            type="button"
            disabled={isGenerating}
            onClick={() => {
              resetKokoroSession()
              resetTimestampedKokoroSession()
              resetWorker()
              resetPiperPlusSession()
              if (nativeAvailable) resetNativeTts()
              for (const url of previewCacheRef.current.values()) {
                URL.revokeObjectURL(url)
              }
              previewCacheRef.current.clear()
              showToast({ tone: 'ok', message: 'Runtime sessions reset for this page.' })
            }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Reset session
          </button>
        </footer>

        {toast ? (
          <div className={`toast ${toast.tone}`} role={toast.tone === 'ok' ? 'status' : 'alert'}>
            {toast.tone === 'error'
              ? <AlertCircle size={17} aria-hidden="true" />
              : toast.tone === 'warn'
                ? <TriangleAlert size={17} aria-hidden="true" />
                : <Info size={17} aria-hidden="true" />}
            <span>{toast.message}</span>
            {toast.action ? (
              <button type="button" className="toast-action" onClick={() => runToastAction(toast.action!)}>
                {toast.action.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
  )
}

export default App
