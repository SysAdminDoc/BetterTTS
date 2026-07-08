import type { ProgressInfo } from './kokoro.ts'
import type { WorkerRequest, WorkerResponse } from '../worker/tts.worker.ts'

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, { resolve: (samples: Float32Array) => void; reject: (err: Error) => void }>()
let progressCallback: ((info: ProgressInfo) => void) | null = null
let loadResolve: (() => void) | null = null
let loadReject: ((err: Error) => void) | null = null

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../worker/tts.worker.ts', import.meta.url), { type: 'module' })
  worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data
    if (msg.type === 'progress') {
      progressCallback?.(msg.info)
    } else if (msg.type === 'loaded') {
      loadResolve?.()
    } else if (msg.type === 'loadError') {
      loadReject?.(new Error(msg.message))
    } else if (msg.type === 'generated') {
      pending.get(msg.id)?.resolve(msg.samples)
      pending.delete(msg.id)
    } else if (msg.type === 'generateError') {
      pending.get(msg.id)?.reject(new Error(msg.message))
      pending.delete(msg.id)
    }
  })
  worker.addEventListener('error', () => {
    for (const { reject } of pending.values()) reject(new Error('Worker crashed'))
    pending.clear()
    worker = null
  })
  return worker
}

export async function loadKokoroWorker(
  device: 'webgpu' | 'wasm',
  dtype: 'fp32' | 'q8',
  onProgress: (info: ProgressInfo) => void,
): Promise<void> {
  progressCallback = onProgress
  const w = getWorker()
  return new Promise<void>((resolve, reject) => {
    loadResolve = resolve
    loadReject = reject
    w.postMessage({ type: 'load', device, dtype } satisfies WorkerRequest)
  })
}

export function generateWorker(text: string, voice: string, speed: number): Promise<Float32Array> {
  const w = getWorker()
  const id = nextId++
  return new Promise<Float32Array>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ type: 'generate', text, voice, speed, id } satisfies WorkerRequest)
  })
}

export function resetWorker() {
  worker?.terminate()
  worker = null
  pending.clear()
}
