import type { ProgressInfo } from './kokoro.ts'
import { piper } from './kokoro-assets.ts'
import { wavBlobToFloat32 } from './kitten.ts'

export const PIPER_PLUS_PACKAGE_VERSION = '0.6.0'
export const PIPER_PLUS_MODEL_ID = 'ayousanz/piper-plus-tsukuyomi-chan'
export const PIPER_PLUS_MODEL_LABEL = 'Tsukuyomi-chan'
export const PIPER_PLUS_SAMPLE_RATE = 22050
export const PIPER_PLUS_ONNX_FILE = 'tsukuyomi-chan-6lang-fp16.onnx'

export type PiperPlusLanguage = 'ja' | 'en' | 'zh' | 'ko' | 'es' | 'fr' | 'pt' | 'sv'

export type PiperPlusLanguageOption = {
  id: PiperPlusLanguage
  label: string
}

export type PiperPlusRuntimeSupport = {
  packageVersion: string
  model: string
  modelLabel: string
  supported: boolean
  wasm: boolean
  indexedDb: boolean
  webGpu: boolean
  defaultFirstLoad: false
  notes: string[]
}

type PiperPlusModule = typeof import('piper-plus')
type OnnxRuntimeModule = typeof import('onnxruntime-web/wasm')
type PiperPlusInstance = Awaited<ReturnType<PiperPlusModule['PiperPlus']['initialize']>>

type PiperProgressInfo = {
  stage?: string
  progress?: number
  message?: string
}

type PiperAudioResultLike = {
  samples?: Float32Array
  sampleRate?: number
  toBlob?: () => Blob
}

type PiperInitializeOptions = Parameters<PiperPlusModule['PiperPlus']['initialize']>[0] & {
  wasmLoader?: () => Promise<unknown>
  zhDictBaseUrl?: string
}

export const PIPER_PLUS_LANGUAGES: PiperPlusLanguageOption[] = [
  { id: 'ja', label: 'Japanese' },
  { id: 'en', label: 'English' },
  { id: 'zh', label: 'Chinese' },
  { id: 'ko', label: 'Korean' },
  { id: 'es', label: 'Spanish' },
  { id: 'fr', label: 'French' },
  { id: 'pt', label: 'Portuguese' },
  { id: 'sv', label: 'Swedish' },
]

let piperPlusPromise: Promise<PiperPlusInstance> | null = null

export function piperPlusRuntimeSupport(): PiperPlusRuntimeSupport {
  const wasm = typeof WebAssembly !== 'undefined'
  const indexedDb = typeof indexedDB !== 'undefined'
  const webGpu = typeof navigator !== 'undefined' && 'gpu' in navigator
  return {
    packageVersion: PIPER_PLUS_PACKAGE_VERSION,
    model: PIPER_PLUS_MODEL_ID,
    modelLabel: PIPER_PLUS_MODEL_LABEL,
    supported: wasm && indexedDb,
    wasm,
    indexedDb,
    webGpu,
    defaultFirstLoad: false,
    notes: [
      'Desktop catalog engine: package, ONNX Runtime, WASM G2P, and model assets are lazy-loaded only when Piper-plus is selected; the web build remains opt-in.',
      'Piper-plus stores model assets in its own IndexedDB cache; BetterTTS does not include those entries in the per-engine Cache API manager yet.',
    ],
  }
}

export function piperLengthScaleFromSpeed(speed: number): number {
  const clamped = Math.min(1.5, Math.max(0.5, speed))
  return Math.round((1 / clamped) * 1000) / 1000
}

export async function loadPiperPlus(onProgress: (info: ProgressInfo) => void): Promise<PiperPlusInstance> {
  if (piperPlusPromise) return piperPlusPromise

  const [{ ModelManager, PiperPlus }, ort] = await Promise.all([
    import('piper-plus'),
    import('onnxruntime-web/wasm'),
  ])
  const modelIdentifier = await resolvePiperModelIdentifier()
  const modelManager = new ModelManager()
  const model = await modelManager.loadModel(modelIdentifier, {
    onProgress: (info: { loaded: number, total: number, percentage: number }) => {
      onProgress({
        status: 'progress_total',
        name: 'Downloading Piper-plus model',
        loaded: info.loaded,
        total: info.total,
        progress: info.percentage / 100,
      })
    },
  })

  const options: PiperInitializeOptions = {
    model: modelIdentifier,
    ort: piperOrtWithCachedModel(ort, model.modelData),
    wasmLoader: () => import('piper-plus/wasm/multilingual'),
    zhDictBaseUrl: piperDictionaryBaseUrl(),
    onProgress: (info: PiperProgressInfo) => {
      onProgress({
        status: info.stage,
        name: info.message,
        progress: typeof info.progress === 'number' ? info.progress : undefined,
      })
    },
  }

  piperPlusPromise = PiperPlus.initialize(options)
  try {
    return await piperPlusPromise
  } catch (err) {
    piperPlusPromise = null
    throw err
  }
}

export function piperLocalModelUrl(): string {
  const rawBasePath = import.meta.env.BASE_URL === '/' ? '/BetterTTS/' : import.meta.env.BASE_URL
  const basePath = rawBasePath.endsWith('/') ? rawBasePath : `${rawBasePath}/`
  const origin = typeof location === 'undefined' ? 'https://sysadmindoc.github.io' : location.origin
  return new URL(`${basePath}models/${PIPER_PLUS_MODEL_ID}/${PIPER_PLUS_ONNX_FILE}`, origin).toString()
}

async function resolvePiperModelIdentifier(): Promise<string> {
  const localModel = piperLocalModelUrl()
  try {
    const response = await fetch(`${localModel}.json`, { cache: 'reload' })
    if (response.ok && !response.headers.get('content-type')?.toLowerCase().includes('text/html')) return localModel
  } catch {
    /* fall back to Hugging Face */
  }
  return piper()
}

function piperOrtWithCachedModel(ort: OnnxRuntimeModule, modelData: ArrayBuffer): OnnxRuntimeModule {
  const proxy = Object.create(ort) as OnnxRuntimeModule
  const inferenceSession = Object.create(ort.InferenceSession) as OnnxRuntimeModule['InferenceSession']
  const createSession = ort.InferenceSession.create.bind(ort.InferenceSession)
  inferenceSession.create = (async (model: unknown, options?: unknown) => {
    const input = typeof model === 'string' && model.includes('piper-plus') && model.endsWith('.onnx')
      ? modelData
      : model
    return createSession(input as never, options as never)
  }) as OnnxRuntimeModule['InferenceSession']['create']
  Object.defineProperty(proxy, 'InferenceSession', { value: inferenceSession })
  return proxy
}

function piperDictionaryBaseUrl(): string {
  const rawBasePath = import.meta.env.BASE_URL === '/' ? '/BetterTTS/' : import.meta.env.BASE_URL
  const basePath = rawBasePath.endsWith('/') ? rawBasePath : `${rawBasePath}/`
  const origin = typeof location === 'undefined' ? 'https://sysadmindoc.github.io' : location.origin
  return new URL(`${basePath}piper-plus-dicts/`, origin).toString()
}

export async function synthesizePiperPlus(
  tts: PiperPlusInstance,
  text: string,
  language: PiperPlusLanguage,
  speed: number,
): Promise<{ samples: Float32Array, sampleRate: number } | null> {
  const result = await tts.synthesize(text, {
    language,
    lengthScale: piperLengthScaleFromSpeed(speed),
  }) as PiperAudioResultLike
  return piperAudioResultToSamples(result)
}

export async function piperAudioResultToSamples(
  result: PiperAudioResultLike,
): Promise<{ samples: Float32Array, sampleRate: number } | null> {
  if (result.samples instanceof Float32Array && result.samples.length > 0) {
    return { samples: result.samples, sampleRate: result.sampleRate ?? PIPER_PLUS_SAMPLE_RATE }
  }
  if (typeof result.toBlob === 'function') {
    const wav = await wavBlobToFloat32(result.toBlob())
    return { samples: wav.samples, sampleRate: wav.sampleRate }
  }
  return null
}

export function resetPiperPlusSession(): void {
  const promise = piperPlusPromise
  piperPlusPromise = null
  promise?.then((tts) => tts.dispose()).catch(() => {})
}
