export type ValidNativeTtsRequest =
  | { type: 'load'; dtype?: 'q8'; engine?: 'kokoro' | 'piper' | 'melo' }
  | { type: 'generate'; text: string; voice: string; speed: number; id: number; engine?: 'kokoro' | 'piper' | 'melo' }
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
    return (request.dtype === undefined || request.dtype === 'q8')
      && (request.engine === undefined || request.engine === 'kokoro' || request.engine === 'piper' || request.engine === 'melo')
      ? {
        type: 'load',
        ...(request.dtype ? { dtype: request.dtype } : {}),
        ...(request.engine ? { engine: request.engine } : {}),
      }
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
      || (request.engine !== undefined && request.engine !== 'kokoro' && request.engine !== 'piper' && request.engine !== 'melo')
    ) return null
    return {
      type: 'generate',
      text: request.text,
      voice: request.voice,
      speed: Number(request.speed),
      id: Number(request.id),
      ...(request.engine ? { engine: request.engine } : {}),
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
