import { getOpenAiTtsServerBridge, type OpenAiTtsServerStatus } from './index.ts'

export const OPENAI_TTS_PORT_STORAGE_KEY = 'bettertts-openai-tts-port'
export const DEFAULT_OPENAI_TTS_PORT = 8765
export const MIN_OPENAI_TTS_PORT = 1024
export const MAX_OPENAI_TTS_PORT = 65_535

const unavailableStatus: OpenAiTtsServerStatus = {
  running: false,
  host: '127.0.0.1',
  port: null,
  endpoint: null,
  models: [],
}

export function openAiTtsServerAvailable(): boolean {
  return getOpenAiTtsServerBridge() !== null
}

export function getOpenAiTtsServerStatus(): Promise<OpenAiTtsServerStatus> {
  return getOpenAiTtsServerBridge()?.status() ?? Promise.resolve(unavailableStatus)
}

export function startOpenAiTtsServer(port: number): Promise<OpenAiTtsServerStatus> {
  if (!Number.isSafeInteger(port) || port < MIN_OPENAI_TTS_PORT || port > MAX_OPENAI_TTS_PORT) {
    return Promise.reject(new Error(`Choose a local server port from ${MIN_OPENAI_TTS_PORT} to ${MAX_OPENAI_TTS_PORT}.`))
  }
  const bridge = getOpenAiTtsServerBridge()
  return bridge?.start(port) ?? Promise.reject(new Error('The local TTS server is only available in the Windows desktop app.'))
}

export function stopOpenAiTtsServer(): Promise<OpenAiTtsServerStatus> {
  return getOpenAiTtsServerBridge()?.stop() ?? Promise.resolve(unavailableStatus)
}
