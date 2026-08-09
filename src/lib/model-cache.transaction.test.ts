import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./kokoro-assets.ts', () => ({
  SELF_HOSTED_KOKORO_MODEL_PATHS: ['config.json'],
  isSelfHostedKokoroAsset: () => false,
  kokoroLocalAssetUrl: (path: string) => `https://test.local/${path}`,
  kokoroRemoteAssetUrl: (path: string) => `https://test.remote/${path}`,
  verifyKokoro: async (_path: string, response: Response) => response,
}))

class FakeCache {
  readonly entries = new Map<string, Response>()
  readonly name: string
  private readonly shouldFailPut: () => boolean

  constructor(name: string, shouldFailPut: () => boolean) {
    this.name = name
    this.shouldFailPut = shouldFailPut
  }

  async match(request: RequestInfo): Promise<Response | undefined> {
    return this.entries.get(cacheKey(request))?.clone()
  }

  async put(request: RequestInfo, response: Response): Promise<void> {
    if (this.name === 'transformers-cache' && cacheKey(request).includes('config.json') && this.shouldFailPut()) {
      throw new Error('simulated final cache interruption')
    }
    this.entries.set(cacheKey(request), response.clone())
  }

  async delete(request: RequestInfo): Promise<boolean> {
    return this.entries.delete(cacheKey(request))
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url))
  }
}

function cacheKey(request: RequestInfo): string {
  return request instanceof Request ? request.url : String(request)
}

describe('transactional model-cache packs', () => {
  let cacheStore: Map<string, FakeCache>
  let fetchCalls: string[]
  let failFinalPut: boolean
  let storageEstimate: { usage: number; quota: number }

  beforeEach(() => {
    cacheStore = new Map()
    fetchCalls = []
    failFinalPut = false
    storageEstimate = { usage: 100, quota: 1_000_000 }
    vi.stubGlobal('caches', {
      keys: async () => [...cacheStore.keys()],
      open: async (name: string) => {
        let cache = cacheStore.get(name)
        if (!cache) {
          cache = new FakeCache(name, () => failFinalPut)
          cacheStore.set(name, cache)
        }
        return cache
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
      const url = String(input)
      fetchCalls.push(url)
      return new Response(`asset:${url}`, { headers: { 'content-type': 'application/octet-stream' } })
    }))
    vi.stubGlobal('navigator', {
      storage: {
        estimate: async () => storageEstimate,
        persisted: async () => false,
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resumes a failed final write from verified staging without downloading again', async () => {
    const modelCache = await import('./model-cache.ts')
    failFinalPut = true

    await expect(modelCache.prefetchKokoroQ8Pack('af_heart')).rejects.toThrow('simulated final cache interruption')
    expect(fetchCalls).toHaveLength(2)
    await expect(modelCache.readKokoroQ8PackManifest('af_heart')).resolves.toMatchObject({
      state: 'staging',
      assets: [{ path: 'config.json' }, { path: 'voices/af_heart.bin' }],
    })

    failFinalPut = false
    await expect(modelCache.prefetchKokoroQ8Pack('af_heart')).resolves.toBe(2)
    expect(fetchCalls).toHaveLength(2)
    await expect(modelCache.readKokoroQ8PackManifest('af_heart')).resolves.toMatchObject({
      schemaVersion: 1,
      state: 'committed',
      assets: [
        { path: 'config.json', sizeBytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        { path: 'voices/af_heart.bin', cacheNames: ['transformers-cache', 'kokoro-voices'] },
      ],
      commitMarker: expect.any(String),
    })

    const summary = await modelCache.readModelCacheStatus()
    expect(summary.packs).toEqual([expect.objectContaining({ state: 'committed', assetCount: 2, repairable: false })])
  })

  it('reports persistence and refuses a pack that crosses the quota safety limit', async () => {
    const modelCache = await import('./model-cache.ts')
    storageEstimate = { usage: 950, quota: 1_000 }

    await expect(modelCache.prefetchKokoroQ8Pack('af_heart')).rejects.toThrow('Not enough persistent storage')
    await expect(modelCache.readModelCacheStorageStatus()).resolves.toMatchObject({
      supported: true,
      persisted: false,
      usageBytes: 950,
      quotaBytes: 1_000,
      availableBytes: 50,
      pressure: 'near-limit',
    })
    await expect(modelCache.readKokoroQ8PackManifest('af_heart')).resolves.toMatchObject({ state: 'staging', assets: [] })
  })
})
