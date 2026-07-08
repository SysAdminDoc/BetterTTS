import { VOICES } from './voices.ts'

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
export const KOKORO_SAMPLE_RATE = 24000
export const KOKORO_MODEL_REVISION = 'main'
export const KOKORO_HF_RESOLVE_PREFIX =
  `https://huggingface.co/${KOKORO_MODEL_ID}/resolve/${KOKORO_MODEL_REVISION}/`
export const KOKORO_LOCAL_MODEL_PREFIX = `models/${KOKORO_MODEL_ID}/`

const hostedModelPaths = new Set([
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
])
const hostedVoicePaths = new Set(VOICES.map((voice) => `voices/${voice.id}.bin`))
const maxHfRetries = 2
const defaultRetryDelays = [1_000, 2_500]
const maxRetryDelayMs = 60_000
const stateKey = Symbol.for('bettertts.kokoroAssets.fetch')

type FetchState = {
  installed: boolean
}

type KokoroAssetGlobal = typeof globalThis & {
  [stateKey]?: FetchState
}

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

export function installKokoroAssetFallback(): void {
  if (typeof fetch !== 'function') return

  const target = globalThis as KokoroAssetGlobal
  if (target[stateKey]?.installed) return

  const originalFetch = fetch.bind(globalThis)
  target[stateKey] = { installed: true }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const relativePath = kokoroRemoteAssetPath(input)
    if (!relativePath) return originalFetch(input, init)

    if (isFetchableAssetRequest(input, init) && isSelfHostedKokoroAsset(relativePath)) {
      try {
        const localResponse = await originalFetch(kokoroLocalAssetUrl(relativePath), localFetchInit(input, init))
        if (localResponse.ok) return localResponse
      } catch {
        /* fall through to Hugging Face */
      }
    }

    return fetchHfWithRetry(originalFetch, input, init)
  }) as typeof fetch
}

function isFetchableAssetRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  return method === 'GET' || method === 'HEAD'
}

function localFetchInit(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  if (!(input instanceof Request)) return init
  return {
    ...init,
    method: init?.method ?? input.method,
    signal: init?.signal ?? input.signal,
  }
}

async function fetchHfWithRetry(
  originalFetch: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let response = await originalFetch(input, init)
  for (let attempt = 0; attempt < maxHfRetries && response.status === 429; attempt += 1) {
    await wait(rateLimitRetryDelayMs(response.headers, attempt))
    response = await originalFetch(input, init)
  }
  return response
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
