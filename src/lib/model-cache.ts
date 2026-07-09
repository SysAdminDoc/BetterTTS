import {
  SELF_HOSTED_KOKORO_MODEL_PATHS,
  isSelfHostedKokoroAsset,
  kokoroLocalAssetUrl,
  kokoroRemoteAssetUrl,
} from './kokoro-assets.ts'

export type ModelCacheEngineId = 'kokoro' | 'supertonic' | 'kitten' | 'shell'

export type ModelCacheEntry = {
  cacheName: string
  url: string
  sizeBytes: number | null
}

export type EngineCacheStatus = {
  id: ModelCacheEngineId
  label: string
  entryCount: number
  sizeBytes: number
  unknownSizeCount: number
}

export type ModelCacheSummary = {
  supported: boolean
  engines: EngineCacheStatus[]
  totalBytes: number
  unknownSizeCount: number
}

const TRANSFORMERS_CACHE = 'transformers-cache'
const KOKORO_VOICE_CACHE = 'kokoro-voices'

const ENGINE_LABELS: Record<ModelCacheEngineId, string> = {
  kokoro: 'Kokoro q8',
  supertonic: 'Supertonic',
  kitten: 'KittenTTS',
  shell: 'App shell',
}

const ENGINE_ORDER: ModelCacheEngineId[] = ['kokoro', 'supertonic', 'kitten', 'shell']

export function classifyModelCacheEntry(cacheName: string, url: string): ModelCacheEngineId | 'other' {
  const normalizedCache = cacheName.toLowerCase()
  const normalizedUrl = url.toLowerCase()

  if (normalizedCache.startsWith('bettertts-shell-')) return 'shell'
  if (normalizedCache === KOKORO_VOICE_CACHE || normalizedUrl.includes('kokoro-82m') || normalizedUrl.includes('/models/onnx-community/kokoro')) return 'kokoro'
  if (normalizedUrl.includes('supertonic-tts')) return 'supertonic'
  if (normalizedUrl.includes('kittentts') || normalizedUrl.includes('kitten-tts') || normalizedUrl.includes('kittenml')) return 'kitten'
  return 'other'
}

export function summarizeModelCacheEntries(entries: ModelCacheEntry[], supported = true): ModelCacheSummary {
  const engines = ENGINE_ORDER.map((id) => {
    const matches = entries.filter((entry) => classifyModelCacheEntry(entry.cacheName, entry.url) === id)
    return {
      id,
      label: ENGINE_LABELS[id],
      entryCount: matches.length,
      sizeBytes: matches.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
      unknownSizeCount: matches.filter((entry) => entry.sizeBytes == null).length,
    }
  })
  return {
    supported,
    engines,
    totalBytes: engines.reduce((sum, engine) => sum + engine.sizeBytes, 0),
    unknownSizeCount: engines.reduce((sum, engine) => sum + engine.unknownSizeCount, 0),
  }
}

export async function readModelCacheStatus(): Promise<ModelCacheSummary> {
  if (typeof caches === 'undefined') return summarizeModelCacheEntries([], false)

  const entries: ModelCacheEntry[] = []
  const cacheNames = await caches.keys()
  for (const cacheName of cacheNames) {
    const cache = await caches.open(cacheName)
    const requests = await cache.keys()
    for (const request of requests) {
      const response = await cache.match(request)
      entries.push({
        cacheName,
        url: request.url,
        sizeBytes: cachedResponseSize(response),
      })
    }
  }

  return summarizeModelCacheEntries(entries)
}

export async function clearModelCache(engineId: ModelCacheEngineId): Promise<number> {
  if (typeof caches === 'undefined') return 0

  let deleted = 0
  const cacheNames = await caches.keys()
  for (const cacheName of cacheNames) {
    const cache = await caches.open(cacheName)
    const requests = await cache.keys()
    for (const request of requests) {
      if (classifyModelCacheEntry(cacheName, request.url) === engineId && await cache.delete(request)) deleted += 1
    }
  }
  return deleted
}

export async function prefetchKokoroQ8Pack(
  voiceId: string,
  onProgress: (done: number, total: number, path: string) => void = () => {},
): Promise<number> {
  if (typeof caches === 'undefined') throw new Error('This browser does not expose the Cache API.')

  const paths = kokoroQ8PrefetchPaths(voiceId)
  const transformersCache = await caches.open(TRANSFORMERS_CACHE)
  const voiceCache = await caches.open(KOKORO_VOICE_CACHE)
  let cached = 0

  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index]
    onProgress(index, paths.length, path)
    const remoteUrl = kokoroRemoteAssetUrl(path)
    const response = await fetchKokoroPrefetchAsset(path)

    await transformersCache.put(remoteUrl, response.clone())
    if (path.startsWith('voices/')) await voiceCache.put(remoteUrl, response.clone())
    cached += 1
    onProgress(cached, paths.length, path)
  }

  return cached
}

export function kokoroQ8PrefetchPaths(voiceId: string): string[] {
  return [...SELF_HOSTED_KOKORO_MODEL_PATHS, `voices/${voiceId}.bin`]
}

async function fetchKokoroPrefetchAsset(path: string): Promise<Response> {
  const candidates = isSelfHostedKokoroAsset(path)
    ? [kokoroLocalAssetUrl(path), kokoroRemoteAssetUrl(path)]
    : [kokoroRemoteAssetUrl(path)]

  for (const url of candidates) {
    try {
      const response = await fetch(url, { cache: 'reload' })
      if (response.ok && !response.headers.get('content-type')?.toLowerCase().includes('text/html')) return response
    } catch {
      /* try the next source */
    }
  }

  throw new Error(`Could not prefetch ${path}`)
}

function cachedResponseSize(response: Response | undefined): number | null {
  const value = response?.headers.get('content-length')
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
