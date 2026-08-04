import {
  QWEN_LANGUAGES,
  QWEN_MODEL_ID,
  QWEN_SPEAKERS,
  type QwenLanguage,
  type QwenSpeaker,
  type SidecarHostMessage,
  type SidecarStatus,
} from '../../electron/sidecar-ipc.ts'
import { getSidecarBridge } from './index.ts'

export { QWEN_LANGUAGES, QWEN_SPEAKERS, QWEN_MODEL_ID }
export type { QwenLanguage, QwenSpeaker, SidecarStatus }

export type QwenAudio = {
  samples: Float32Array
  sampleRate: number
}

type PendingGeneration = {
  resolve: (audio: QwenAudio) => void
  reject: (error: Error) => void
  onProgress?: (progress: number, stage: string) => void
  cleanup: () => void
}

const unavailableStatus: SidecarStatus = {
  available: false,
  qwenInstalled: false,
  torchInstalled: false,
  modelReady: false,
  modelId: QWEN_MODEL_ID,
  message: 'The Qwen3-TTS sidecar is available only in the Windows desktop app.',
  recovery: 'Use the unsigned Windows desktop build to install the optional Python runtime.',
}

let subscribed = false
let nextId = 0
const pending = new Map<number, PendingGeneration>()
const statusWaiters = new Map<number, { resolve: (status: SidecarStatus) => void; reject: (error: Error) => void }>()
const setupWaiters = new Map<number, { resolve: (status: SidecarStatus) => void; reject: (error: Error) => void; onProgress?: (progress: number, stage: string) => void }>()

function cancellationError(): DOMException {
  return new DOMException('Generation cancelled.', 'AbortError')
}

function sidecarError(message: unknown): Error {
  return new Error(typeof message === 'string' && message ? message : 'The Qwen3-TTS sidecar request failed.')
}

function rejectAll(error: Error): void {
  for (const waiter of statusWaiters.values()) waiter.reject(error)
  statusWaiters.clear()
  for (const waiter of setupWaiters.values()) waiter.reject(error)
  setupWaiters.clear()
  for (const entry of pending.values()) {
    entry.cleanup()
    entry.reject(error)
  }
  pending.clear()
}

function handleMessage(message: SidecarHostMessage): void {
  if (message.type === 'status') {
    const waiter = statusWaiters.get(message.id)
    if (!waiter) return
    statusWaiters.delete(message.id)
    waiter.resolve(message.status)
    return
  }
  if (message.type === 'setup-progress') {
    setupWaiters.get(message.id)?.onProgress?.(message.progress, message.stage)
    return
  }
  if (message.type === 'setup-result') {
    const waiter = setupWaiters.get(message.id)
    if (!waiter) return
    setupWaiters.delete(message.id)
    waiter.resolve(message.status)
    return
  }
  if (message.type === 'progress') {
    pending.get(message.id)?.onProgress?.(message.progress, message.stage)
    return
  }
  if (message.type === 'generated') {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    entry?.cleanup()
    if (!entry) return
    const samples = message.samples instanceof Float32Array ? message.samples : new Float32Array(message.samples)
    entry.resolve({ samples, sampleRate: message.sampleRate })
    return
  }
  if (message.type === 'error') {
    const setup = setupWaiters.get(message.id)
    if (setup) {
      setupWaiters.delete(message.id)
      setup.reject(message.code === 'cancelled' ? cancellationError() : sidecarError(message.message))
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    entry.cleanup()
    entry.reject(message.code === 'cancelled' ? cancellationError() : sidecarError(message.message))
    return
  }
  if (message.type === 'crashed') {
    rejectAll(sidecarError(message.message))
  }
}

function ensureSubscription() {
  const bridge = getSidecarBridge()
  if (!bridge) throw new Error('Qwen3-TTS is only available in the desktop app.')
  if (!subscribed) {
    bridge.onMessage((message) => handleMessage(message as SidecarHostMessage))
    subscribed = true
  }
  return bridge
}

export function qwenSidecarAvailable(): boolean {
  return getSidecarBridge() !== null
}

export function getQwenSidecarStatus(): Promise<SidecarStatus> {
  let bridge
  try {
    bridge = ensureSubscription()
  } catch {
    return Promise.resolve(unavailableStatus)
  }
  const id = nextId++
  return new Promise<SidecarStatus>((resolve, reject) => {
    statusWaiters.set(id, { resolve, reject })
    bridge.post({ type: 'status', id })
  })
}

export function setupQwenSidecar(onProgress?: (progress: number, stage: string) => void): Promise<SidecarStatus> {
  const bridge = ensureSubscription()
  const id = nextId++
  return new Promise<SidecarStatus>((resolve, reject) => {
    setupWaiters.set(id, { resolve, reject, onProgress })
    bridge.post({ type: 'setup', id })
  })
}

export function synthesizeQwen(
  text: string,
  options: { language: QwenLanguage; speaker: QwenSpeaker; instruct?: string; speed: number },
  signal?: AbortSignal,
  onProgress?: (progress: number, stage: string) => void,
): Promise<QwenAudio> {
  if (signal?.aborted) return Promise.reject(cancellationError())
  let bridge
  try {
    bridge = ensureSubscription()
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : sidecarError(error))
  }
  const id = nextId++
  return new Promise<QwenAudio>((resolve, reject) => {
    const onAbort = () => {
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      entry.cleanup()
      bridge.post({ type: 'cancel', id })
      reject(cancellationError())
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(id, { resolve, reject, cleanup, onProgress })
    bridge.post({ type: 'synthesize', id, text, ...options })
  })
}
