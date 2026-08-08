export const SIDECAR_CHANNEL = 'bettertts:sidecar'
export const QWEN_MODEL_ID = 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice'
export const QWEN_SAMPLE_RATE = 24_000

export const QWEN_LANGUAGES = [
  'Auto',
  'Chinese',
  'English',
  'Japanese',
  'Korean',
  'German',
  'French',
  'Russian',
  'Portuguese',
  'Spanish',
  'Italian',
] as const

export type QwenLanguage = typeof QWEN_LANGUAGES[number]

export const QWEN_SPEAKERS = [
  'Vivian',
  'Serena',
  'Uncle_Fu',
  'Dylan',
  'Eric',
  'Ryan',
  'Aiden',
  'Ono_Anna',
  'Sohee',
] as const

export type QwenSpeaker = typeof QWEN_SPEAKERS[number]

export type SidecarStatus = {
  available: boolean
  pythonPath?: string
  pythonVersion?: string
  qwenVersion?: string
  torchVersion?: string
  qwenInstalled: boolean
  torchInstalled: boolean
  modelReady: boolean
  modelId: string
  modelRevision?: string
  freeDiskBytes?: number
  freeMemoryBytes?: number
  gpuAvailable?: boolean
  message: string
  recovery: string
  testMode?: boolean
}

export type ValidSidecarRequest =
  | { type: 'status'; id: number }
  | { type: 'setup'; id: number }
  | {
    type: 'synthesize'
    id: number
    text: string
    language: QwenLanguage
    speaker: QwenSpeaker
    instruct?: string
    speed: number
  }
  | { type: 'cancel'; id: number }

const MAX_TEXT_CHARS = 5_000
const MAX_INSTRUCT_CHARS = 500
const MAX_ID = Number.MAX_SAFE_INTEGER

function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_ID
}

function validSpeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 1.5
}

export function validateSidecarRequest(value: unknown): ValidSidecarRequest | null {
  if (!value || typeof value !== 'object') return null
  const request = value as Record<string, unknown>
  if (!validId(request.id)) return null

  if (request.type === 'status' || request.type === 'setup' || request.type === 'cancel') {
    return { type: request.type, id: Number(request.id) }
  }

  if (request.type !== 'synthesize') return null
  if (
    typeof request.text !== 'string'
    || request.text.trim().length === 0
    || request.text.length > MAX_TEXT_CHARS
    || typeof request.language !== 'string'
    || !QWEN_LANGUAGES.includes(request.language as QwenLanguage)
    || typeof request.speaker !== 'string'
    || !QWEN_SPEAKERS.includes(request.speaker as QwenSpeaker)
    || (request.instruct !== undefined && (typeof request.instruct !== 'string' || request.instruct.length > MAX_INSTRUCT_CHARS))
    || !validSpeed(request.speed)
  ) return null

  return {
    type: 'synthesize',
    id: Number(request.id),
    text: request.text,
    language: request.language as QwenLanguage,
    speaker: request.speaker as QwenSpeaker,
    ...(request.instruct ? { instruct: request.instruct } : {}),
    speed: Number(request.speed),
  }
}

export type SidecarHostMessage =
  | { type: 'status'; id: number; status: SidecarStatus }
  | { type: 'setup-progress'; id: number; progress: number; stage: string }
  | { type: 'setup-result'; id: number; status: SidecarStatus }
  | { type: 'progress'; id: number; progress: number; stage: string }
  | { type: 'generated'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'error'; id: number; code: 'missing-python' | 'missing-package' | 'missing-model' | 'cancelled' | 'failed' | 'crashed'; message: string }
  | { type: 'diagnostic'; source: 'qwen.stderr'; message: string }
  | { type: 'crashed'; message: string }
