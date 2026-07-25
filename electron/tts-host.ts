// Native Kokoro inference host (TF-99). Runs as an Electron utilityProcess in
// the desktop app, or as a plain Node child (child_process.fork with advanced
// serialization) in scripts/probe-native-host.mjs. Mirrors the browser worker
// protocol in src/worker/tts.worker.ts: load / generate / info requests,
// progress / loaded / generated / error replies.
//
// Inference goes through kokoro-js, whose @huggingface/transformers Node
// backend binds onnxruntime-node. The CPU EP is forced: DirectML fails Kokoro's
// ConvTranspose at op level regardless of dtype (see ROADMAP TF-99 probe notes).
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KOKORO_Q8_PACK, ensurePack, readPackStatus, type PackStatus } from './native-models.ts'

type KokoroModule = typeof import('kokoro-js')
type KokoroInstance = Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>

// Kept in sync with KOKORO_MODEL_ID in src/lib/kokoro-assets.ts — the host must
// not import renderer modules (they assume a browser global environment).
const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

export type NativeRuntimeInfo = {
  runtime: 'onnxruntime-node'
  ep: 'cpu'
  ortVersion: string
  transformersVersion: string
  kokoroJsVersion: string
  node: string
  modelCacheDir: string
  modelPack?: PackStatus
}

export type HostRequest =
  | { type: 'load'; dtype?: 'q8' | 'fp32' }
  | { type: 'generate'; text: string; voice: string; speed: number; id: number }
  | { type: 'cancel'; id: number }
  | { type: 'cancel-all' }
  | { type: 'info' }

export type HostResponse =
  | { type: 'progress'; info: unknown }
  | { type: 'loaded'; key: string; runtime: NativeRuntimeInfo }
  | { type: 'loadError'; message: string; key: string }
  | { type: 'generated'; samples: Float32Array; id: number }
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
  // Plain-Node fallback for the probe script (fork with serialization:'advanced'
  // so Float32Array survives the channel like it does over utilityProcess).
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
    // ESM-only packages (kokoro-js, transformers) don't expose ./package.json
    // through their exports map — resolve the entry and walk up to the manifest.
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
    // transformers creates it lazily on first cache write if this fails
  }
  return dir
}

function runtimeInfo(modelPack?: PackStatus): NativeRuntimeInfo {
  return {
    runtime: 'onnxruntime-node',
    ep: 'cpu',
    ortVersion: packageVersion('onnxruntime-node'),
    transformersVersion: packageVersion('@huggingface/transformers'),
    kokoroJsVersion: packageVersion('kokoro-js'),
    node: process.versions.node,
    modelCacheDir: modelCacheDir(),
    ...(modelPack ? { modelPack } : {}),
  }
}

async function configureTransformersEnv(localModelRoot: string | null): Promise<void> {
  const { env } = await import('@huggingface/transformers')
  env.cacheDir = modelCacheDir()
  if (localModelRoot) {
    // Every core model file was hash-verified against the pinned manifest —
    // point transformers at the verified copy so nothing else is fetched for
    // the graph/tokenizer/config.
    env.localModelPath = localModelRoot
    env.allowLocalModels = true
    return
  }
  // Manifest download unavailable (offline with a dev sync present): fall back
  // to a previously synced dist/models copy, else transformers' own HF fetch.
  const localModels = resolve('dist', 'models')
  if (existsSync(join(localModels, KOKORO_MODEL_ID))) {
    env.localModelPath = localModels
    env.allowLocalModels = true
  }
}

let tts: KokoroInstance | null = null
let loadedKey = ''
let lastPackStatus: PackStatus | undefined
const cancelledIds = new Set<number>()

const port = getPort()

port.onMessage(async (msg) => {
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'cancel') {
    cancelledIds.add(msg.id)
    return
  }

  if (msg.type === 'cancel-all') {
    return
  }

  if (msg.type === 'info') {
    let modelPack = lastPackStatus
    if (!modelPack) {
      try {
        modelPack = await readPackStatus(modelCacheDir(), KOKORO_Q8_PACK)
      } catch {
        // status stays undefined when the cache dir is unreadable
      }
    }
    port.post({ type: 'info', runtime: runtimeInfo(modelPack) })
    return
  }

  if (msg.type === 'load') {
    const dtype = msg.dtype ?? 'q8'
    const key = `cpu:${dtype}`
    if (tts && loadedKey === key) {
      port.post({ type: 'loaded', key, runtime: runtimeInfo(lastPackStatus) })
      return
    }
    try {
      // Manifest-verified download first (resumable, SHA-256 checked, license
      // gated). A download failure falls back to transformers' own fetch so an
      // HF hiccup doesn't brick native mode — the pack status records it.
      let localModelRoot: string | null = null
      try {
        const ensured = await ensurePack(modelCacheDir(), KOKORO_Q8_PACK, {
          onProgress: (info) => port.post({ type: 'progress', info }),
        })
        localModelRoot = ensured.localModelRoot
        lastPackStatus = ensured.status
      } catch (packErr) {
        lastPackStatus = await readPackStatus(modelCacheDir(), KOKORO_Q8_PACK).catch(() => undefined)
        port.post({
          type: 'progress',
          info: { status: 'pack-fallback', message: packErr instanceof Error ? packErr.message : String(packErr) },
        })
      }
      await configureTransformersEnv(localModelRoot)
      const { KokoroTTS } = await import('kokoro-js')
      tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        device: 'cpu' as never,
        dtype,
        progress_callback: (info) => {
          port.post({ type: 'progress', info })
        },
      })
      loadedKey = key
      port.post({ type: 'loaded', key, runtime: runtimeInfo(lastPackStatus) })
    } catch (err) {
      tts = null
      loadedKey = ''
      port.post({ type: 'loadError', message: err instanceof Error ? err.message : 'Native model load failed', key })
    }
    return
  }

  if (msg.type === 'generate') {
    if (cancelledIds.delete(msg.id)) {
      port.post({ type: 'generateError', message: 'Generation cancelled.', id: msg.id })
      return
    }
    if (!tts) {
      port.post({ type: 'generateError', message: 'Native model not loaded', id: msg.id })
      return
    }
    try {
      const audio = (await tts.generate(msg.text, { voice: msg.voice as never, speed: msg.speed })) as { audio?: Float32Array }
      if (cancelledIds.delete(msg.id)) {
        port.post({ type: 'generateError', message: 'Generation cancelled.', id: msg.id })
      } else if (audio.audio) {
        port.post({ type: 'generated', samples: audio.audio, id: msg.id })
      } else {
        port.post({ type: 'generateError', message: 'No audio produced', id: msg.id })
      }
    } catch (err) {
      port.post({
        type: 'generateError',
        message: cancelledIds.delete(msg.id)
          ? 'Generation cancelled.'
          : err instanceof Error ? err.message : 'Native generation failed',
        id: msg.id,
      })
    }
  }
})
