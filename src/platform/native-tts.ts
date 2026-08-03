// Renderer client for the desktop native inference host (TF-99). Mirrors the
// browser worker client in src/lib/kokoro-worker.ts, but transports over the
// betterttsPlatform IPC bridge instead of a Worker. Web builds resolve
// getNativeTtsBridge() to null, so every entry point is a safe no-op there.
import type { ProgressInfo } from '../lib/kokoro.ts'
import { getNativeTtsBridge } from './index.ts'

export type NativeModelPackStatus = {
  id: string
  modelId: string
  revision: string
  version: string
  license: { spdx: string; tier: string }
  installed: boolean
  verified: boolean
  totalBytes: number
  expectedBytes: number
  blockedReason: string | null
  notCovered?: string
  sourceSha256?: string
}

export type NativeRuntimeInfo = {
  runtime: 'onnxruntime-node' | 'sherpa-onnx-node'
  ep: 'cpu'
  ortVersion?: string
  transformersVersion?: string
  kokoroJsVersion?: string
  sherpaVersion?: string
  nativeAddon?: {
    package: string
    version: string
    present: boolean
  }
  node: string
  modelCacheDir: string
  engine?: 'kokoro' | 'piper'
  sampleRate?: number
  modelPack?: NativeModelPackStatus
  modelPackFailure?: {
    kind: 'integrity' | 'license' | 'unavailable'
    message: string
  }
}

type HostMessage =
  | { type: 'progress'; info: ProgressInfo }
  | { type: 'loaded'; key: string; runtime: NativeRuntimeInfo }
  | { type: 'loadError'; message: string; key: string }
  | { type: 'generated'; samples: Float32Array; sampleRate?: number; id: number }
  | { type: 'generateError'; message: string; id: number }
  | { type: 'info'; runtime: NativeRuntimeInfo }
  | { type: 'crashed' }

let subscribed = false
let nextId = 0
const pending = new Map<number, {
  resolve: (samples: Float32Array) => void
  reject: (err: Error) => void
  cleanup: () => void
}>()
let progressCallback: ((info: ProgressInfo) => void) | null = null
let loadPromise: Promise<NativeRuntimeInfo> | null = null
let loadKey = ''
const loadWaiters = new Map<string, { resolve: (runtime: NativeRuntimeInfo) => void; reject: (err: Error) => void }>()
let runtimeInfo: NativeRuntimeInfo | null = null

export function nativeTtsAvailable(): boolean {
  return getNativeTtsBridge() !== null
}

export function getNativeRuntimeInfo(): NativeRuntimeInfo | null {
  return runtimeInfo
}

function rejectAll(err: Error) {
  loadPromise = null
  loadKey = ''
  for (const waiter of loadWaiters.values()) waiter.reject(err)
  loadWaiters.clear()
  for (const entry of pending.values()) {
    entry.cleanup()
    entry.reject(err)
  }
  pending.clear()
}

function cancellationError(): DOMException {
  return new DOMException('Generation cancelled.', 'AbortError')
}

function handleMessage(message: HostMessage) {
  if (message.type === 'progress') {
    progressCallback?.(message.info)
  } else if (message.type === 'loaded') {
    runtimeInfo = message.runtime
    loadWaiters.get(message.key)?.resolve(message.runtime)
    loadWaiters.delete(message.key)
  } else if (message.type === 'loadError') {
    const waiter = loadWaiters.get(message.key)
    loadWaiters.delete(message.key)
    if (loadKey === message.key) {
      loadPromise = null
      loadKey = ''
    }
    waiter?.reject(new Error(message.message))
  } else if (message.type === 'generated') {
    // Structured clone across the bridge can arrive as a plain typed-array view;
    // normalize so downstream buffer math sees a real Float32Array.
    const samples = message.samples instanceof Float32Array ? message.samples : new Float32Array(message.samples)
    const entry = pending.get(message.id)
    pending.delete(message.id)
    entry?.cleanup()
    entry?.resolve(samples)
  } else if (message.type === 'generateError') {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    entry?.cleanup()
    entry?.reject(new Error(message.message))
  } else if (message.type === 'crashed') {
    runtimeInfo = null
    rejectAll(new Error('The native inference host crashed. Generate again to restart it.'))
  }
}

function ensureSubscription(): ReturnType<typeof getNativeTtsBridge> {
  const bridge = getNativeTtsBridge()
  if (!bridge) throw new Error('Native TTS is only available in the desktop app.')
  if (!subscribed) {
    bridge.onMessage((message) => handleMessage(message as HostMessage))
    subscribed = true
  }
  return bridge
}

function loadNativeEngine(engine: 'kokoro' | 'piper', onProgress: (info: ProgressInfo) => void): Promise<NativeRuntimeInfo> {
  progressCallback = onProgress
  const key = engine === 'piper' ? 'sherpa:piper' : 'cpu:q8'
  if (loadPromise && loadKey === key) return loadPromise
  let bridge: ReturnType<typeof getNativeTtsBridge>
  try {
    bridge = ensureSubscription()
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
  loadKey = key
  loadPromise = new Promise<NativeRuntimeInfo>((resolve, reject) => {
    loadWaiters.set(key, { resolve, reject })
    bridge!.post({ type: 'load', dtype: 'q8', ...(engine === 'piper' ? { engine } : {}) })
  })
  return loadPromise
}

export function loadNativeKokoro(onProgress: (info: ProgressInfo) => void): Promise<NativeRuntimeInfo> {
  return loadNativeEngine('kokoro', onProgress)
}

export function loadNativePiper(onProgress: (info: ProgressInfo) => void): Promise<NativeRuntimeInfo> {
  return loadNativeEngine('piper', onProgress)
}

export function generateNative(
  text: string,
  voice: string,
  speed: number,
  signal?: AbortSignal,
  engine: 'kokoro' | 'piper' = 'kokoro',
): Promise<Float32Array> {
  if (signal?.aborted) return Promise.reject(cancellationError())
  let bridge: ReturnType<typeof getNativeTtsBridge>
  try {
    bridge = ensureSubscription()
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
  const id = nextId++
  return new Promise<Float32Array>((resolve, reject) => {
    const onAbort = () => {
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      entry.cleanup()
      bridge!.post({ type: 'cancel', id })
      reject(cancellationError())
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(id, { resolve, reject, cleanup })
    bridge!.post({ type: 'generate', text, voice, speed, id, ...(engine === 'piper' ? { engine } : {}) })
  })
}

export function cancelNativeGeneration() {
  const bridge = getNativeTtsBridge()
  if (!bridge && pending.size === 0) return
  bridge?.post({ type: 'cancel-all' })
  runtimeInfo = null
  rejectAll(cancellationError())
}

export function resetNativeTts() {
  const bridge = getNativeTtsBridge()
  bridge?.post({ type: 'reset' })
  runtimeInfo = null
  rejectAll(new Error('Native TTS session was reset.'))
}
