import type { ProgressInfo } from './kokoro.ts'
import {
  CHATTERBOX_MAX_REFERENCE_BYTES,
  CHATTERBOX_MAX_REFERENCE_SECONDS,
  CHATTERBOX_MIN_REFERENCE_SECONDS,
  CHATTERBOX_SAMPLE_RATE,
  CHATTERBOX_MAX_NEW_TOKENS,
  chatterboxModelId,
  chatterboxPrompt,
  clampChatterboxExaggeration,
  type ChatterboxLanguageId,
  type ChatterboxModelVariant,
} from './chatterbox-config.ts'
import type { ChatterboxWorkerRequest, ChatterboxWorkerResponse } from '../worker/chatterbox.worker.ts'

export {
  CHATTERBOX_DEFAULT_EXAGGERATION,
  CHATTERBOX_MAX_NEW_TOKENS,
  CHATTERBOX_MAX_REFERENCE_BYTES,
  CHATTERBOX_MAX_REFERENCE_SECONDS,
  CHATTERBOX_MIN_REFERENCE_SECONDS,
  CHATTERBOX_SAMPLE_RATE,
  CHATTERBOX_LANGUAGES,
  CHATTERBOX_ENGLISH_MODEL_ID,
  CHATTERBOX_MULTILINGUAL_MODEL_ID,
  chatterboxLanguageLabel,
  chatterboxModelId,
  chatterboxModelLabel,
  chatterboxPrompt,
  clampChatterboxExaggeration,
  type ChatterboxLanguageId,
  type ChatterboxModelVariant,
} from './chatterbox-config.ts'
import { chatterboxLanguageLabel, chatterboxModelLabel } from './chatterbox-config.ts'

export type ChatterboxReference = {
  id: string
  name: string
  samples: Float32Array
  durationSeconds: number
}

export type ChatterboxSynthesizedAudio = {
  samples: Float32Array
  sampleRate: number
}

export type ChatterboxSynthesisOptions = {
  model: ChatterboxModelVariant
  language: ChatterboxLanguageId
  exaggeration: number
  reference: ChatterboxReference
}

export function validateChatterboxReference(samples: Float32Array, sampleRate = CHATTERBOX_SAMPLE_RATE): string | null {
  if (samples.length === 0) return 'Choose a non-empty reference clip.'
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 'The reference clip has an invalid sample rate.'
  const duration = samples.length / sampleRate
  if (duration < CHATTERBOX_MIN_REFERENCE_SECONDS) return `Reference clips must be at least ${CHATTERBOX_MIN_REFERENCE_SECONDS} seconds.`
  if (duration > CHATTERBOX_MAX_REFERENCE_SECONDS) return `Reference clips must be ${CHATTERBOX_MAX_REFERENCE_SECONDS} seconds or shorter.`
  for (const sample of samples) {
    if (!Number.isFinite(sample)) return 'The reference clip contains invalid audio samples.'
  }
  return null
}

export function resampleMonoAudio(samples: Float32Array, sourceRate: number, targetRate = CHATTERBOX_SAMPLE_RATE): Float32Array {
  if (samples.length === 0) return new Float32Array()
  if (sourceRate === targetRate) return new Float32Array(samples)
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) throw new Error('The reference clip has an invalid sample rate.')
  const targetLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate))
  const result = new Float32Array(targetLength)
  const ratio = sourceRate / targetRate
  for (let index = 0; index < targetLength; index += 1) {
    const sourcePosition = index * ratio
    const left = Math.min(samples.length - 1, Math.floor(sourcePosition))
    const right = Math.min(samples.length - 1, left + 1)
    const weight = sourcePosition - left
    result[index] = samples[left] * (1 - weight) + samples[right] * weight
  }
  return result
}

function referenceFileError(file: File): string | null {
  if (!Number.isFinite(file.size) || file.size <= 0) return 'Reference audio is empty or has an invalid size.'
  if (file.size > CHATTERBOX_MAX_REFERENCE_BYTES) return `Reference audio must be ${Math.round(CHATTERBOX_MAX_REFERENCE_BYTES / 1024 / 1024)} MB or smaller.`
  if (file.type && !file.type.toLowerCase().startsWith('audio/')) return 'Choose an audio reference clip.'
  return null
}

export async function decodeChatterboxReference(file: File): Promise<ChatterboxReference> {
  const fileError = referenceFileError(file)
  if (fileError) throw new Error(fileError)
  if (typeof AudioContext === 'undefined') throw new Error('This browser cannot decode reference audio locally.')

  const context = new AudioContext({ sampleRate: CHATTERBOX_SAMPLE_RATE })
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer())
    const mono = new Float32Array(decoded.length)
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const data = decoded.getChannelData(channel)
      for (let index = 0; index < mono.length; index += 1) mono[index] += data[index] / decoded.numberOfChannels
    }
    const samples = resampleMonoAudio(mono, decoded.sampleRate)
    const validationError = validateChatterboxReference(samples)
    if (validationError) throw new Error(validationError)
    return {
      id: crypto.randomUUID(),
      name: file.name || 'Reference clip',
      samples,
      durationSeconds: samples.length / CHATTERBOX_SAMPLE_RATE,
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Reference ')) throw error
    throw new Error('Could not decode that reference clip locally. Try a WAV, MP3, or OGG audio file.')
  } finally {
    await context.close().catch(() => {})
  }
}

let worker: Worker | null = null
let nextId = 0
let loadPromise: Promise<void> | null = null
let loadKey = ''
let progressCallback: ((info: ProgressInfo) => void) | null = null
const knownReferences = new Set<string>()
const loadWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
const pending = new Map<number, {
  referenceId: string
  sentReference: boolean
  resolve: (audio: ChatterboxSynthesizedAudio) => void
  reject: (error: Error) => void
  cleanup: () => void
}>()

function cancellationError(): DOMException {
  return new DOMException('Generation cancelled.', 'AbortError')
}

function rejectAll(error: Error) {
  loadPromise = null
  loadKey = ''
  knownReferences.clear()
  for (const waiter of loadWaiters.values()) waiter.reject(error)
  loadWaiters.clear()
  for (const entry of pending.values()) {
    entry.cleanup()
    entry.reject(error)
  }
  pending.clear()
}

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../worker/chatterbox.worker.ts', import.meta.url), { type: 'module' })
  worker.addEventListener('message', (event: MessageEvent<ChatterboxWorkerResponse>) => {
    const message = event.data
    if (message.type === 'progress') {
      progressCallback?.(message.info)
    } else if (message.type === 'loaded') {
      loadWaiters.get(message.key)?.resolve()
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
      const entry = pending.get(message.id)
      pending.delete(message.id)
      entry?.cleanup()
      if (entry) {
        knownReferences.add(entry.referenceId)
        entry.resolve({ samples: message.samples, sampleRate: CHATTERBOX_SAMPLE_RATE })
      }
    } else if (message.type === 'generateError') {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      entry?.cleanup()
      if (entry?.sentReference) knownReferences.delete(entry.referenceId)
      entry?.reject(new Error(message.message))
    } else if (message.type === 'cancelled') {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      entry?.cleanup()
      if (entry?.sentReference) knownReferences.delete(entry.referenceId)
      entry?.reject(cancellationError())
    }
  })
  const onWorkerFailure = () => {
    worker = null
    rejectAll(new Error('The Chatterbox worker crashed. Generate again to restart it.'))
  }
  worker.addEventListener('error', onWorkerFailure)
  worker.addEventListener('messageerror', onWorkerFailure)
  return worker
}

export function loadChatterboxWorker(
  model: ChatterboxModelVariant,
  device: 'webgpu' | 'wasm',
  onProgress: (info: ProgressInfo) => void,
): Promise<void> {
  progressCallback = onProgress
  const key = `${chatterboxModelId(model)}:${device}`
  if (loadPromise && loadKey === key) return loadPromise
  if (loadKey !== key) knownReferences.clear()
  const currentWorker = getWorker()
  loadKey = key
  loadPromise = new Promise<void>((resolve, reject) => {
    loadWaiters.set(key, { resolve, reject })
    currentWorker.postMessage({ type: 'load', model, device } satisfies ChatterboxWorkerRequest)
  })
  return loadPromise
}

export function synthesizeChatterbox(
  text: string,
  options: ChatterboxSynthesisOptions,
  signal?: AbortSignal,
): Promise<ChatterboxSynthesizedAudio> {
  if (signal?.aborted) return Promise.reject(cancellationError())
  const currentWorker = getWorker()
  const id = nextId++
  const referenceId = options.reference.id
  const sentReference = !knownReferences.has(referenceId)
  const referenceAudio = sentReference ? new Float32Array(options.reference.samples) : undefined
  const request: ChatterboxWorkerRequest = {
    type: 'generate',
    id,
    text: chatterboxPrompt(text, options.model, options.language),
    exaggeration: clampChatterboxExaggeration(options.exaggeration),
    maxNewTokens: CHATTERBOX_MAX_NEW_TOKENS,
    referenceId,
    referenceAudio,
  }
  return new Promise<ChatterboxSynthesizedAudio>((resolve, reject) => {
    const onAbort = () => {
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      entry.cleanup()
      if (entry.sentReference) knownReferences.delete(entry.referenceId)
      currentWorker.postMessage({ type: 'cancel', id } satisfies ChatterboxWorkerRequest)
      reject(cancellationError())
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(id, { referenceId, sentReference, resolve, reject, cleanup })
    const transfer = referenceAudio ? [referenceAudio.buffer as ArrayBuffer] : []
    currentWorker.postMessage(request, { transfer })
  })
}

export function cancelChatterboxGeneration() {
  if (!worker && pending.size === 0) return
  for (const id of pending.keys()) worker?.postMessage({ type: 'cancel', id } satisfies ChatterboxWorkerRequest)
  worker?.terminate()
  worker = null
  rejectAll(cancellationError())
}

export function resetChatterboxSession() {
  worker?.terminate()
  worker = null
  rejectAll(new Error('Chatterbox session was reset.'))
}

export function formatChatterboxReference(reference: ChatterboxReference | null): string {
  if (!reference) return 'No reference clip selected.'
  return `${reference.name} · ${reference.durationSeconds.toFixed(1)}s`
}

export function chatterboxSelectionLabel(model: ChatterboxModelVariant, language: ChatterboxLanguageId): string {
  return `${chatterboxModelLabel(model)} · ${chatterboxLanguageLabel(language)}`
}
