export type ValidNativeTtsRequest =
  | { type: 'load'; dtype?: 'q8' }
  | { type: 'generate'; text: string; voice: string; speed: number; id: number }
  | { type: 'cancel'; id: number }
  | { type: 'cancel-all' }
  | { type: 'reset' }
  | { type: 'info' }

const MAX_NATIVE_TEXT_CHARS = 10_000
const MAX_NATIVE_VOICE_CHARS = 100

export function validateNativeTtsRequest(value: unknown): ValidNativeTtsRequest | null {
  if (!value || typeof value !== 'object') return null
  const request = value as Record<string, unknown>
  if (request.type === 'load') {
    return request.dtype === undefined || request.dtype === 'q8'
      ? { type: 'load', ...(request.dtype ? { dtype: request.dtype } : {}) }
      : null
  }
  if (request.type === 'generate') {
    if (
      typeof request.text !== 'string'
      || request.text.length === 0
      || request.text.length > MAX_NATIVE_TEXT_CHARS
      || typeof request.voice !== 'string'
      || request.voice.length === 0
      || request.voice.length > MAX_NATIVE_VOICE_CHARS
      || !Number.isFinite(request.speed)
      || Number(request.speed) < 0.5
      || Number(request.speed) > 1.5
      || !Number.isSafeInteger(request.id)
      || Number(request.id) < 0
    ) return null
    return {
      type: 'generate',
      text: request.text,
      voice: request.voice,
      speed: Number(request.speed),
      id: Number(request.id),
    }
  }
  if (request.type === 'cancel') {
    return Number.isSafeInteger(request.id) && Number(request.id) >= 0
      ? { type: 'cancel', id: Number(request.id) }
      : null
  }
  if (request.type === 'cancel-all' || request.type === 'reset' || request.type === 'info') {
    return { type: request.type }
  }
  return null
}
