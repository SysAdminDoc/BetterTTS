import {
  AlertCircle,
  Check,
  Download,
  ExternalLink,
  FileText,
  Info,
  Loader2,
  Moon,
  Play,
  RefreshCw,
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

const APP_VERSION = '0.1.0'
const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const KOKORO_SAMPLE_RATE = 24000
const MAX_TEXT_CHARS = 5000

type Engine = 'kokoro' | 'browser'
type Theme = 'dark' | 'light'

type VoiceId =
  | 'am_adam' | 'am_puck' | 'am_liam' | 'af_heart' | 'af_bella' | 'af_nova'
  | 'af_alloy' | 'af_jessica' | 'af_kore' | 'af_nicole' | 'af_river' | 'af_sarah'
  | 'am_echo' | 'am_eric' | 'am_fenrir' | 'am_michael' | 'am_onyx' | 'am_santa'
  | 'bf_alice' | 'bf_emma' | 'bf_isabella' | 'bf_lily'
  | 'bm_daniel' | 'bm_fable' | 'bm_george' | 'bm_lewis'

type Voice = {
  id: VoiceId
  name: string
  locale: 'en-us' | 'en-gb'
  gender: 'Female' | 'Male'
  grade: string
}

type AudioResult = {
  id: string
  filename: string
  label: string
  duration: string
  size: string
  url?: string
  replayText?: string
}

type Toast = {
  tone: 'ok' | 'warn' | 'error'
  message: string
}

type ProgressInfo = {
  status?: string
  file?: string
  progress?: number
}

type KokoroModule = typeof import('kokoro-js')
type KokoroInstance = Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>
type RawAudioLike = {
  audio?: Float32Array
  sampling_rate?: number
  toBlob?: () => Blob
}

const VOICES: Voice[] = [
  { id: 'am_adam', name: 'Adam', locale: 'en-us', gender: 'Male', grade: 'F+' },
  { id: 'am_puck', name: 'Puck', locale: 'en-us', gender: 'Male', grade: 'C+' },
  { id: 'am_liam', name: 'Liam', locale: 'en-us', gender: 'Male', grade: 'D' },
  { id: 'af_heart', name: 'Heart', locale: 'en-us', gender: 'Female', grade: 'A' },
  { id: 'af_bella', name: 'Bella', locale: 'en-us', gender: 'Female', grade: 'A-' },
  { id: 'af_nova', name: 'Nova', locale: 'en-us', gender: 'Female', grade: 'C' },
  { id: 'af_alloy', name: 'Alloy', locale: 'en-us', gender: 'Female', grade: 'C' },
  { id: 'af_jessica', name: 'Jessica', locale: 'en-us', gender: 'Female', grade: 'D' },
  { id: 'af_kore', name: 'Kore', locale: 'en-us', gender: 'Female', grade: 'C+' },
  { id: 'af_nicole', name: 'Nicole', locale: 'en-us', gender: 'Female', grade: 'B-' },
  { id: 'af_river', name: 'River', locale: 'en-us', gender: 'Female', grade: 'D' },
  { id: 'af_sarah', name: 'Sarah', locale: 'en-us', gender: 'Female', grade: 'C+' },
  { id: 'am_echo', name: 'Echo', locale: 'en-us', gender: 'Male', grade: 'D' },
  { id: 'am_eric', name: 'Eric', locale: 'en-us', gender: 'Male', grade: 'D' },
  { id: 'am_fenrir', name: 'Fenrir', locale: 'en-us', gender: 'Male', grade: 'C+' },
  { id: 'am_michael', name: 'Michael', locale: 'en-us', gender: 'Male', grade: 'C+' },
  { id: 'am_onyx', name: 'Onyx', locale: 'en-us', gender: 'Male', grade: 'D' },
  { id: 'am_santa', name: 'Santa', locale: 'en-us', gender: 'Male', grade: 'D-' },
  { id: 'bf_alice', name: 'Alice', locale: 'en-gb', gender: 'Female', grade: 'D' },
  { id: 'bf_emma', name: 'Emma', locale: 'en-gb', gender: 'Female', grade: 'B-' },
  { id: 'bf_isabella', name: 'Isabella', locale: 'en-gb', gender: 'Female', grade: 'C' },
  { id: 'bf_lily', name: 'Lily', locale: 'en-gb', gender: 'Female', grade: 'D' },
  { id: 'bm_daniel', name: 'Daniel', locale: 'en-gb', gender: 'Male', grade: 'D' },
  { id: 'bm_fable', name: 'Fable', locale: 'en-gb', gender: 'Male', grade: 'C' },
  { id: 'bm_george', name: 'George', locale: 'en-gb', gender: 'Male', grade: 'C' },
  { id: 'bm_lewis', name: 'Lewis', locale: 'en-gb', gender: 'Male', grade: 'D+' },
]

const STARTER_TEXT = `TTS4FREE is a free client-side text-to-speech web app.

It recreates the practical workflow of voice-generator.com without needing a private backend.

Choose a voice. Select an engine.
Click Generate audio and download your WAV.

Kokoro runs locally in your browser when supported.
Browser fallback keeps playback working everywhere.`

const MODEL_ROWS = [
  ['Kokoro 82M', 'Kokoro local', '82M', 'English US / GB', 'Ready'],
  ['Kokoro multilingual', 'Planned local pack', '137M+', 'JP / ZH / ES / FR / HI / IT / PT', 'Next'],
  ['Browser voices', 'Web Speech', 'Native', 'Device voices', 'Fallback'],
  ['Piper packs', 'Static model packs', 'Varies', 'Optional', 'Later'],
]

let kokoroPromise: Promise<KokoroInstance> | null = null

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  try {
    const saved = window.localStorage.getItem('tts4free-theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* storage blocked */ }
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light'
  return 'dark'
}

async function probeWebGpu(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false
  try {
    const gpu = navigator.gpu as { requestAdapter(): Promise<unknown | null> }
    const adapter = await gpu.requestAdapter()
    return adapter != null
  } catch {
    return false
  }
}

async function loadKokoro(onProgress: (info: ProgressInfo) => void) {
  if (kokoroPromise) return kokoroPromise

  const [{ KokoroTTS }, hasWebGpu] = await Promise.all([
    import('kokoro-js'),
    probeWebGpu(),
  ])

  const device = hasWebGpu ? ('webgpu' as const) : ('wasm' as const)
  const dtype = hasWebGpu ? ('fp32' as const) : ('q8' as const)

  const promise = KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
    device,
    dtype,
    progress_callback: (info) => onProgress(info as ProgressInfo),
  })
  kokoroPromise = promise

  try {
    return await promise
  } catch (err) {
    kokoroPromise = null
    if (hasWebGpu) {
      const fallback = KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: (info) => onProgress(info as ProgressInfo),
      })
      kokoroPromise = fallback
      try {
        return await fallback
      } catch {
        kokoroPromise = null
        throw err
      }
    }
    throw err
  }
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)

  return slug || 'tts4free-audio'
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} kB`
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function getDurationLabel(blob: Blob) {
  const url = URL.createObjectURL(blob)
  try {
    const audio = document.createElement('audio')
    audio.preload = 'metadata'

    return await new Promise<string>((resolve) => {
      audio.onloadedmetadata = () => {
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0
        resolve(`${duration.toFixed(1)}s`)
      }
      audio.onerror = () => resolve('ready')
      audio.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

function encodeWav(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }

  return buffer
}

function writeString(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

function splitInput(text: string, separateLines: boolean) {
  const normalized = text.trim()
  if (!normalized) {
    return []
  }

  if (!separateLines) {
    return [normalized]
  }

  return normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

type TextSegment = { type: 'text'; content: string } | { type: 'pause'; duration: number }

const PAUSE_TAG = /\[pause(?:\s+([\d.]+)\s*s?)?\]/gi

function parsePauseTags(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(PAUSE_TAG)) {
    const before = text.slice(lastIndex, match.index)
    if (before.trim()) segments.push({ type: 'text', content: before.trim() })
    const duration = match[1] ? Number.parseFloat(match[1]) : 1
    if (duration > 0 && duration <= 30) segments.push({ type: 'pause', duration })
    lastIndex = match.index + match[0].length
  }

  const tail = text.slice(lastIndex)
  if (tail.trim()) segments.push({ type: 'text', content: tail.trim() })
  return segments.length > 0 ? segments : [{ type: 'text', content: text.trim() }]
}

function splitIntoSentences(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  if (sentences.length === 0) return text.trim() ? [text.trim()] : []

  const chunks: string[] = []
  let buffer = ''

  for (const s of sentences) {
    if (buffer && buffer.length + s.length + 1 > 300) {
      chunks.push(buffer)
      buffer = s
    } else {
      buffer = buffer ? `${buffer} ${s}` : s
    }
  }
  if (buffer) chunks.push(buffer)
  return chunks
}

function concatFloat32Arrays(arrays: Float32Array[]): Float32Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0)
  const result = new Float32Array(total)
  let offset = 0
  for (const a of arrays) {
    result.set(a, offset)
    offset += a.length
  }
  return result
}

function getBrowserVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis
  const voices = synth.getVoices()
  if (voices.length > 0) return Promise.resolve(voices)

  return new Promise((resolve) => {
    const onReady = () => {
      synth.removeEventListener('voiceschanged', onReady)
      resolve(synth.getVoices())
    }
    synth.addEventListener('voiceschanged', onReady)
    setTimeout(() => {
      synth.removeEventListener('voiceschanged', onReady)
      resolve(synth.getVoices())
    }, 2000)
  })
}

async function speakBrowser(text: string, speed: number, chosenVoice?: SpeechSynthesisVoice) {
  if (!('speechSynthesis' in window)) {
    throw new Error('This browser does not expose speech synthesis.')
  }

  const synth = window.speechSynthesis
  synth.cancel()

  const voice = chosenVoice ?? (await getBrowserVoices()).find((v) => v.lang.toLowerCase().startsWith('en')) ?? null
  const chunks = splitIntoSentences(text)
  const rate = Math.max(0.5, Math.min(1.5, speed))

  for (const chunk of chunks) {
    await new Promise<void>((resolve, reject) => {
      const utt = new SpeechSynthesisUtterance(chunk)
      utt.rate = rate
      utt.voice = voice
      utt.onend = () => resolve()
      utt.onerror = (ev) => {
        if (ev.error === 'interrupted' || ev.error === 'canceled') resolve()
        else reject(new Error('Browser speech playback failed.'))
      }

      const watchdog = setTimeout(() => {
        synth.cancel()
        resolve()
      }, 20000)
      const origEnd = utt.onend
      utt.onend = (e) => {
        clearTimeout(watchdog)
        origEnd?.call(utt, e)
      }

      synth.speak(utt)
    })
  }
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
            <AlertCircle aria-hidden="true" />
            <h1>TTS4FREE hit a render error</h1>
            <p>{this.state.error.message}</p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
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
  const [locale, setLocale] = useState<'en-us' | 'en-gb'>('en-us')
  const [voiceId, setVoiceId] = useState('af_heart')
  const [speed, setSpeed] = useState(1)
  const [separateLines, setSeparateLines] = useState(false)
  const [text, setText] = useState(STARTER_TEXT)
  const [results, setResults] = useState<AudioResult[]>([])
  const [zipUrl, setZipUrl] = useState<string | null>(null)
  const [zipName, setZipName] = useState('tts4free-audio.zip')
  const [toast, setToast] = useState<Toast | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [status, setStatus] = useState('Ready')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [pauseDuration, setPauseDuration] = useState(1)
  const [runtimeLabel, setRuntimeLabel] = useState(
    typeof navigator !== 'undefined' && 'gpu' in navigator ? 'WebGPU fp32' : 'WebAssembly q8',
  )
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const objectUrlsRef = useRef<string[]>([])
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const progressTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  const availableVoices = useMemo(() => VOICES.filter((voice) => voice.locale === locale), [locale])
  const selectedVoice = VOICES.find((voice) => voice.id === voiceId) ?? VOICES[0]
  const lineNumbers = useMemo(() => text.split(/\r?\n/).map((_, index) => index + 1), [text])
  const usableText = text.slice(0, MAX_TEXT_CHARS)
  const overLimit = text.length > MAX_TEXT_CHARS

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { window.localStorage.setItem('tts4free-theme', theme) } catch { /* storage blocked */ }
  }, [theme])

  useEffect(() => {
    probeWebGpu().then((hasGpu) => setRuntimeLabel(hasGpu ? 'WebGPU fp32' : 'WebAssembly q8'))
  }, [])

  useEffect(() => {
    if (!availableVoices.some((voice) => voice.id === voiceId)) {
      setVoiceId(availableVoices[0]?.id ?? 'af_heart')
    }
  }, [availableVoices, voiceId])

  useEffect(() => {
    return () => {
      for (const url of objectUrlsRef.current) {
        URL.revokeObjectURL(url)
      }
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

  async function generateKokoro(chunks: string[]) {
    setStatus('Loading Kokoro model')
    setProgress(3)

    const tts = await loadKokoro((info) => {
      if (info.status === 'progress' && typeof info.progress === 'number') {
        setStatus(`Loading ${info.file ?? 'model'}`)
        setProgress(Math.min(35, Math.max(3, Math.round(info.progress * 0.35))))
      }
    })

    setStatus('Generating local audio')
    const generated: AudioResult[] = []
    const zipFiles: Record<string, Blob> = {}

    const chunkPlans = chunks.map((chunk) => {
      const segments = parsePauseTags(chunk)
      return segments.map((seg) =>
        seg.type === 'pause' ? seg : { ...seg, sentences: splitIntoSentences(seg.content) },
      )
    })
    let totalSentences = 0
    for (const plan of chunkPlans) {
      for (const seg of plan) if (seg.type === 'text') totalSentences += seg.sentences.length
    }
    let done = 0

    for (let index = 0; index < chunks.length; index += 1) {
      const plan = chunkPlans[index]
      const audioParts: Float32Array[] = []

      for (const seg of plan) {
        if (seg.type === 'pause') {
          audioParts.push(new Float32Array(Math.round(seg.duration * KOKORO_SAMPLE_RATE)))
          continue
        }
        for (const sentence of seg.sentences) {
          const audio = (await tts.generate(sentence, {
            voice: selectedVoice.id,
            speed,
          })) as RawAudioLike
          if (audio.audio) audioParts.push(audio.audio)
          done++
          setProgress(35 + Math.round((done / totalSentences) * 55))
          setStatus(`Generated ${done} / ${totalSentences}`)
        }
      }

      const combined = concatFloat32Arrays(audioParts)
      const blob = new Blob([encodeWav(combined, KOKORO_SAMPLE_RATE)], { type: 'audio/wav' })
      const baseName =
        chunks.length === 1 ? slugify(chunks[index]) : `${String(index + 1).padStart(3, '0')}-${slugify(chunks[index])}`
      const filename = `${baseName}-${timestamp()}.wav`
      const result = await buildResult(blob, chunks[index].slice(0, 64), filename)

      generated.push(result)
      zipFiles[filename] = blob
      setResults([...generated])
    }

    if (generated.length > 1) {
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      for (const [filename, blob] of Object.entries(zipFiles)) {
        zip.file(filename, blob)
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' })
      setZipUrl(rememberUrl(URL.createObjectURL(zipBlob)))
      setZipName(`tts4free-${timestamp()}.zip`)
    }

    setProgress(100)
    setStatus('Local audio ready')
    showToast({ tone: 'ok', message: 'Audio generated locally in your browser.' })
  }

  async function generateBrowser(chunks: string[]) {
    setStatus('Starting browser speech')
    setProgress(5)
    const cleanText = chunks.join('\n\n').replace(PAUSE_TAG, ' ')
    await speakBrowser(cleanText, speed)
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

  async function handleGenerate() {
    const chunks = splitInput(usableText, separateLines)

    if (chunks.length === 0) {
      showToast({ tone: 'warn', message: 'Enter text before generating audio.' })
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
    clearOutputs()
    setIsGenerating(true)

    try {
      if (engine === 'kokoro') {
        await generateKokoro(chunks)
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
      setIsGenerating(false)
    }
  }

  async function replayBrowser(textToReplay: string) {
    if (isGenerating) return
    setIsSpeaking(true)
    try {
      await speakBrowser(textToReplay.replace(PAUSE_TAG, ' '), speed)
    } catch (error) {
      showToast({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Browser playback failed.',
      })
    } finally {
      setIsSpeaking(false)
    }
  }

  function handleFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''

    if (!file) {
      return
    }

    if (!file.name.toLowerCase().endsWith('.txt') && file.type !== 'text/plain') {
      showToast({ tone: 'warn', message: 'Import supports plain .txt files for this static build.' })
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
          <a className="brand" href="#studio" aria-label="TTS4FREE home">
            <span className="brand-mark" aria-hidden="true">
              <Waves size={25} strokeWidth={2.2} />
            </span>
            <span>TTS4FREE</span>
          </a>
          <nav className="nav-links" aria-label="Primary">
            <a href="#studio" aria-current="page">
              Voice Studio
            </a>
            <a href="#models">Models</a>
            <a href="#docs">Docs</a>
            <a href="https://github.com/SysAdminDoc/TTS4FREE" target="_blank" rel="noreferrer">
              GitHub <ExternalLink size={14} aria-hidden="true" />
            </a>
          </nav>
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
              <span>Text</span>
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
            <div className="editor-actions">
              <button type="button" onClick={() => setText('')}>
                <X size={16} aria-hidden="true" />
                Clear
              </button>
              <button type="button" onClick={() => fileInputRef.current?.click()}>
                <Upload size={16} aria-hidden="true" />
                Import .txt
              </button>
              <input ref={fileInputRef} type="file" accept=".txt,text/plain" onChange={handleFileUpload} hidden />
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
            </div>

            <section className="output-panel" aria-label="Generated audio">
              <div className="section-heading">
                <span>Output</span>
                <span>{status}</span>
              </div>
              {results.length === 0 ? (
                <div className="empty-output">
                  <Volume2 size={22} aria-hidden="true" />
                  <span>Generated audio will appear here.</span>
                </div>
              ) : (
                <div className="result-list">
                  {results.map((result) => (
                    <div className="result-row" key={result.id}>
                      <div className="result-meta">
                        <span className="ready-dot" aria-hidden="true" />
                        <strong>{result.filename}</strong>
                        <span>{result.duration}</span>
                        <span>{result.size}</span>
                      </div>
                      {result.url ? <audio controls src={result.url} /> : null}
                      <div className="result-actions">
                        {result.replayText ? (
                          <button type="button" onClick={() => replayBrowser(result.replayText!)} disabled={isSpeaking}>
                            {isSpeaking ? <Loader2 size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                            Replay
                          </button>
                        ) : null}
                        {result.url ? (
                          <a href={result.url} download={result.filename}>
                            <Download size={16} aria-hidden="true" />
                            Download WAV
                          </a>
                        ) : null}
                      </div>
                    </div>
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
                Text and generated audio stay in this browser. Kokoro downloads model files from Hugging Face the first time.
              </p>
            </section>
          </div>

          <aside className="settings-panel" aria-label="Voice settings">
            <div className="section-heading">
              <span>Voice settings</span>
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
                  <small>{runtimeLabel}. WAV export enabled.</small>
                </button>
                <button
                  type="button"
                  className={engine === 'browser' ? 'engine-card selected' : 'engine-card'}
                  onClick={() => setEngine('browser')}
                >
                  <span>{engine === 'browser' ? <Check size={17} aria-hidden="true" /> : null}</span>
                  <strong>Browser fallback</strong>
                  <small>Native speech playback when Kokoro cannot run.</small>
                </button>
              </div>
            </fieldset>

            <label className="control-label" htmlFor="locale">
              Language
            </label>
            <select id="locale" value={locale} onChange={(event) => setLocale(event.target.value as 'en-us' | 'en-gb')}>
              <option value="en-us">English US</option>
              <option value="en-gb">English British</option>
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
                <button
                  type="button"
                  className={voice.id === voiceId ? 'selected' : ''}
                  key={voice.id}
                  onClick={() => setVoiceId(voice.id)}
                >
                  {voice.name}
                </button>
              ))}
            </div>

            <div className="range-row">
              <label htmlFor="speed">Speed</label>
              <span>{speed.toFixed(2)}x</span>
              <input
                id="speed"
                type="range"
                min="0.5"
                max="1.5"
                step="0.05"
                value={speed}
                onChange={(event) => setSpeed(Number(event.target.value))}
              />
            </div>

            <label className="toggle-row">
              <input type="checkbox" checked={separateLines} onChange={(event) => setSeparateLines(event.target.checked)} />
              <span>
                Separate lines
                <small>Generate one audio file per non-empty line.</small>
              </span>
            </label>

            {progress !== null ? (
              <div className="progress-wrap" aria-label={`Generation progress ${progress}%`}>
                <span style={{ width: `${progress}%` }} />
              </div>
            ) : null}

            <button type="button" className="generate-button" onClick={handleGenerate} disabled={isGenerating}>
              {isGenerating ? <Loader2 size={18} aria-hidden="true" /> : <Waves size={18} aria-hidden="true" />}
              Generate audio
            </button>

            <button type="button" className="secondary-action" onClick={clearOutputs}>
              <Trash2 size={16} aria-hidden="true" />
              Clear output
            </button>
          </aside>
        </section>

        <section className="technical-note" id="docs">
          <span>Technical note</span>
          <p>
            TTS4FREE is static. Kokoro runs in-browser through Transformers.js and caches model files locally after first load.
            Browser fallback uses the Web Speech API for playback only.
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
            <p>English Kokoro voices are wired now. Multilingual voices are listed as the next static model-pack track.</p>
          </div>

          <div className="hosting-panel">
            <div className="section-heading">
              <span>Hosting on GitHub Pages</span>
              <SquareCode size={18} aria-hidden="true" />
            </div>
            <p>TTS4FREE builds to plain static files. No backend, no database, no GitHub Actions.</p>
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
          <span>TTS4FREE v{APP_VERSION}</span>
          <button
            type="button"
            onClick={() => {
              kokoroPromise = null
              showToast({ tone: 'ok', message: 'Model cache handle reset for this page session.' })
            }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Reset session
          </button>
        </footer>

        {toast ? (
          <div className={`toast ${toast.tone}`} role="status">
            {toast.tone === 'error' ? <AlertCircle size={17} aria-hidden="true" /> : <Info size={17} aria-hidden="true" />}
            <span>{toast.message}</span>
          </div>
        ) : null}
      </main>
  )
}

export default App
