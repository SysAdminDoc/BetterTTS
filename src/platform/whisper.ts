import type { WhisperAlignment, WhisperRuntimeStatus } from '../lib/whisper.ts'
import { getWhisperBridge } from './index.ts'

type WhisperMessage =
  | { type: 'status'; id: number; status: WhisperRuntimeStatus }
  | { type: 'progress'; id: number; progress: number }
  | { type: 'result'; id: number; alignment: WhisperAlignment }
  | { type: 'error'; id: number; message: string; code?: string }

let subscribed = false
let nextId = 1
let statusPromise: Promise<WhisperRuntimeStatus> | null = null
const statusWaiters = new Map<number, { resolve: (status: WhisperRuntimeStatus) => void; reject: (error: Error) => void }>()
const pending = new Map<number, {
  resolve: (alignment: WhisperAlignment) => void
  reject: (error: Error) => void
  cleanup: () => void
  onProgress?: (progress: number) => void
}>()

function bridgeOrThrow() {
  const bridge = getWhisperBridge()
  if (!bridge) throw new Error('Desktop whisper.cpp captioning is only available in the Windows app.')
  return bridge
}

function rejectAll(error: Error): void {
  statusPromise = null
  for (const waiter of statusWaiters.values()) waiter.reject(error)
  statusWaiters.clear()
  for (const entry of pending.values()) {
    entry.cleanup()
    entry.reject(error)
  }
  pending.clear()
}

function handleMessage(message: WhisperMessage): void {
  if (!message || typeof message !== 'object') return
  if (message.type === 'status') {
    statusPromise = null
    const waiter = statusWaiters.get(message.id)
    statusWaiters.delete(message.id)
    waiter?.resolve(message.status)
    return
  }
  if (message.type === 'progress') {
    pending.get(message.id)?.onProgress?.(Math.max(0, Math.min(100, message.progress)))
    return
  }
  if (message.type === 'result') {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    entry.cleanup()
    entry.resolve(message.alignment)
    return
  }
  if (message.type === 'error') {
    if (message.id === 0) {
      rejectAll(new Error(message.message))
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    entry.cleanup()
    const error = new Error(message.message)
    error.name = message.code === 'cancelled' ? 'AbortError' : 'WhisperError'
    entry.reject(error)
  }
}

function ensureSubscription() {
  const bridge = bridgeOrThrow()
  if (!subscribed) {
    bridge.onMessage((message) => handleMessage(message as WhisperMessage))
    subscribed = true
  }
  return bridge
}

export function whisperDesktopAvailable(): boolean {
  return getWhisperBridge() !== null
}

export function getWhisperRuntimeStatus(): Promise<WhisperRuntimeStatus> {
  if (statusPromise) return statusPromise
  let bridge
  try {
    bridge = ensureSubscription()
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
  const id = nextId++
  statusPromise = new Promise<WhisperRuntimeStatus>((resolve, reject) => {
    statusWaiters.set(id, { resolve, reject })
    bridge.post({ type: 'status', id })
  })
  return statusPromise
}

export function transcribeWhisper(
  audio: Uint8Array,
  language: string,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<WhisperAlignment> {
  if (signal?.aborted) return Promise.reject(new DOMException('Caption generation cancelled.', 'AbortError'))
  let bridge
  try {
    bridge = ensureSubscription()
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }

  const id = nextId++
  return new Promise<WhisperAlignment>((resolve, reject) => {
    const onAbort = () => {
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      entry.cleanup()
      bridge.post({ type: 'cancel', id })
      reject(new DOMException('Caption generation cancelled.', 'AbortError'))
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(id, { resolve, reject, cleanup, onProgress })
    bridge.post({ type: 'transcribe', id, audio, language })
  })
}
