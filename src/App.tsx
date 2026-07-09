import {
  AlertCircle,
  Captions,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FileText,
  Info,
  Loader2,
  Moon,
  Play,
  RefreshCw,
  Settings2,
  Share2,
  SquareCode,
  Sun,
  Trash2,
  Upload,
  Volume2,
  Waves,
  X,
} from 'lucide-react'
import { Component, type ChangeEvent, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { type AudioFormat, encodeAudio, formatExtension, mixBgm, opusSupported, shiftPitch } from './lib/encode.ts'
import { KOKORO_SAMPLE_RATE, type ProgressInfo, type RawAudioLike, loadKokoro, probeWebGpu, resetKokoroSession } from './lib/kokoro.ts'
import { loadTimestampedKokoro, resetTimestampedKokoroSession, synthesizeTimestampedKokoro } from './lib/kokoro-timestamps.ts'
import { needsDirectKokoroPath } from './lib/kokoro-direct.ts'
import { generateWorker, loadKokoroWorker, resetWorker } from './lib/kokoro-worker.ts'
import { type VoiceMixEntry, blendVoiceBins, fetchVoiceBin, formatMixFormula } from './lib/voice-mix.ts'
import { type ClipRecord, clearLibrary, deleteClip, enforceLibraryCap, getClipBlob, listClips, saveClip } from './lib/library.ts'
import { buildM4bFromBlobs, m4bSupported } from './lib/m4b.ts'
import {
  type EngineCacheStatus,
  type ModelCacheEngineId,
  type ModelCacheSummary,
  clearModelCache,
  prefetchKokoroQ8Pack,
  readModelCacheStatus,
} from './lib/model-cache.ts'
import { type QueueJob, deleteJob, getChunkBlob, jobProgress, listJobs, saveChunkBlob, saveJob } from './lib/queue.ts'
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
import { SUPERTONIC_DEFAULT_STEPS, SUPERTONIC_SAMPLE_RATE, SUPERTONIC_VOICES, type SupertonicVoiceId, clampSupertonicSpeed, loadSupertonic, synthesizeSupertonic } from './lib/supertonic.ts'
import { type CleanupOptions, DEFAULT_CLEANUP, PAUSE_TAG, cleanupText, formatBytes, parseDialogLines, parsePauseTags, slugify, splitInput, splitIntoSentences } from './lib/text.ts'
import { KOKORO_LANGUAGES, VOICES, isEnglishKokoroLocale, kokoroLanguageForLocale, kokoroLanguageForVoice, type KokoroLocale } from './lib/voices.ts'
import { type Cue, toSRT, toVTT } from './lib/subtitles.ts'
import { concatFloat32Arrays, encodeWav } from './lib/wav.ts'
import { speakBrowser } from './lib/webspeech.ts'

const APP_VERSION = '0.12.0'
const MAX_TEXT_CHARS = 5000
const EMPTY_VTT_URL = 'data:text/vtt;charset=utf-8,WEBVTT%0A%0A'

type Engine = 'kokoro' | 'supertonic' | 'kitten' | 'browser'
type Theme = 'dark' | 'light'

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
}

const STARTER_TEXT = `Welcome to BetterTTS — free text-to-speech that runs entirely in your browser.

No server, no signup, unlimited use — up to 5,000 characters per run. Your text never leaves this device.

Pick a voice from the panel on the right, then click Generate audio. The Kokoro 82M neural model will synthesize your text into natural-sounding speech.

Download as WAV or MP3 when you're done.`

const MODEL_ROWS = [
  ['Kokoro 82M', 'Kokoro local', '82M', 'EN / ES / FR / HI / IT / PT', 'Ready'],
  ['Kokoro timestamped', 'Kokoro local', '82M', 'Word-level timings', 'Opt-in'],
  ['Supertonic', 'Transformers.js', '66M', 'English speed engine', 'Ready'],
  ['KittenTTS', 'WebGPU shaders', '15M / 40M / 80M', 'English lightweight engine', 'Ready'],
  ['Kokoro multilingual', 'ephone + HF voice bins', '82M', 'ES / FR / HI / IT / PT', 'Ready'],
  ['Browser voices', 'Web Speech', 'Native', 'Device voices', 'Fallback'],
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

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

function cacheStatusText(row: EngineCacheStatus, supported: boolean): string {
  if (!supported) return 'Cache API unavailable'
  if (row.entryCount === 0) return 'Not cached'
  const fileLabel = row.entryCount === 1 ? 'file' : 'files'
  const size = row.sizeBytes > 0 ? formatBytes(row.sizeBytes) : 'size unknown'
  const unknown = row.unknownSizeCount > 0 ? ` + ${row.unknownSizeCount} unknown` : ''
  return `${row.entryCount} ${fileLabel} - ${size}${unknown}`
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

function ResultRow({ result, isSpeaking, onReplay, onShare, onSave }: ResultRowProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const activeCueRef = useRef<HTMLButtonElement | null>(null)
  const [followAlong, setFollowAlong] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const cues = useMemo(() => result.cues ?? [], [result.cues])

  useEffect(() => {
    const el = audioRef.current
    if (!el || !followAlong || cues.length === 0) return
    let timer: ReturnType<typeof setInterval> | null = null
    const sync = () => {
      const t = el.currentTime
      let idx = -1
      for (let i = 0; i < cues.length; i++) {
        if (t >= cues[i].startSec && t < cues[i].endSec) {
          idx = i
          break
        }
      }
      setActiveIdx(idx)
    }
    const start = () => {
      sync()
      if (!timer) timer = setInterval(sync, 100)
    }
    const stop = () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
    const end = () => {
      stop()
      setActiveIdx(-1)
    }
    el.addEventListener('play', start)
    el.addEventListener('pause', stop)
    el.addEventListener('seeked', sync)
    el.addEventListener('ended', end)
    if (!el.paused) start()
    return () => {
      stop()
      el.removeEventListener('play', start)
      el.removeEventListener('pause', stop)
      el.removeEventListener('seeked', sync)
      el.removeEventListener('ended', end)
    }
  }, [followAlong, cues])

  useEffect(() => {
    if (activeIdx < 0) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    activeCueRef.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
  }, [activeIdx])

  return (
    <div className="result-row">
      <div className="result-meta">
        <span className="ready-dot" aria-hidden="true" />
        <strong>{result.filename}</strong>
        <span>{result.duration}</span>
        <span>{result.size}</span>
      </div>
      {result.url ? (
        <audio ref={audioRef} controls src={result.url} aria-label={result.filename}>
          <track kind="captions" src={result.vttUrl ?? EMPTY_VTT_URL} srcLang="en" label={result.vttUrl ? 'English' : 'No captions'} />
        </audio>
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
          <button type="button" onClick={() => onShare(result)} aria-label="Share">
            <Share2 size={16} aria-hidden="true" />
          </button>
        ) : null}
        {result.url && cues.length > 0 ? (
          <button
            type="button"
            onClick={() => setFollowAlong(!followAlong)}
            aria-pressed={followAlong}
            className={followAlong ? 'follow-active' : undefined}
          >
            <Captions size={16} aria-hidden="true" />
            Follow
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
      {followAlong && cues.length > 0 ? (
        <div className="read-along" aria-label="Follow along transcript">
          {cues.map((cue, i) => (
            <button
              key={cue.index}
              ref={i === activeIdx ? activeCueRef : null}
              type="button"
              className={i === activeIdx ? 'cue active' : 'cue'}
              onClick={() => {
                const el = audioRef.current
                if (!el) return
                el.currentTime = cue.startSec + 0.001
                el.play().catch(() => {})
              }}
            >
              {cue.text}
            </button>
          ))}
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
    console.error(error, info.componentStack)
  }

  override render() {
    if (this.state.error) {
      return (
        <main className="fatal-shell">
          <section className="fatal-panel">
            <AlertCircle size={32} aria-hidden="true" />
            <h1>Something went wrong</h1>
            <p>{this.state.error.message}</p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload page
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
  const [engine, setEngine] = useState<Engine>('kokoro')
  const [locale, setLocale] = useState<KokoroLocale>('en-us')
  const [voiceId, setVoiceId] = useState('af_heart')
  const [supertonicVoiceId, setSupertonicVoiceId] = useState<SupertonicVoiceId>('F1')
  const [supertonicSteps, setSupertonicSteps] = useState(SUPERTONIC_DEFAULT_STEPS)
  const [kittenVoiceId, setKittenVoiceId] = useState<KittenVoiceId>('Bella')
  const [kittenModelSize, setKittenModelSize] = useState<KittenModelSize>(KITTEN_DEFAULT_MODEL)
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
  const [runtimeLabel, setRuntimeLabel] = useState(
    typeof navigator !== 'undefined' && 'gpu' in navigator ? 'WebGPU fp32' : 'WebAssembly q8',
  )
  const [modelCache, setModelCache] = useState<ModelCacheSummary | null>(null)
  const [cacheAction, setCacheAction] = useState<string | null>(null)
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([])
  const [browserVoiceUri, setBrowserVoiceUri] = useState('')
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null)
  const [genStats, setGenStats] = useState<{ elapsed: number; chars: number; audioDuration: number } | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
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
  const [m4bExportingJobId, setM4bExportingJobId] = useState<string | null>(null)
  const persistRequestedRef = useRef(false)
  const previewCacheRef = useRef<Map<string, string>>(new Map())
  const bgmInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const objectUrlsRef = useRef<string[]>([])
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const progressTimerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const abortRef = useRef(false)
  const generatingRef = useRef(false)

  const availableVoices = useMemo(() => VOICES.filter((voice) => voice.locale === locale), [locale])
  const selectedVoice = VOICES.find((voice) => voice.id === voiceId) ?? VOICES[0]
  const selectedSupertonicVoice = SUPERTONIC_VOICES.find((voice) => voice.id === supertonicVoiceId) ?? SUPERTONIC_VOICES[0]
  const selectedKittenVoice = KITTEN_VOICES.find((voice) => voice.id === kittenVoiceId) ?? KITTEN_VOICES[0]
  const selectedKittenModel = KITTEN_MODELS.find((model) => model.id === kittenModelSize) ?? KITTEN_MODELS[0]
  const selectedKokoroLanguage = kokoroLanguageForLocale(locale)
  const englishKokoro = isEnglishKokoroLocale(locale)
  const blendableVoices = useMemo(() => VOICES.filter((voice) => isEnglishKokoroLocale(voice.locale)), [])
  const kokoroRuntimeLabel = runtimeLabel.startsWith('Supertonic') ? (forceWasm ? 'WebAssembly q8' : 'WebGPU fp32 / WebAssembly q8') : runtimeLabel
  const kittenRuntimeReady = hasKittenWebGpu()
  const speedMin = engine === 'supertonic' ? 0.8 : 0.5
  const speedMax = engine === 'supertonic' ? 1.2 : engine === 'kitten' ? 2 : 1.5
  const lineNumbers = useMemo(() => text.split(/\r?\n/).map((_, index) => index + 1), [text])
  const usableText = text.slice(0, MAX_TEXT_CHARS)
  const overLimit = text.length > MAX_TEXT_CHARS
  const wordCount = useMemo(() => text.trim().split(/\s+/).filter(Boolean).length, [text])
  const lineCount = lineNumbers.length
  const cacheRows = modelCache?.engines ?? []
  const modelCached = (cacheRows.find((row) => row.id === 'kokoro')?.entryCount ?? 0) > 0
  const engineStatus =
    engine === 'kokoro'
      ? `${selectedKokoroLanguage.label} - ${kokoroRuntimeLabel}${modelCached ? ' - cached' : ''}${storageEstimate ? ` - ${storageEstimate}` : ''}`
      : engine === 'supertonic'
        ? 'English speed engine - 44.1 kHz fp32'
        : engine === 'kitten'
          ? `${selectedKittenModel.label} - ${selectedKittenModel.params} - ${kittenRuntimeReady ? 'WebGPU available' : 'WebGPU unavailable'}`
          : 'Device-native speech playback'

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { window.localStorage.setItem('bettertts-theme', theme) } catch { /* storage blocked */ }
  }, [theme])

  useEffect(() => {
    try { window.localStorage.setItem('bettertts-pronunciations', JSON.stringify(pronunciations)) } catch {}
  }, [pronunciations])

  useEffect(() => {
    try { window.localStorage.setItem('bettertts-cleanup', JSON.stringify(cleanup)) } catch {}
  }, [cleanup])

  useEffect(() => {
    if (forceWasm) {
      setRuntimeLabel('WebAssembly q8')
    } else {
      probeWebGpu().then((hasGpu) => setRuntimeLabel(hasGpu ? 'WebGPU fp32' : 'WebAssembly q8'))
    }
  }, [forceWasm])

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
        }
      })
      .catch(() => {})
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

  useEffect(() => {
    listClips().then(setLibrary).catch(() => {})
    listJobs().then((jobs) => {
      setQueueJobs(jobs)
      const incomplete = jobs.find((j) => j.chunks.some((c) => c.status === 'pending'))
      if (incomplete) {
        showToast({ tone: 'ok', message: `Resumable job: "${incomplete.title}" (${jobProgress(incomplete).pct}% done). Open the queue panel to resume.` })
      }
    }).catch(() => {})
    refreshStorageEstimate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onUpdateReady = () =>
      showToast({ tone: 'ok', message: 'A new version is ready — refresh the page to update.' })
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

  function showToast(nextToast: Toast) {
    setToast(nextToast)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => {
      setToast((current) => (current?.message === nextToast.message ? null : current))
      toastTimerRef.current = null
    }, 5500)
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
    return ensureKokoroEngine(onProgress)
  }

  async function runSynthesis(jobs: SynthJob[], opts: { zipPrefix: string; successMessage?: string }) {
    const loadingLabel = engine === 'supertonic' ? 'Loading Supertonic model' : engine === 'kitten' ? 'Loading KittenTTS model' : 'Loading Kokoro model'
    setStatus(loadingLabel)
    setProgress(3)

    const fileTotals = new Map<string, { loaded: number; total: number }>()
    const onProgress = (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
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
    const outputSampleRate = engine === 'supertonic' ? SUPERTONIC_SAMPLE_RATE : engine === 'kitten' ? KITTEN_SAMPLE_RATE : KOKORO_SAMPLE_RATE
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
      saveClip(
        { id: result.id, filename, label: result.label, voice: job.voice, speed, createdAt: Date.now(), size: blob.size, duration: result.duration },
        blob,
      )
        .then(() => enforceLibraryCap())
        .catch((err: unknown) => {
          if (!warnedQuota && err instanceof DOMException && err.name === 'QuotaExceededError') {
            warnedQuota = true
            showToast({ tone: 'warn', message: 'Storage is full — clip not saved. Clear the library or delete old clips.' })
          }
        })
    }

    if (audioCtx) {
      const ctx = audioCtx
      if (abortRef.current) {
        ctx.close().catch(() => {})
      } else {
        const delayMs = Math.max(0, (nextPlayTime - ctx.currentTime) * 1000) + 200
        setTimeout(() => {
          ctx.close().catch(() => {})
        }, delayMs)
      }
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
        navigator.storage?.persist?.().catch(() => {})
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
    } else {
      setStatus('Local audio ready')
      showToast({ tone: 'ok', message: opts.successMessage ?? 'Audio generated locally in your browser.' })
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

  async function generateBrowser(chunks: string[]) {
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
    } catch {
      showToast({ tone: 'warn', message: 'Preview requires the model to be loaded first.' })
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
        type: result.filename.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
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
      const writable = await handle.createWritable()
      const res = await fetch(result.url)
      const blob = await res.blob()
      await writable.write(blob)
      await writable.close()
      showToast({ tone: 'ok', message: `Saved ${result.filename}` })
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        showToast({ tone: 'warn', message: 'Save cancelled.' })
      }
    }
  }

  async function importFromUrl(rawUrl: string) {
    const url = rawUrl.trim()
    if (!url || importingUrl) return
    setImportingUrl(true)
    setStatus('Fetching article…')
    try {
      const target = /^https?:\/\//i.test(url) ? url : `https://${url}`
      const res = await fetch(target, { mode: 'cors' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const html = await res.text()
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const { Readability } = await import('@mozilla/readability')
      const article = new Readability(doc).parse()
      const textContent = (article?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
      if (!textContent) throw new Error('No readable text found')
      const truncated = textContent.length > MAX_TEXT_CHARS
      setText(textContent.slice(0, MAX_TEXT_CHARS))
      setImportUrlValue('')
      showToast(
        truncated
          ? { tone: 'warn', message: `Imported "${article?.title ?? 'article'}" — trimmed to ${MAX_TEXT_CHARS} characters.` }
          : { tone: 'ok', message: `Imported "${article?.title ?? 'article'}".` },
      )
    } catch {
      showToast({
        tone: 'warn',
        message: 'Could not read that page — most sites block cross-origin reads. Paste the article text instead.',
      })
    } finally {
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

  async function queueCurrentText() {
    if (!usableText.trim()) return
    const chunks = splitInput(cleanupText(usableText, cleanup), separateLines)
    if (chunks.length === 0) return
    const job: QueueJob = {
      id: crypto.randomUUID(),
      title: usableText.slice(0, 50).replace(/\s+/g, ' ').trim(),
      createdAt: Date.now(),
      voice: selectedVoice.id,
      language: locale,
      speed,
      format: audioFormat,
      bitrate: mp3Bitrate,
      chunks: chunks.map((text, i) => ({ index: i, text, status: 'pending' as const })),
    }
    await saveJob(job)
    setQueueJobs((prev) => [job, ...prev])
    showToast({ tone: 'ok', message: `Queued "${job.title}" — ${job.chunks.length} chunks.` })
  }

  async function resumeJob(jobId: string) {
    if (generatingRef.current) return
    const jobs = await listJobs()
    const job = jobs.find((j) => j.id === jobId)
    if (!job) return

    generatingRef.current = true
    setIsGenerating(true)
    setActiveJobId(jobId)
    abortRef.current = false

    try {
      const onProgress = (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (info.status === 'ready') setStatus('Model ready')
      }
      const { synthesize } = await ensureKokoroEngine(onProgress, { wordTimestamps: false })

      for (const chunk of job.chunks) {
        if (abortRef.current) break
        if (chunk.status === 'done') continue
        chunk.status = 'generating'
        await saveJob(job)
        setQueueJobs((prev) => prev.map((j) => (j.id === jobId ? { ...job } : j)))

        try {
          const sentences = splitIntoSentences(applyPronunciations(chunk.text))
          const parts: Float32Array[] = []
          for (const sentence of sentences) {
            if (abortRef.current) break
            const audio = await synthesize(sentence, job.voice, job.speed)
            if (audio) parts.push(audio.samples)
          }
          if (parts.length > 0) {
            const raw = concatFloat32Arrays(parts)
            const blob = await encodeAudio(raw, KOKORO_SAMPLE_RATE, job.format, job.bitrate)
            await saveChunkBlob(jobId, chunk.index, blob)
            chunk.status = 'done'
          } else {
            chunk.status = 'failed'
            chunk.error = 'No audio produced'
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
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'Queue failed' })
    } finally {
      generatingRef.current = false
      setIsGenerating(false)
      setActiveJobId(null)
      setProgress(null)
      setStatus('Ready')
    }
  }

  async function downloadJobZip(jobId: string) {
    const job = queueJobs.find((j) => j.id === jobId)
    if (!job) return
    const doneChunks = job.chunks.filter((c) => c.status === 'done')
    if (doneChunks.length === 0) return

    const { zip } = await import('fflate')
    const entries: Record<string, Uint8Array> = {}
    for (const chunk of doneChunks) {
      const blob = await getChunkBlob(jobId, chunk.index)
      if (blob) {
        const ext = formatExtension(job.format)
        entries[`${String(chunk.index + 1).padStart(3, '0')}-${slugify(chunk.text)}${ext}`] =
          new Uint8Array(await blob.arrayBuffer())
      }
    }
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
  }

  async function downloadJobM4b(jobId: string) {
    const job = queueJobs.find((j) => j.id === jobId)
    if (!job || m4bExportingJobId) return
    if (job.chunks.some((chunk) => chunk.status !== 'done')) {
      showToast({ tone: 'warn', message: 'Finish every queue chunk before exporting M4B.' })
      return
    }
    if (!m4bSupported()) {
      showToast({ tone: 'warn', message: 'M4B export requires Chromium or another browser with WebCodecs AAC.' })
      return
    }

    setM4bExportingJobId(jobId)
    setStatus('Building M4B audiobook...')
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

      const { blob, chapterCount } = await buildM4bFromBlobs({
        title: job.title,
        chunks,
        bitrate: Math.max(64, Math.min(192, job.bitrate)) * 1000,
        onProgress(info) {
          const phaseBase = info.phase === 'decode' ? 5 : info.phase === 'encode' ? 35 : 90
          const phaseSpan = info.phase === 'decode' ? 30 : info.phase === 'encode' ? 55 : 10
          const pct = info.total > 0 ? phaseBase + Math.round((info.done / info.total) * phaseSpan) : phaseBase
          setProgress(Math.min(99, pct))
          setStatus(info.phase === 'decode' ? 'Decoding queue audio...' : info.phase === 'encode' ? 'Encoding AAC...' : 'Writing M4B chapters...')
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

  async function handleEpubImport(file: File) {
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
      const job: QueueJob = {
        id: crypto.randomUUID(),
        title: file.name.replace(/\.epub$/i, ''),
        createdAt: Date.now(),
        voice: selectedVoice.id,
        language: locale,
        speed,
        format: audioFormat,
        bitrate: mp3Bitrate,
        chunks: allChunks.map((c, i) => ({
          index: i,
          text: c.text.slice(0, MAX_TEXT_CHARS),
          chapterTitle: c.title,
          chapterIndex: c.chapterIndex,
          status: 'pending' as const,
        })),
      }
      await saveJob(job)
      setQueueJobs((prev) => [job, ...prev])
      const skipped = chapters.filter((ch) => !ch.text.trim()).length
      showToast({
        tone: 'ok',
        message: `Imported "${job.title}" — ${chapters.length} chapters, ${job.chunks.length} chunks.${skipped > 0 ? ` ${skipped} empty chapters skipped.` : ''}`,
      })
    } catch (err) {
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'EPUB import failed.' })
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

    if (file.name.toLowerCase().endsWith('.epub')) {
      handleEpubImport(file)
      return
    }

    if (!file.name.toLowerCase().endsWith('.txt') && file.type !== 'text/plain') {
      showToast({ tone: 'warn', message: 'Import supports .txt and .epub files.' })
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const raw = String(reader.result ?? '')
      const truncated = raw.length > MAX_TEXT_CHARS
      setText(raw.slice(0, MAX_TEXT_CHARS))
      showToast(
        truncated
          ? { tone: 'warn', message: `${file.name} truncated from ${raw.length} to ${MAX_TEXT_CHARS} characters.` }
          : { tone: 'ok', message: `${file.name} imported.` },
      )
    }
    reader.onerror = () => showToast({ tone: 'error', message: 'File import failed.' })
    reader.readAsText(file)
  }

  return (
      <main className="app-shell">
        <header className="topbar">
          <a className="brand" href="#studio" aria-label="BetterTTS home">
            <span className="brand-mark" aria-hidden="true">
              <Waves size={25} strokeWidth={2.2} />
            </span>
            <span>BetterTTS</span>
          </a>
          <nav className="nav-links" aria-label="Primary">
            <a href="#studio" aria-current="page">
              Voice Studio
            </a>
            <a href="#models">Models</a>
            <a href="#docs">Docs</a>
            <a href="https://github.com/SysAdminDoc/BetterTTS" target="_blank" rel="noreferrer">
              GitHub <ExternalLink size={14} aria-hidden="true" />
            </a>
          </nav>
          <div className="topbar-status" aria-label="Runtime status">
            <span className="status-dot" aria-hidden="true" />
            <span>No backend</span>
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

        <section className="studio-grid" id="studio">
          <div className="editor-column">
            <div className="section-heading">
              <span>Script editor</span>
              <span className={overLimit ? 'danger-text' : ''}>
                {text.length} / {MAX_TEXT_CHARS}
                {overLimit ? ` (${text.length - MAX_TEXT_CHARS} over)` : ''}
              </span>
            </div>
            <div className="editor-frame">
              <div className="line-numbers" aria-hidden="true">
                {lineNumbers.map((lineNumber) => (
                  <span key={lineNumber}>{lineNumber}</span>
                ))}
              </div>
              <textarea
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
              <span>Plain text</span>
              <span>{cleanup.markdown ? 'Cleanup on' : 'Cleanup off'}</span>
            </div>
            <div className="editor-actions">
              <button type="button" onClick={() => setText('')}>
                <X size={16} aria-hidden="true" />
                New
              </button>
              <button type="button" onClick={() => fileInputRef.current?.click()}>
                <Upload size={16} aria-hidden="true" />
                Open
              </button>
              <input ref={fileInputRef} type="file" accept=".txt,.epub,text/plain,application/epub+zip" onChange={handleFileUpload} hidden />
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
            </div>

            <section className="output-panel" aria-label="Generated audio">
              <div className="section-heading">
                <span>Output deck</span>
                <span aria-live="polite">{status}</span>
              </div>
              <div className="surface-tabs" aria-label="Output views">
                <span className="active">Output</span>
                <span>Timeline</span>
                <span>Captions</span>
              </div>
              {results.length === 0 ? (
                <div className="empty-output">
                  <Volume2 size={28} aria-hidden="true" />
                  <strong>No audio generated yet</strong>
                  <small>Choose a voice and click Generate audio to start.</small>
                </div>
              ) : (
                <div className="result-list">
                  {results.map((result) => (
                    <ResultRow
                      key={result.id}
                      result={result}
                      isSpeaking={isSpeaking}
                      onReplay={replayBrowser}
                      onShare={shareResult}
                      onSave={saveWithPicker}
                    />
                  ))}
                  {zipUrl ? (
                    <a className="zip-download" href={zipUrl} download={zipName}>
                      <Download size={17} aria-hidden="true" />
                      Download all ZIP
                    </a>
                  ) : null}
                </div>
              )}
              <p className="privacy-note">
                <Info size={16} aria-hidden="true" />
                100% private — your text and audio never leave this browser. Model files are cached locally after first use.
              </p>
            </section>

            <div className="workspace-secondary-grid">
            {queueJobs.length > 0 ? (
              <section className="output-panel" aria-label="Generation queue">
                <div className="section-heading">
                  <span>Queue ({queueJobs.length})</span>
                </div>
                <div className="result-list">
                  {queueJobs.map((job) => {
                    const { done, total, pct } = jobProgress(job)
                    const isActive = activeJobId === job.id
                    return (
                      <div className="result-row" key={job.id}>
                        <div className="result-meta">
                          <span className="ready-dot" aria-hidden="true" />
                          <strong>{job.title}</strong>
                          <span>{done}/{total} chunks</span>
                          <span>{pct}%</span>
                        </div>
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
                            <button type="button" onClick={() => downloadJobZip(job.id)}>
                              <Download size={16} aria-hidden="true" />
                              ZIP
                            </button>
                          ) : null}
                          {done === total && total > 0 ? (
                            <button type="button" onClick={() => downloadJobM4b(job.id)} disabled={m4bExportingJobId !== null}>
                              {m4bExportingJobId === job.id ? <Loader2 size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
                              M4B
                            </button>
                          ) : null}
                          {!isActive ? (
                            <button
                              type="button"
                              onClick={() => {
                                deleteJob(job.id).then(() => setQueueJobs((prev) => prev.filter((j) => j.id !== job.id))).catch(() => {})
                              }}
                            >
                              <Trash2 size={16} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            ) : (
              <section className="output-panel" aria-label="Generation queue">
                <div className="section-heading">
                  <span>Queue (0)</span>
                </div>
                <div className="compact-empty">
                  <FileText size={28} aria-hidden="true" />
                  <strong>Queue is empty</strong>
                  <span>Add long-form Kokoro jobs when you need resumable chapter output.</span>
                </div>
              </section>
            )}

            {library.length > 0 ? (
              <section className="output-panel" aria-label="Clip library">
                <div className="section-heading">
                  <span>Library ({library.length})</span>
                  <button
                    type="button"
                    className="heading-action"
                    onClick={() => {
                      clearLibrary().then(() => setLibrary([])).catch(() => {})
                    }}
                  >
                    Clear all
                  </button>
                </div>
                <div className="result-list">
                  {library.map((clip) => (
                    <div className="result-row library-row" key={clip.id}>
                      <div className="result-meta">
                        <span className="ready-dot" aria-hidden="true" />
                        <strong>{clip.label}</strong>
                        <span>{clip.duration}</span>
                        <span>{formatBytes(clip.size)}</span>
                      </div>
                      <div className="result-actions">
                        <button
                          type="button"
                          onClick={async () => {
                            const blob = await getClipBlob(clip.id)
                            if (blob) {
                              const url = URL.createObjectURL(blob)
                              const a = document.createElement('a')
                              a.href = url
                              a.download = clip.filename
                              a.click()
                              // Immediate revocation can abort the save in Safari.
                              setTimeout(() => URL.revokeObjectURL(url), 1000)
                            }
                          }}
                        >
                          <Download size={16} aria-hidden="true" />
                          Download
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            deleteClip(clip.id)
                              .then(() => setLibrary((prev) => prev.filter((c) => c.id !== clip.id)))
                              .catch(() => {})
                          }}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <section className="output-panel" aria-label="Clip library">
                <div className="section-heading">
                  <span>Library (0)</span>
                </div>
                <div className="compact-empty">
                  <Download size={28} aria-hidden="true" />
                  <strong>No saved clips</strong>
                  <span>Saved generations appear here with download actions.</span>
                </div>
              </section>
            )}
            </div>
          </div>

          <aside className="settings-panel" aria-label="Voice settings">
            <div className="settings-scroll">
            <div className="section-heading">
              <span>Control console</span>
              <span>v{APP_VERSION}</span>
            </div>

            <fieldset>
              <legend>Engine</legend>
              <div className="engine-grid">
                <button
                  type="button"
                  className={engine === 'kokoro' ? 'engine-card selected' : 'engine-card'}
                  onClick={() => setEngine('kokoro')}
                >
                  <span>{engine === 'kokoro' ? <Check size={17} aria-hidden="true" /> : null}</span>
                  <strong>Kokoro local</strong>
                  <small>
                    {selectedKokoroLanguage.label}. {kokoroRuntimeLabel}. WAV export.{kokoroRuntimeLabel === 'WebAssembly q8' ? ' Pages-hosted English model.' : ' HF model.'}{modelCached ? ' Model cached.' : ''}
                    {storageEstimate ? ` ${storageEstimate}.` : ''}
                  </small>
                </button>
                <button
                  type="button"
                  className={engine === 'supertonic' ? 'engine-card selected' : 'engine-card'}
                  onClick={() => setEngine('supertonic')}
                >
                  <span>{engine === 'supertonic' ? <Check size={17} aria-hidden="true" /> : null}</span>
                  <strong>Supertonic</strong>
                  <small>English speed engine. 44.1 kHz fp32, lazy-loaded from HF.</small>
                </button>
                <button
                  type="button"
                  className={engine === 'kitten' ? 'engine-card selected' : 'engine-card'}
                  onClick={() => setEngine('kitten')}
                >
                  <span>{engine === 'kitten' ? <Check size={17} aria-hidden="true" /> : null}</span>
                  <strong>KittenTTS</strong>
                  <small>{selectedKittenModel.label} {selectedKittenModel.params}. English WebGPU engine, {selectedKittenModel.weightSize} on first use.</small>
                </button>
                <button
                  type="button"
                  className={engine === 'browser' ? 'engine-card selected' : 'engine-card'}
                  onClick={() => setEngine('browser')}
                >
                  <span>{engine === 'browser' ? <Check size={17} aria-hidden="true" /> : null}</span>
                  <strong>Browser</strong>
                  <small>Native speech playback when Kokoro cannot run.</small>
                </button>
              </div>
              <div className="engine-status">
                <span className="status-dot" aria-hidden="true" />
                <span>{engineStatus}</span>
              </div>
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
                  <p className="cache-empty">Checking model cache...</p>
                )}
              </div>
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
              onClick={() => setShowAdvanced(!showAdvanced)}
              aria-expanded={showAdvanced}
            >
              <Settings2 size={15} aria-hidden="true" />
              Advanced options
              <ChevronDown size={15} aria-hidden="true" className={showAdvanced ? 'chevron-open' : ''} />
            </button>

            {showAdvanced ? (
              <div className="advanced-section">
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
                        </button>
                      ) : null}
                      <input ref={bgmInputRef} type="file" accept="audio/*" onChange={(e) => { setBgmFile(e.target.files?.[0] ?? null); e.target.value = '' }} hidden />
                    </div>
                    {bgmFile ? (
                      <div className="range-row" style={{ marginBottom: 0 }}>
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
                        disabled={isGenerating}
                        onChange={(event) => {
                          const next = event.target.checked
                          setForceWasm(next)
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
                        <small>Use if audio sounds corrupted or distorted on your GPU.</small>
                      </span>
                    </label>
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
                          style={{ width: 56, textAlign: 'center' }}
                        />
                        {voiceMixEntries.length > 2 ? (
                          <button
                            type="button"
                            className="heading-action"
                            onClick={() => setVoiceMixEntries((prev) => prev.filter((_, i) => i !== idx))}
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
                    <small style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {formatMixFormula(voiceMixEntries)}
                    </small>
                  </div>
                ) : null}

                {engine === 'kokoro' ? (
                  <>
                    <button
                      type="button"
                      className="heading-action pron-toggle"
                      onClick={() => setShowPronunciations(!showPronunciations)}
                      aria-expanded={showPronunciations}
                    >
                      Pronunciations ({Object.keys(pronunciations).length})
                    </button>
                    {showPronunciations ? (
                      <div className="speaker-map">
                        {Object.entries(pronunciations).map(([word, pron]) => (
                          <div className="speaker-row" key={word}>
                            <span>{word}</span>
                            <span className="pron-replacement">{pron}</span>
                            <button
                              type="button"
                              className="heading-action"
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
                            placeholder="Says as"
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
                  onClick={() => {
                    abortRef.current = true
                    setStatus('Cancelling…')
                  }}
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

              {engine === 'kokoro' ? (
                <button type="button" className="secondary-action" onClick={queueCurrentText} disabled={isGenerating || !usableText.trim()}>
                  <FileText size={16} aria-hidden="true" />
                  Queue
                </button>
              ) : null}
              <button type="button" className="secondary-action" onClick={clearOutputs}>
                <Trash2 size={16} aria-hidden="true" />
                Clear output
              </button>
            </div>
          </aside>
        </section>

        <section className="technical-note" id="docs">
          <span>How it works</span>
          <p>
            Kokoro 82M and Supertonic run locally in your browser via Transformers.js; KittenTTS runs through its WebGPU shader engine. English Kokoro WASM q8 loads from this site first; multilingual voice bins, timestamped Kokoro, Supertonic, KittenTTS weights, and Kokoro WebGPU fp32 remain HF-hosted. No server involved.
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
                      <td key={cell} className={index === 4 ? 'status-cell' : undefined}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p>Kokoro voices are wired for English, Spanish, French, Hindi, Italian, and Brazilian Portuguese. Japanese and Chinese remain unwired until a browser-safe G2P path is available.</p>
          </div>

          <div className="hosting-panel">
            <div className="section-heading">
              <span>Hosting on GitHub Pages</span>
              <SquareCode size={18} aria-hidden="true" />
            </div>
            <p>BetterTTS builds to plain static files. No backend, no database, no GitHub Actions.</p>
            <pre>
              <code>{`npm install
npm run build
git subtree push --prefix dist origin gh-pages
# In repo settings, serve Pages from gh-pages / root`}</code>
            </pre>
            <a href="https://docs.github.com/pages" target="_blank" rel="noreferrer">
              GitHub Pages docs <ExternalLink size={15} aria-hidden="true" />
            </a>
          </div>
        </section>

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
              for (const url of previewCacheRef.current.values()) {
                URL.revokeObjectURL(url)
              }
              previewCacheRef.current.clear()
              showToast({ tone: 'ok', message: 'Model cache handle reset for this page session.' })
            }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Reset session
          </button>
        </footer>

        {toast ? (
          <div className={`toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
            {toast.tone === 'error' ? <AlertCircle size={17} aria-hidden="true" /> : <Info size={17} aria-hidden="true" />}
            <span>{toast.message}</span>
          </div>
        ) : null}
      </main>
  )
}

export default App
