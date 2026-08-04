import type { OpenAiTtsServerStatus } from './openai-server.ts'

export const OPENAI_TTS_CHANNEL = 'bettertts:openai-tts'

export type ValidOpenAiTtsRequest =
  | { action: 'status' }
  | { action: 'start'; port: number }
  | { action: 'stop' }

export function validateOpenAiTtsRequest(value: unknown): ValidOpenAiTtsRequest | null {
  if (!value || typeof value !== 'object') return null
  const request = value as Record<string, unknown>
  if (request.action === 'status' || request.action === 'stop') return { action: request.action }
  if (request.action !== 'start') return null
  if (!Number.isSafeInteger(request.port) || Number(request.port) < 0 || Number(request.port) > 65_535) return null
  return { action: 'start', port: Number(request.port) }
}

export type OpenAiTtsIpcResult = OpenAiTtsServerStatus
