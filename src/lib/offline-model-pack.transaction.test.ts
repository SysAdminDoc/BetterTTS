import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const REVISION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MODEL_SOURCE = `https://models.test/kokoro/tree/${REVISION}`

vi.mock('./capabilities.ts', () => {
  const engine = {
    id: 'kokoro',
    label: 'Test Kokoro',
    platforms: ['web'],
    runtime: ['browser'],
    modelId: 'test/kokoro',
  }
  const model = {
    id: 'test-kokoro',
    label: 'Test Kokoro',
    modelId: 'test/kokoro',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceUrl: 'https://models.test/kokoro/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    license: { spdx: 'Apache-2.0', tier: 'permissive' },
  }
  return {
    CAPABILITIES: { engines: [engine], models: [model] },
    capabilityEngine: (engineId: string) => engineId === engine.id ? engine : undefined,
  }
})

vi.mock('./model-cache.ts', () => ({ readKokoroQ8PackManifest: vi.fn() }))

import {
  PORTABLE_OFFLINE_PACK_FINAL_CACHE,
  PORTABLE_OFFLINE_PACK_MANIFEST_CACHE,
  buildPortableOfflineModelPackArchive,
  importPortableOfflineModelPack,
  readPortableOfflinePackStatuses,
  repairPortableOfflineModelPack,
  type PortablePackStorage,
} from './offline-model-pack.ts'

class FakeCache {
  readonly entries = new Map<string, Response>()

  async match(request: RequestInfo): Promise<Response | undefined> {
    return this.entries.get(cacheKey(request))?.clone()
  }

  async put(request: RequestInfo, response: Response): Promise<void> {
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

function makeStorage() {
  const cachesByName = new Map<string, FakeCache>()
  return {
    cachesByName,
    storage: {
      open: async (name: string) => {
        let cache = cachesByName.get(name)
        if (!cache) {
          cache = new FakeCache()
          cachesByName.set(name, cache)
        }
        return cache
      },
    } as unknown as PortablePackStorage,
  }
}

async function makeArchive(): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode('test voice')
  const sourceUrl = `https://models.test/kokoro/resolve/${REVISION}/voices/af_test.bin`
  const { sha256Hex } = await import('./offline-model-pack.ts')
  const manifest = {
    format: 'bettertts.offline-model-pack' as const,
    schemaVersion: 1 as const,
    packId: 'portable-kokoro-test',
    engineId: 'kokoro',
    modelId: 'test/kokoro',
    revision: REVISION,
    sourceUrl: MODEL_SOURCE,
    license: { spdx: 'Apache-2.0', tier: 'permissive' as const, acknowledgedAt: '2026-08-09T12:00:00.000Z' },
    createdAt: '2026-08-09T12:00:00.000Z',
    voiceId: 'af_test',
    assets: [{
      path: 'voices/af_test.bin',
      sizeBytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      sourceUrl,
      cacheTargets: [
        { cacheName: 'transformers-cache', url: sourceUrl },
        { cacheName: 'kokoro-voices', url: sourceUrl },
      ],
    }],
  }
  return buildPortableOfflineModelPackArchive(manifest, [{ path: 'voices/af_test.bin', bytes }])
}

describe('portable offline model pack transactions', () => {
  beforeEach(() => {
    vi.stubGlobal('Request', Request)
    vi.stubGlobal('Response', Response)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stages, verifies, promotes, and reports only verified cache bytes as ready', async () => {
    const { storage, cachesByName } = makeStorage()
    const status = await importPortableOfflineModelPack(await makeArchive(), { licenseConfirmed: true, storage })
    expect(status).toMatchObject({ packId: 'portable-kokoro-test', storageState: 'ready', ready: true, verifiedAssetCount: 1 })
    expect(cachesByName.get(PORTABLE_OFFLINE_PACK_FINAL_CACHE)?.entries.size).toBe(1)
    expect(await readPortableOfflinePackStatuses(storage)).toMatchObject([{ packId: 'portable-kokoro-test', ready: true, storageState: 'ready' }])

    const finalCache = cachesByName.get(PORTABLE_OFFLINE_PACK_FINAL_CACHE)
    const finalRequest = [...(await finalCache?.keys() ?? [])][0]
    if (!finalCache || !finalRequest) throw new Error('Final cache fixture did not commit an asset.')
    await finalCache.put(finalRequest, new Response('tampered'))
    expect(await readPortableOfflinePackStatuses(storage)).toMatchObject([{ packId: 'portable-kokoro-test', ready: false, storageState: 'staging', repairable: true }])
  })

  it('repairs from a verified staging transaction after a damaged final copy', async () => {
    const { storage, cachesByName } = makeStorage()
    await importPortableOfflineModelPack(await makeArchive(), { licenseConfirmed: true, storage })

    const manifestCache = cachesByName.get(PORTABLE_OFFLINE_PACK_MANIFEST_CACHE)
    const finalCache = cachesByName.get(PORTABLE_OFFLINE_PACK_FINAL_CACHE)
    if (!manifestCache || !finalCache) throw new Error('Portable pack fixture did not create caches.')
    const manifestRequest = (await manifestCache.keys())[0]
    const stored = JSON.parse(await (await manifestCache.match(manifestRequest))!.text()) as Record<string, unknown>
    stored.storageState = 'staging'
    await manifestCache.put(manifestRequest, new Response(JSON.stringify(stored)))
    const stagingCache = await storage.open('bettertts-offline-pack-staging-v1')
    for (const request of await finalCache.keys()) {
      const response = await finalCache.match(request)
      if (response) await stagingCache.put(request.url.replace('/final/', '/staging/'), response)
    }
    await finalCache.delete((await finalCache.keys())[0])

    await expect(repairPortableOfflineModelPack('portable-kokoro-test', storage)).resolves.toMatchObject({ ready: true, storageState: 'ready' })
    await expect(readPortableOfflinePackStatuses(storage)).resolves.toMatchObject([{ ready: true, storageState: 'ready' }])
  })

  it('rebuilds a damaged engine target from a still-verified final copy', async () => {
    const { storage, cachesByName } = makeStorage()
    await importPortableOfflineModelPack(await makeArchive(), { licenseConfirmed: true, storage })
    const targetCache = cachesByName.get('transformers-cache')
    if (!targetCache) throw new Error('Portable pack fixture did not create the engine target cache.')
    await targetCache.put((await targetCache.keys())[0], new Response('tampered'))

    await expect(readPortableOfflinePackStatuses(storage)).resolves.toMatchObject([{ ready: false, repairable: true }])
    await expect(repairPortableOfflineModelPack('portable-kokoro-test', storage)).resolves.toMatchObject({ ready: true, storageState: 'ready' })
  })
})
