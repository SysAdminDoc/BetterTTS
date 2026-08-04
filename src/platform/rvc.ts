import {
  type RvcHostMessage,
  type RvcRuntimeStatus,
} from '../../electron/rvc-ipc.ts'
import type { RvcInferencePlan, RvcModelSelection } from '../lib/rvc.ts'
import { getRvcBridge, getRvcWeightsBridge } from './index.ts'

export type { RvcRuntimeStatus }
export type RvcAudio = { samples: Float32Array; sampleRate: number }

const unavailableStatus: RvcRuntimeStatus = {
  available: false,
  rvcInstalled: false,
  torchInstalled: false,
  message: 'RVC voice conversion is available only in the Windows desktop app.',
  recovery: 'Use the unsigned Windows desktop build, acknowledge the local model terms, and set up the optional Python runtime.',
}

type Pending = {
  resolve: (audio: RvcAudio) => void
  reject: (error: Error) => void
  cleanup: () => void
  onProgress?: (progress: number, stage: string) => void
}

let subscribed = false
let nextId = 0
const pending = new Map<number, Pending>()
const statusWaiters = new Map<number, { resolve: (status: RvcRuntimeStatus) => void; reject: (error: Error) => void }>()
const setupWaiters = new Map<number, { resolve: (status: RvcRuntimeStatus) => void; reject: (error: Error) => void; onProgress?: (progress: number, stage: string) => void }>()

function cancellationError(): DOMException {
  return new DOMException('RVC conversion cancelled.', 'AbortError')
}

function rvcError(message: unknown): Error {
  return new Error(typeof message === 'string' && message ? message : 'RVC voice conversion failed.')
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

function handleMessage(message: RvcHostMessage): void {
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
      setup.reject(message.code === 'cancelled' ? cancellationError() : rvcError(message.message))
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    entry.cleanup()
    entry.reject(message.code === 'cancelled' ? cancellationError() : rvcError(message.message))
    return
  }
  if (message.type === 'crashed') rejectAll(rvcError(message.message))
}

function ensureSubscription() {
  const bridge = getRvcBridge()
  if (!bridge) throw new Error('RVC voice conversion is only available in the desktop app.')
  if (!subscribed) {
    bridge.onMessage((message) => handleMessage(message as RvcHostMessage))
    subscribed = true
  }
  return bridge
}

export function rvcAvailable(): boolean {
  return getRvcBridge() !== null
}

export function rvcWeightsAvailable(): boolean {
  return getRvcWeightsBridge() !== null
}

export function getRvcRuntimeStatus(): Promise<RvcRuntimeStatus> {
  let bridge
  try {
    bridge = ensureSubscription()
  } catch {
    return Promise.resolve(unavailableStatus)
  }
  const id = nextId++
  return new Promise<RvcRuntimeStatus>((resolve, reject) => {
    statusWaiters.set(id, { resolve, reject })
    bridge.post({ type: 'status', id })
  })
}

export function setupRvcRuntime(onProgress?: (progress: number, stage: string) => void): Promise<RvcRuntimeStatus> {
  const bridge = ensureSubscription()
  const id = nextId++
  return new Promise<RvcRuntimeStatus>((resolve, reject) => {
    setupWaiters.set(id, { resolve, reject, onProgress })
    bridge.post({ type: 'setup', id })
  })
}

export function chooseRvcModel(): Promise<RvcModelSelection> {
  return getRvcWeightsBridge()?.chooseModel() ?? Promise.resolve({ canceled: true })
}

export function chooseRvcIndex(): Promise<RvcModelSelection> {
  return getRvcWeightsBridge()?.chooseIndex() ?? Promise.resolve({ canceled: true })
}

export function convertRvcAudio(
  samples: Float32Array,
  sampleRate: number,
  plan: RvcInferencePlan,
  signal?: AbortSignal,
  onProgress?: (progress: number, stage: string) => void,
): Promise<RvcAudio> {
  if (signal?.aborted) return Promise.reject(cancellationError())
  let bridge
  try {
    bridge = ensureSubscription()
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : rvcError(error))
  }
  const id = nextId++
  return new Promise<RvcAudio>((resolve, reject) => {
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
    bridge.post({
      type: 'convert',
      id,
      samples,
      sampleRate,
      modelPath: plan.primary.modelPath,
      ...(plan.primary.indexPath ? { indexPath: plan.primary.indexPath } : {}),
      ...(plan.blend ? {
        blendModelPath: plan.blend.modelPath,
        ...(plan.blend.indexPath ? { blendIndexPath: plan.blend.indexPath } : {}),
      } : {}),
      blendRatio: plan.blendRatio,
      pitchSemitones: plan.pitchSemitones,
      indexRate: plan.indexRate,
    })
  })
}

export function cancelRvcGeneration(): void {
  const bridge = getRvcBridge()
  if (!bridge) return
  const ids = [...pending.keys()]
  for (const entry of pending.values()) {
    entry.cleanup()
    entry.reject(cancellationError())
  }
  pending.clear()
  for (const id of ids) bridge.post({ type: 'cancel', id })
}
