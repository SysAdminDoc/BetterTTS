// Native Sherpa-ONNX inference host (TF-115). Runs in an Electron
// utilityProcess, or as a plain Node child in scripts/probe-native-host.mjs.
// The renderer/main process only sees the small load/generate/info protocol;
// native addon loading, model archive extraction, and inference stay isolated
// here.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureSherpaModelPack,
  readSherpaPackStatus,
  sherpaKokoroSpeakerId,
  SHERPA_KOKORO_PACK,
  SHERPA_MELO_PACK,
  SHERPA_PIPER_PACK,
  type SherpaEngineId,
  type SherpaModelPack,
} from './sherpa-models.ts'
import type { NativePackFailure } from './native-pack-policy.ts'
import type { PackProgress, PackStatus } from './native-models.ts'
import {
  MAX_NATIVE_PCM_BYTES,
  NativeGenerationCoordinator,
  NativePcmBudget,
  NATIVE_GENERATION_WATCHDOG_MS,
  validateNativePcm,
} from './native-tts-runtime.ts'

type SherpaGeneratedAudio = {
  samples: Float32Array
  sampleRate: number
}

type SherpaGenerationConfig = {
  sid: number
  speed: number
  silenceScale: number
}

type SherpaTts = {
  sampleRate: number
  generate: (request: {
    text: string
    generationConfig: SherpaGenerationConfig
    enableExternalBuffer?: boolean
  }) => SherpaGeneratedAudio
}

type SherpaModule = {
  OfflineTts: new (config: unknown) => SherpaTts
  GenerationConfig: new (config: SherpaGenerationConfig) => SherpaGenerationConfig
}

async function loadSherpaModule(): Promise<SherpaModule> {
  const imported = await import('sherpa-onnx-node') as unknown as SherpaModule & { default?: SherpaModule }
  return imported.default ?? imported
}

const KOKORO_SAMPLE_RATE = 24_000
const PIPER_SAMPLE_RATE = 22_050
const MELO_SAMPLE_RATE = 44_100

export type NativeRuntimeInfo = {
  runtime: 'sherpa-onnx-node'
  ep: 'cpu'
  sherpaVersion: string
  nativeAddon: {
    package: 'sherpa-onnx-win-x64'
    version: string
    present: boolean
  }
  node: string
  modelCacheDir: string
  engine?: SherpaEngineId
  sampleRate?: number
  modelPack?: PackStatus
  modelPackFailure?: NativePackFailure
  activePcmBytes: number
  maxPcmBytes: number
}

export type HostRequest =
  | { type: 'load'; dtype?: 'q8'; engine?: SherpaEngineId }
  | { type: 'generate'; text: string; voice: string; speed: number; id: number; engine?: SherpaEngineId }
  | { type: 'cancel'; id: number }
  | { type: 'cancel-all' }
  | { type: 'info' }

export type HostResponse =
  | { type: 'progress'; info: PackProgress }
  | { type: 'loaded'; key: string; runtime: NativeRuntimeInfo }
  | { type: 'loadError'; message: string; key: string }
  | { type: 'generated'; samples: Float32Array; sampleRate: number; id: number }
  | { type: 'generateError'; message: string; id: number }
  | { type: 'info'; runtime: NativeRuntimeInfo }

type ParentPortLike = {
  postMessage: (message: unknown) => void
  on: (event: 'message', listener: (event: { data: HostRequest }) => void) => void
}

type Port = {
  post: (message: HostResponse) => void
  onMessage: (handler: (message: HostRequest) => void) => void
}

function getPort(): Port {
  const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort
  if (parentPort) {
    return {
      post: (message) => parentPort.postMessage(message),
      onMessage: (handler) => parentPort.on('message', (event) => handler(event.data)),
    }
  }
  return {
    post: (message) => process.send?.(message),
    onMessage: (handler) => process.on('message', handler as (message: unknown) => void),
  }
}

const hostRequire = createRequire(import.meta.url)

function packageVersion(name: string): string {
  try {
    return (hostRequire(`${name}/package.json`) as { version?: string }).version ?? 'unknown'
  } catch {
    try {
      const entry = fileURLToPath(import.meta.resolve(name))
      let dir = dirname(entry)
      for (let depth = 0; depth < 6; depth++) {
        const candidate = join(dir, 'package.json')
        if (existsSync(candidate)) {
          const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
          if (pkg.name === name && pkg.version) return pkg.version
        }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch {
      // fall through to unknown
    }
    return 'unknown'
  }
}

function modelCacheDir(): string {
  const dir = process.env.BETTERTTS_MODEL_CACHE ?? resolve('dist-electron', 'model-cache')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // The model manager will report a useful failure if the path is unusable.
  }
  return dir
}

function nativeAddonPresent(): boolean {
  try {
    hostRequire('sherpa-onnx-win-x64')
    return true
  } catch {
    return false
  }
}

function runtimeInfo(
  engine?: SherpaEngineId,
  sampleRate?: number,
  modelPack?: PackStatus,
  modelPackFailure?: NativePackFailure,
): NativeRuntimeInfo {
  return {
    runtime: 'sherpa-onnx-node',
    ep: 'cpu',
    sherpaVersion: packageVersion('sherpa-onnx-node'),
    nativeAddon: {
      package: 'sherpa-onnx-win-x64',
      version: packageVersion('sherpa-onnx-win-x64'),
      present: nativeAddonPresent(),
    },
    node: process.versions.node,
    modelCacheDir: modelCacheDir(),
    activePcmBytes: pcmBudget.activeBytes,
    maxPcmBytes: MAX_NATIVE_PCM_BYTES,
    ...(engine ? { engine } : {}),
    ...(sampleRate ? { sampleRate } : {}),
    ...(modelPack ? { modelPack } : {}),
    ...(modelPackFailure ? { modelPackFailure } : {}),
  }
}

function packForEngine(engine: SherpaEngineId): SherpaModelPack {
  return engine === 'piper' ? SHERPA_PIPER_PACK : engine === 'melo' ? SHERPA_MELO_PACK : SHERPA_KOKORO_PACK
}

function keyForEngine(engine: SherpaEngineId): string {
  return engine === 'piper' ? 'sherpa:piper' : engine === 'melo' ? 'sherpa:melo' : 'cpu:q8'
}

type LoadedRuntime = {
  key: string
  runtime: NativeRuntimeInfo
}

function createSherpaConfig(engine: SherpaEngineId, root: string): unknown {
  const pack = packForEngine(engine)
  const paths = {
    model: join(root, pack.layout.model),
    ...(pack.layout.voices ? { voices: join(root, pack.layout.voices) } : {}),
    tokens: join(root, pack.layout.tokens),
    ...(pack.layout.dataDir ? { dataDir: join(root, pack.layout.dataDir) } : {}),
    ...(pack.layout.lexicon ? { lexicon: pack.layout.lexicon.split(',').map((path) => join(root, path)).join(',') } : {}),
  }
  const model = engine === 'piper'
    ? {
      vits: {
        model: paths.model,
        tokens: paths.tokens,
        dataDir: paths.dataDir,
      },
    }
    : engine === 'melo'
      ? {
        vits: {
          model: paths.model,
          tokens: paths.tokens,
          ...(paths.lexicon ? { lexicon: paths.lexicon } : {}),
        },
      }
    : {
      kokoro: {
        model: paths.model,
        voices: paths.voices,
        tokens: paths.tokens,
        dataDir: paths.dataDir,
        ...(paths.lexicon ? { lexicon: paths.lexicon } : {}),
      },
    }
  return {
    model,
    maxNumSentences: 1,
    silenceScale: 0.2,
    numThreads: 2,
    provider: 'cpu',
  }
}

let tts: SherpaTts | null = null
let loadedEngine: SherpaEngineId | null = null
let loadedKey = ''
let loadedSampleRate = 0
let lastPackStatus: PackStatus | undefined
let lastPackFailure: NativePackFailure | undefined
const generationCoordinator = new NativeGenerationCoordinator()
const pcmBudget = new NativePcmBudget()
let loadFlight: { key: string; promise: Promise<LoadedRuntime> } | null = null

const port = getPort()

function clearLoadedRuntime(): void {
  tts = null
  loadedEngine = null
  loadedKey = ''
  loadedSampleRate = 0
}

function postProgress(info: PackProgress): void {
  port.post({ type: 'progress', info })
}

function ensureLoaded(engine: SherpaEngineId): Promise<LoadedRuntime> {
  const key = keyForEngine(engine)
  if (tts && loadedEngine === engine && loadedKey === key) {
    return Promise.resolve({ key, runtime: runtimeInfo(engine, loadedSampleRate, lastPackStatus, lastPackFailure) })
  }
  if (generationCoordinator.activeRequestId !== null) {
    return Promise.reject(new Error('Native model cannot change while a generation is active.'))
  }
  if (loadFlight) {
    return loadFlight.key === key
      ? loadFlight.promise
      : Promise.reject(new Error('Another native model load is already in progress.'))
  }

  const promise = (async (): Promise<LoadedRuntime> => {
    try {
      const pack = packForEngine(engine)
      const ensured = await ensureSherpaModelPack(modelCacheDir(), pack, {
        onProgress: postProgress,
      })
      const module = await loadSherpaModule()
      const instance = new module.OfflineTts(createSherpaConfig(engine, ensured.modelRoot))
      tts = instance
      loadedEngine = engine
      loadedKey = key
      loadedSampleRate = engine === 'piper' ? PIPER_SAMPLE_RATE : engine === 'melo' ? MELO_SAMPLE_RATE : KOKORO_SAMPLE_RATE
      lastPackStatus = ensured.status
      lastPackFailure = undefined
      return {
        key,
        runtime: runtimeInfo(engine, instance.sampleRate || loadedSampleRate, lastPackStatus),
      }
    } catch (err) {
      clearLoadedRuntime()
      const failure: NativePackFailure = {
        kind: err instanceof Error && 'kind' in err && (err as { kind?: unknown }).kind === 'integrity' ? 'integrity' : 'unavailable',
        message: err instanceof Error ? err.message : 'Sherpa model load failed',
      }
      lastPackFailure = failure
      throw new Error(failure.message)
    }
  })()
  loadFlight = { key, promise }
  promise.then(
    () => {
      if (loadFlight?.promise === promise) loadFlight = null
    },
    () => {
      if (loadFlight?.promise === promise) loadFlight = null
    },
  )
  return promise
}

async function handleGenerate(msg: Extract<HostRequest, { type: 'generate' }>): Promise<void> {
  const started = generationCoordinator.start(msg.id)
  if (started === 'cancelled') {
    port.post({ type: 'generateError', message: 'Generation cancelled.', id: msg.id })
    return
  }
  if (started === 'busy') {
    port.post({ type: 'generateError', message: 'Native generation already in progress.', id: msg.id })
    return
  }

  if (!tts || loadedEngine !== (msg.engine ?? 'kokoro')) {
    generationCoordinator.finish(msg.id)
    port.post({ type: 'generateError', message: 'Native model not loaded', id: msg.id })
    return
  }

  let watchdogExpired = false
  const watchdog = setTimeout(() => {
    watchdogExpired = true
    generationCoordinator.cancel(msg.id)
    clearLoadedRuntime()
    port.post({ type: 'generateError', message: 'Native generation watchdog timed out; restart the native engine and try again.', id: msg.id })
    // A native addon can leave an async promise permanently unsettled. Exit so
    // Electron's supervisor cannot reuse a poisoned utility process.
    setImmediate(() => process.exit(1))
  }, NATIVE_GENERATION_WATCHDOG_MS)

  try {
    const engine = msg.engine ?? 'kokoro'
    if (engine === 'piper' && !['en', 'en-gb', 'en-us'].includes(msg.voice.toLowerCase())) {
      throw new Error('Native Sherpa Piper currently exposes the English Cori voice; choose English or use the web Piper engine.')
    }
    const module = await loadSherpaModule()
    const generationConfig = new module.GenerationConfig({
      sid: engine === 'piper' || engine === 'melo' ? 0 : sherpaKokoroSpeakerId(msg.voice),
      speed: msg.speed,
      silenceScale: 0.2,
    })
    const instance = tts
    if (!instance) throw new Error('Native model not loaded')
    // Inference already runs outside the renderer and main process. Keep the
    // native call synchronous inside this disposable utility host because the
    // Sherpa async progress callback crosses native threads and can terminate
    // Electron's Node utility context. Cancellation remains bounded by the
    // main-process supervisor, which kills and replaces this host after 1 s.
    const generated = instance.generate({
      text: msg.text,
      generationConfig,
      // Electron's V8 sandbox rejects N-API external buffers. Ask Sherpa to
      // copy its native PCM into a V8-managed ArrayBuffer instead.
      enableExternalBuffer: false,
    })
    if (watchdogExpired) return
    if (generationCoordinator.isCancelled(msg.id)) {
      port.post({ type: 'generateError', message: 'Generation cancelled.', id: msg.id })
      return
    }
    const audio = validateNativePcm(generated.samples, generated.sampleRate || loadedSampleRate)
    // Keep the IPC payload detached from Sherpa's return object even though
    // enableExternalBuffer already requested V8-managed storage.
    const transportSamples = new Float32Array(audio.samples)
    pcmBudget.reserve(transportSamples.byteLength)
    try {
      port.post({ type: 'generated', samples: transportSamples, sampleRate: audio.sampleRate, id: msg.id })
    } finally {
      pcmBudget.release(transportSamples.byteLength)
    }
  } catch (err) {
    if (watchdogExpired) return
    port.post({
      type: 'generateError',
      message: generationCoordinator.isCancelled(msg.id)
        ? 'Generation cancelled.'
        : err instanceof Error ? err.message : 'Native Sherpa generation failed',
      id: msg.id,
    })
  } finally {
    clearTimeout(watchdog)
    generationCoordinator.finish(msg.id)
  }
}

async function handleMessage(msg: HostRequest): Promise<void> {
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'cancel') {
    generationCoordinator.cancel(msg.id)
    return
  }

  if (msg.type === 'cancel-all') {
    generationCoordinator.cancelAll()
    return
  }

  if (msg.type === 'info') {
    let modelPack = lastPackStatus
    if (!modelPack && loadedEngine) {
      modelPack = await readSherpaPackStatus(modelCacheDir(), packForEngine(loadedEngine)).catch(() => undefined)
    }
    port.post({ type: 'info', runtime: runtimeInfo(loadedEngine ?? undefined, loadedSampleRate || undefined, modelPack, lastPackFailure) })
    return
  }

  if (msg.type === 'load') {
    const engine = msg.engine ?? 'kokoro'
    const key = keyForEngine(engine)
    try {
      const loaded = await ensureLoaded(engine)
      port.post({ type: 'loaded', key: loaded.key, runtime: loaded.runtime })
    } catch (err) {
      port.post({ type: 'loadError', message: err instanceof Error ? err.message : 'Sherpa model load failed', key })
    }
    return
  }

  if (msg.type === 'generate') {
    await handleGenerate(msg)
  }
}

port.onMessage((msg) => {
  void handleMessage(msg)
})
