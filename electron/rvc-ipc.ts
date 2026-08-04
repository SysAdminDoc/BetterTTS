import type { RvcModelSelection } from '../src/lib/rvc.ts'

export const RVC_CHANNEL = 'bettertts:rvc'
export const RVC_WEIGHTS_CHANNEL = 'bettertts:rvc-weights'
export const RVC_SAMPLE_RATE_MIN = 8_000
export const RVC_SAMPLE_RATE_MAX = 96_000
export const RVC_MAX_PCM_BYTES = 80 * 1024 * 1024
export const RVC_MAX_PATH_CHARS = 4_096

export type RvcRuntimeStatus = {
  available: boolean
  pythonPath?: string
  pythonVersion?: string
  rvcInstalled: boolean
  torchInstalled: boolean
  message: string
  recovery: string
  testMode?: boolean
}

export type ValidRvcRequest =
  | { type: 'status'; id: number }
  | { type: 'setup'; id: number }
  | {
    type: 'convert'
    id: number
    samples: Float32Array
    sampleRate: number
    modelPath: string
    indexPath?: string
    blendModelPath?: string
    blendIndexPath?: string
    blendRatio: number
    pitchSemitones: number
    indexRate: number
  }
  | { type: 'cancel'; id: number }

export type ValidRvcWeightsRequest = {
  action: 'model' | 'index'
}

export type RvcHostMessage =
  | { type: 'status'; id: number; status: RvcRuntimeStatus }
  | { type: 'setup-progress'; id: number; progress: number; stage: string }
  | { type: 'setup-result'; id: number; status: RvcRuntimeStatus }
  | { type: 'progress'; id: number; progress: number; stage: string }
  | { type: 'generated'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'error'; id: number; code: 'missing-python' | 'missing-package' | 'missing-model' | 'cancelled' | 'failed' | 'crashed'; message: string }
  | { type: 'crashed'; message: string }

const MAX_ID = Number.MAX_SAFE_INTEGER
function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_ID
}

function validPath(value: unknown, extension: RegExp): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > RVC_MAX_PATH_CHARS) return false
  if ([...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })) return false
  const absolute = /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\') || value.startsWith('/')
  return absolute && extension.test(value)
}

function validOptionalPath(value: unknown, extension: RegExp): value is string | undefined {
  return value === undefined || validPath(value, extension)
}

function validSamples(value: unknown): value is Float32Array {
  if (!(value instanceof Float32Array) || value.length === 0 || value.length * 2 > RVC_MAX_PCM_BYTES) return false
  return !value.some((sample) => !Number.isFinite(sample))
}

function validSampleRate(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= RVC_SAMPLE_RATE_MIN
    && value <= RVC_SAMPLE_RATE_MAX
}

function validRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

export function validateRvcRequest(value: unknown): ValidRvcRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const request = value as Record<string, unknown>
  if (!validId(request.id)) return null
  if (request.type === 'status' || request.type === 'setup' || request.type === 'cancel') {
    return { type: request.type, id: Number(request.id) }
  }
  if (
    request.type !== 'convert'
    || !validSamples(request.samples)
    || !validSampleRate(request.sampleRate)
    || !validPath(request.modelPath, /\.pth$/iu)
    || !validOptionalPath(request.indexPath, /\.index$/iu)
    || !validOptionalPath(request.blendModelPath, /\.pth$/iu)
    || !validOptionalPath(request.blendIndexPath, /\.index$/iu)
    || !validRange(request.blendRatio, 0, 1)
    || !validRange(request.pitchSemitones, -24, 24)
    || !validRange(request.indexRate, 0, 1)
  ) return null

  return {
    type: 'convert',
    id: Number(request.id),
    samples: request.samples,
    sampleRate: Number(request.sampleRate),
    modelPath: request.modelPath,
    ...(request.indexPath ? { indexPath: request.indexPath } : {}),
    ...(request.blendModelPath ? { blendModelPath: request.blendModelPath } : {}),
    ...(request.blendIndexPath ? { blendIndexPath: request.blendIndexPath } : {}),
    blendRatio: Number(request.blendRatio),
    pitchSemitones: Number(request.pitchSemitones),
    indexRate: Number(request.indexRate),
  }
}

export function validateRvcWeightsRequest(value: unknown): ValidRvcWeightsRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const action = (value as Record<string, unknown>).action
  return action === 'model' || action === 'index' ? { action } : null
}

export type RvcWeightsBridgeResponse = RvcModelSelection
