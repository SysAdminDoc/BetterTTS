import { SELF_HOSTED_KOKORO_VOICE_IDS } from './voices.ts'

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
export const KOKORO_SAMPLE_RATE = 24000
export const KOKORO_MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231'
export const KOKORO_HF_RESOLVE_PREFIX =
  `https://huggingface.co/${KOKORO_MODEL_ID}/resolve/${KOKORO_MODEL_REVISION}/`
export const KOKORO_LOCAL_MODEL_PREFIX = `models/${KOKORO_MODEL_ID}/`

export const SELF_HOSTED_KOKORO_MODEL_PATHS = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
] as const

const hostedModelPaths = new Set<string>(SELF_HOSTED_KOKORO_MODEL_PATHS)
const hostedVoicePaths = new Set([...SELF_HOSTED_KOKORO_VOICE_IDS].map((voiceId) => `voices/${voiceId}.bin`))
const defaultRetryDelays = [1_000, 2_500]
const maxRetryDelayMs = 60_000
const loadKokoroIntegrity = () => import('./kokoro-integrity.ts')

export function kokoroRemoteAssetUrl(relativePath: string): string {
  return `${KOKORO_HF_RESOLVE_PREFIX}${relativePath}`
}

export function kokoroRemoteAssetPath(input: string | URL | Request): string | null {
  const href = input instanceof Request ? input.url : input.toString()
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }

  const prefixUrl = new URL(KOKORO_HF_RESOLVE_PREFIX)
  if (url.origin !== prefixUrl.origin || !url.pathname.startsWith(prefixUrl.pathname)) return null
  return decodeURIComponent(url.pathname.slice(prefixUrl.pathname.length))
}

export function isSelfHostedKokoroAsset(relativePath: string): boolean {
  return hostedModelPaths.has(relativePath) || hostedVoicePaths.has(relativePath)
}

export async function verifyKokoro(relativePath: string, response: Response): Promise<Response> {
  return (await loadKokoroIntegrity()).verifyKokoro(relativePath, response)
}

export async function piper(): Promise<string> {
  return (await loadKokoroIntegrity()).piper()
}

export function kokoroLocalAssetUrl(relativePath: string, baseUrl = import.meta.env.BASE_URL): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const pathname = `${normalizedBase}${KOKORO_LOCAL_MODEL_PREFIX}${relativePath}`
  const base = typeof location === 'undefined' ? 'https://sysadmindoc.github.io' : location.origin
  return new URL(pathname, base).toString()
}

export function rateLimitRetryDelayMs(headers: Headers, attempt: number, now = Date.now()): number {
  const parsed =
    parseRetryAfter(headers.get('retry-after'), now)
    ?? parseRetryAfter(headers.get('ratelimit-reset'), now)
    ?? parseRetryAfter(headers.get('x-ratelimit-reset'), now)
    ?? parseRateLimitWindow(headers.get('ratelimit'))
    ?? defaultRetryDelays[Math.min(attempt, defaultRetryDelays.length - 1)]
  return Math.max(250, Math.min(parsed, maxRetryDelayMs))
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    if (numeric > 1_000_000_000) return Math.max(0, numeric * 1000 - now)
    return Math.max(0, numeric * 1000)
  }
  const dateMs = Date.parse(value)
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - now)
}

function parseRateLimitWindow(value: string | null): number | null {
  const match = value?.match(/(?:^|[;,])\s*t=(\d+)/i)
  return match ? Number(match[1]) * 1000 : null
}

export async function installKokoro(): Promise<void> {
  return (await import('./kokoro-fetch.ts')).installKokoro()
}
