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

type SherpaGeneratedAudio = {
  samples: Float32Array
  sampleRate: number
}

type SherpaProgress = {
  samples?: Float32Array
  progress?: number
}

type SherpaGenerationConfig = {
  sid: number
  speed: number
  silenceScale: number
}

type SherpaTts = {
  sampleRate: number
  generate: (request: { text: string; generationConfig: SherpaGenerationConfig }) => SherpaGeneratedAudio
  generateAsync?: (request: {
    text: string
    generationConfig: SherpaGenerationConfig
    onProgress?: (info: SherpaProgress) => number
  }) => Promise<SherpaGeneratedAudio>
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
}

export type HostRequest =
  | { type: 'load'; dtype?: 'q8'; engine?: SherpaEngineId }
  | { type: 'generate'; text: string; voice: string; speed: number; id: number; engine?: SherpaEngineId }
  | { type: 'cancel'; id: number }
  | { type: 'cancel-all' }
  | { type: 'info' }

export type HostResponse =
  | { type: 'progress'; info: PackProgress | SherpaProgress | unknown }
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
const cancelledIds = new Set<number>()

const port = getPort()

port.onMessage(async (msg) => {
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'cancel') {
    cancelledIds.add(msg.id)
    return
  }

  if (msg.type === 'cancel-all') return

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
    if (tts && loadedEngine === engine && loadedKey === key) {
      port.post({ type: 'loaded', key, runtime: runtimeInfo(engine, loadedSampleRate, lastPackStatus, lastPackFailure) })
      return
    }
    try {
      const pack = packForEngine(engine)
      const ensured = await ensureSherpaModelPack(modelCacheDir(), pack, {
        onProgress: (info) => port.post({ type: 'progress', info }),
      })
      const module = await loadSherpaModule()
      const instance = new module.OfflineTts(createSherpaConfig(engine, ensured.modelRoot))
      tts = instance
      loadedEngine = engine
      loadedKey = key
      loadedSampleRate = engine === 'piper' ? PIPER_SAMPLE_RATE : engine === 'melo' ? MELO_SAMPLE_RATE : KOKORO_SAMPLE_RATE
      lastPackStatus = ensured.status
      lastPackFailure = undefined
      port.post({ type: 'loaded', key, runtime: runtimeInfo(engine, instance.sampleRate || loadedSampleRate, lastPackStatus) })
    } catch (err) {
      tts = null
      loadedEngine = null
      loadedKey = ''
      loadedSampleRate = 0
      const failure: NativePackFailure = {
        kind: err instanceof Error && 'kind' in err && (err as { kind?: unknown }).kind === 'integrity' ? 'integrity' : 'unavailable',
        message: err instanceof Error ? err.message : 'Sherpa model load failed',
      }
      lastPackFailure = failure
      port.post({ type: 'loadError', message: failure.message, key })
    }
    return
  }

  if (msg.type === 'generate') {
    const engine = msg.engine ?? 'kokoro'
    if (cancelledIds.delete(msg.id)) {
      port.post({ type: 'generateError', message: 'Generation cancelled.', id: msg.id })
      return
    }
    if (!tts || loadedEngine !== engine) {
      port.post({ type: 'generateError', message: 'Native model not loaded', id: msg.id })
      return
    }
    try {
      if (engine === 'piper' && !['en', 'en-gb', 'en-us'].includes(msg.voice.toLowerCase())) {
        throw new Error('Native Sherpa Piper currently exposes the English Cori voice; choose English or use the web Piper engine.')
      }
      const module = await loadSherpaModule()
      const generationConfig = new module.GenerationConfig({
        sid: engine === 'piper' || engine === 'melo' ? 0 : sherpaKokoroSpeakerId(msg.voice),
        speed: msg.speed,
        silenceScale: 0.2,
      })
      const generated = tts.generateAsync
        ? await tts.generateAsync({
          text: msg.text,
          generationConfig,
          onProgress: (info) => {
            port.post({ type: 'progress', info })
            return cancelledIds.has(msg.id) ? 0 : 1
          },
        })
        : tts.generate({ text: msg.text, generationConfig })
      if (cancelledIds.delete(msg.id)) {
        port.post({ type: 'generateError', message: 'Generation cancelled.', id: msg.id })
      } else if (generated.samples instanceof Float32Array && generated.samples.length > 0) {
        port.post({ type: 'generated', samples: generated.samples, sampleRate: generated.sampleRate || loadedSampleRate, id: msg.id })
      } else {
        port.post({ type: 'generateError', message: 'No audio produced', id: msg.id })
      }
    } catch (err) {
      port.post({
        type: 'generateError',
        message: cancelledIds.delete(msg.id)
          ? 'Generation cancelled.'
          : err instanceof Error ? err.message : 'Native Sherpa generation failed',
        id: msg.id,
      })
    }
  }
})
