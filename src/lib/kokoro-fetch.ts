import {
  isSelfHostedKokoroAsset,
  kokoroLocalAssetUrl,
  kokoroRemoteAssetPath,
  rateLimitRetryDelayMs,
  verifyKokoro,
} from './kokoro-assets.ts'

const maxHfRetries = 2
const stateKey = Symbol.for('bettertts.kokoroAssets.fetch')

type FetchState = {
  installed: boolean
}

type KokoroAssetGlobal = typeof globalThis & {
  [stateKey]?: FetchState
}

export async function installKokoro(): Promise<void> {
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
        if (localResponse.ok && !isHtmlFallback(localResponse)) {
          if (isGetAssetRequest(input, init)) await verifyKokoro(relativePath, localResponse)
          return localResponse
        }
      } catch {
        /* fall through to Hugging Face */
      }
    }

    const response = await fetchHfWithRetry(originalFetch, input, init)
    if (isGetAssetRequest(input, init) && response.ok && !isHtmlFallback(response)) {
      await verifyKokoro(relativePath, response)
    }
    return response
  }) as typeof fetch
}

function isHtmlFallback(response: Response): boolean {
  return response.headers.get('content-type')?.toLowerCase().includes('text/html') ?? false
}

function isFetchableAssetRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  return method === 'GET' || method === 'HEAD'
}

function isGetAssetRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  return method === 'GET'
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
