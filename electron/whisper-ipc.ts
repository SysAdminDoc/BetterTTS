import { MAX_WHISPER_AUDIO_BYTES, WHISPER_LANGUAGES, type WhisperAlignment, type WhisperRuntimeStatus } from '../src/lib/whisper.ts'

export const WHISPER_CHANNEL = 'bettertts:whisper'

export type ValidWhisperRequest =
  | { type: 'status'; id: number }
  | { type: 'transcribe'; id: number; audio: Uint8Array; language: string }
  | { type: 'cancel'; id: number }

export type WhisperHostRequest =
  | { type: 'status'; id: number }
  | { type: 'transcribe'; id: number; audio: Uint8Array; language: string }
  | { type: 'cancel'; id: number }

export type WhisperHostResponse =
  | { type: 'status'; id: number; status: WhisperRuntimeStatus }
  | { type: 'progress'; id: number; progress: number }
  | { type: 'result'; id: number; alignment: WhisperAlignment }
  | { type: 'error'; id: number; message: string; code: 'missing-cli' | 'missing-model' | 'cancelled' | 'failed' }

const LANGUAGE_IDS = new Set<string>(WHISPER_LANGUAGES.map(({ id }) => id))

function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function validLanguage(value: unknown): value is string {
  return typeof value === 'string' && (LANGUAGE_IDS.has(value) || /^[a-z]{2,8}$/iu.test(value))
}

export function validateWhisperRequest(value: unknown): ValidWhisperRequest | null {
  if (!value || typeof value !== 'object') return null
  const request = value as Record<string, unknown>
  if (!validId(request.id)) return null

  if (request.type === 'status') return { type: 'status', id: Number(request.id) }
  if (request.type === 'cancel') return { type: 'cancel', id: Number(request.id) }
  if (request.type !== 'transcribe' || !validLanguage(request.language)) return null

  const audio = request.audio instanceof Uint8Array ? request.audio : null
  if (!audio || audio.byteLength === 0 || audio.byteLength > MAX_WHISPER_AUDIO_BYTES) return null
  return {
    type: 'transcribe',
    id: Number(request.id),
    audio: new Uint8Array(audio),
    language: request.language.toLowerCase(),
  }
}
