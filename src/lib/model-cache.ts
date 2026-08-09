import {
  SELF_HOSTED_KOKORO_MODEL_PATHS,
  isSelfHostedKokoroAsset,
  kokoroLocalAssetUrl,
  kokoroRemoteAssetUrl,
  verifyKokoro,
} from './kokoro-assets.ts'
import type {
  ModelCacheEngineId,
  ModelCacheEntry,
  ModelCacheStorageStatus,
  ModelCacheSummary,
  ModelPackAssetRecord,
  ModelPackManifest,
  ModelPackStatus,
} from './model-cache-types.ts'

export type {
  EngineCacheStatus,
  ModelCacheEngineId,
  ModelCacheEntry,
  ModelCacheStorageStatus,
  ModelCacheSummary,
  ModelPackAssetRecord,
  ModelPackManifest,
  ModelPackStatus,
} from './model-cache-types.ts'

export const MODEL_CACHE_MANIFEST_SCHEMA_VERSION = 1
export const MODEL_CACHE_PACK_STALE_AFTER_MS = 30 * 60 * 1_000

const TRANSFORMERS_CACHE = 'transformers-cache'
const KOKORO_VOICE_CACHE = 'kokoro-voices'
const MODEL_PACK_MANIFEST_CACHE = 'bettertts-model-pack-manifests-v1'
const MODEL_PACK_STAGING_CACHE = 'bettertts-model-pack-staging-v1'
const MODEL_PACK_COMMIT_CACHE = 'bettertts-model-pack-commits-v1'
const MODEL_PACK_MANIFEST_PREFIX = 'https://bettertts.invalid/model-packs/v1/manifests/'
const MODEL_PACK_STAGING_PREFIX = 'https://bettertts.invalid/model-packs/v1/staging/'
const MODEL_PACK_COMMIT_PREFIX = 'https://bettertts.invalid/model-packs/v1/commits/'
const MODEL_CACHE_QUOTA_HEADROOM = 0.9

const ENGINE_LABELS: Record<ModelCacheEngineId, string> = {
  kokoro: 'Kokoro q8',
  supertonic: 'Supertonic',
  kitten: 'KittenTTS',
  chatterbox: 'Chatterbox',
  shell: 'App shell',
}

const ENGINE_ORDER: ModelCacheEngineId[] = ['kokoro', 'supertonic', 'kitten', 'chatterbox', 'shell']
const modelPackLocks = new Map<string, Promise<void>>()

export function classifyModelCacheEntry(cacheName: string, url: string): ModelCacheEngineId | 'other' {
  const normalizedCache = cacheName.toLowerCase()
  const normalizedUrl = url.toLowerCase()

  if (normalizedCache.startsWith('bettertts-shell-')) return 'shell'
  if (normalizedCache === KOKORO_VOICE_CACHE || normalizedUrl.includes('kokoro-82m') || normalizedUrl.includes('/models/onnx-community/kokoro')) return 'kokoro'
  if (normalizedUrl.includes('supertonic-tts')) return 'supertonic'
  if (normalizedUrl.includes('kittentts') || normalizedUrl.includes('kitten-tts') || normalizedUrl.includes('kittenml')) return 'kitten'
  if (normalizedUrl.includes('chatterbox')) return 'chatterbox'
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
    storage: { supported: false },
    packs: [],
  }
}

export async function readModelCacheStorageStatus(): Promise<ModelCacheStorageStatus> {
  if (typeof navigator === 'undefined' || !navigator.storage) return { supported: false }

  try {
    const [estimate, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted?.() ?? Promise.resolve(undefined),
    ])
    const usageBytes = estimate.usage
    const quotaBytes = estimate.quota
    const availableBytes = usageBytes != null && quotaBytes != null ? Math.max(0, quotaBytes - usageBytes) : undefined
    const pressure = usageBytes != null && quotaBytes != null && quotaBytes > 0
      ? usageBytes / quotaBytes >= MODEL_CACHE_QUOTA_HEADROOM ? 'near-limit' : 'ok'
      : 'unknown'
    return { supported: true, persisted, usageBytes, quotaBytes, availableBytes, pressure }
  } catch (error) {
    return {
      supported: true,
      error: error instanceof Error ? error.message : 'Could not inspect browser storage.',
    }
  }
}

export async function readModelCacheStatus(): Promise<ModelCacheSummary> {
  if (typeof caches === 'undefined') return summarizeModelCacheEntries([], false)

  // A stale staging transaction must not keep large model responses alive
  // indefinitely. A live staging manifest remains available for repair.
  await cleanupStaleModelPackBuilds()

  const entries: ModelCacheEntry[] = []
  const cacheNames = await caches.keys()
  for (const cacheName of cacheNames) {
    if (isModelPackCache(cacheName)) continue
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

  const summary = summarizeModelCacheEntries(entries)
  summary.storage = await readModelCacheStorageStatus()
  summary.packs = await readModelPackStatuses()
  return summary
}

export async function clearModelCache(engineId: ModelCacheEngineId): Promise<number> {
  if (typeof caches === 'undefined') return 0

  let deleted = 0
  const cacheNames = await caches.keys()
  for (const cacheName of cacheNames) {
    if (isModelPackCache(cacheName)) continue
    const cache = await caches.open(cacheName)
    const requests = await cache.keys()
    for (const request of requests) {
      if (classifyModelCacheEntry(cacheName, request.url) === engineId && await cache.delete(request)) deleted += 1
    }
  }

  if (engineId === 'kokoro') await clearKokoroPackTransactions()
  return deleted
}

export async function prefetchKokoroQ8Pack(
  voiceId: string,
  onProgress: (done: number, total: number, path: string) => void = () => {},
): Promise<number> {
  if (typeof caches === 'undefined') throw new Error('This browser does not expose the Cache API.')

  const paths = kokoroQ8PrefetchPaths(voiceId)
  const packId = kokoroPackId(voiceId)
  return withModelPackLock(packId, async () => {
    await cleanupStaleModelPackBuilds()

    const transformersCache = await caches.open(TRANSFORMERS_CACHE)
    const voiceCache = await caches.open(KOKORO_VOICE_CACHE)
    const stagingCache = await caches.open(MODEL_PACK_STAGING_CACHE)
    const manifestCache = await caches.open(MODEL_PACK_MANIFEST_CACHE)
    const commitCache = await caches.open(MODEL_PACK_COMMIT_CACHE)
    const manifestRequest = modelPackManifestRequest(packId)
    let manifest = await readModelPackManifest(manifestCache, manifestRequest)
    const commitMarker = await readCommitMarker(commitCache, packId)

    if (!isManifestForPaths(manifest, packId, voiceId, paths)) {
      manifest = null
    }

    if (manifest?.state === 'committed' && commitMarker?.token === manifest.commitMarker) {
      if (isCompleteManifest(manifest, paths) && await verifyFinalPack(manifest, transformersCache, voiceCache)) {
        await deleteStagingEntriesForPack(stagingCache, packId)
        reportCachedProgress(paths, onProgress)
        return paths.length
      }
      await resetPackTransaction(manifest, manifestCache, commitCache, transformersCache, voiceCache, stagingCache)
      manifest = null
    } else if (commitMarker && manifest?.state === 'staging' && isCompleteManifest(manifest, paths) && await verifyFinalPack(manifest, transformersCache, voiceCache)) {
      // The commit marker is written before the committed manifest. If a tab
      // died in that small window, promote the verified final set on retry.
      const promoted: ModelPackManifest = {
        ...manifest,
        state: 'committed',
        commitMarker: commitMarker.token,
        updatedAt: Date.now(),
      }
      await writeModelPackManifest(manifestCache, manifestRequest, promoted)
      await deleteStagingEntriesForPack(stagingCache, packId)
      reportCachedProgress(paths, onProgress)
      return paths.length
    } else if (commitMarker) {
      await commitCache.delete(modelPackCommitRequest(packId))
    }

    if (!manifest) {
      manifest = createModelPackManifest(packId, voiceId, await inspectExistingFinalAssets(paths, transformersCache, voiceCache))
      await writeModelPackManifest(manifestCache, manifestRequest, manifest)
    } else if (manifest.state === 'committed') {
      manifest = {
        ...manifest,
        state: 'staging',
        updatedAt: Date.now(),
        assets: [],
        commitMarker: undefined,
      }
      await writeModelPackManifest(manifestCache, manifestRequest, manifest)
      await removeFinalAssets(paths, transformersCache, voiceCache)
    }

    let cached = 0
    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index]
      onProgress(index, paths.length, path)
      let record = manifest.assets.find((asset) => asset.path === path) ?? null

      if (record && !(await verifyFinalAsset(record, transformersCache, voiceCache))) {
        const stagedRecord = await inspectStagedAsset(packId, path, record, stagingCache)
        if (stagedRecord) {
          record = stagedRecord
          manifest = replaceManifestAsset(manifest, record)
        } else {
          await removeFinalAsset(path, transformersCache, voiceCache)
          await stagingCache.delete(modelPackStagingRequest(packId, path))
          manifest = removeManifestAsset(manifest, path)
          record = null
        }
      }

      if (!record) {
        const existing = await inspectFinalAsset(path, transformersCache, voiceCache)
        if (existing) {
          record = existing
          manifest = replaceManifestAsset(manifest, record)
        }
      }

      if (!record) {
        const staged = await inspectStagedAsset(packId, path, null, stagingCache)
        if (staged) {
          record = staged
          manifest = replaceManifestAsset(manifest, record)
        }
      }

      if (!record) {
        await removeFinalAsset(path, transformersCache, voiceCache)
        const response = await fetchKokoroPrefetchAsset(path)
        record = await inspectAssetResponse(path, response)
        await ensureModelCacheCapacity(record.sizeBytes * (record.cacheNames.length + 1))
        await stagingCache.put(modelPackStagingRequest(packId, path), response)
        manifest = replaceManifestAsset(manifest, record)
      }

      cached += 1
      manifest = { ...manifest, updatedAt: Date.now() }
      await writeModelPackManifest(manifestCache, manifestRequest, manifest)
      onProgress(cached, paths.length, path)
    }

    // Final cache writes are performed only after every response has a
    // verified staging record. A failure leaves the staging manifest and
    // responses in place so a later retry can repair the pack without a
    // second download.
    for (const path of paths) {
      const record = manifest.assets.find((asset) => asset.path === path)
      if (!record) throw new Error(`Kokoro pack transaction lost ${path}.`)
      if (await verifyFinalAsset(record, transformersCache, voiceCache)) continue

      const staged = await stagingCache.match(modelPackStagingRequest(packId, path))
      if (!staged) throw new Error(`Kokoro pack staging is missing ${path}.`)
      await ensureModelCacheCapacity(record.sizeBytes * record.cacheNames.length)
      if (record.cacheNames.includes(TRANSFORMERS_CACHE)) await transformersCache.put(record.url, staged.clone())
      if (record.cacheNames.includes(KOKORO_VOICE_CACHE)) await voiceCache.put(record.url, staged.clone())
      if (!(await verifyFinalAsset(record, transformersCache, voiceCache))) {
        throw new Error(`Kokoro pack commit verification failed for ${path}.`)
      }
    }

    const token = `${Date.now()}:${paths.length}`
    await commitCache.put(
      modelPackCommitRequest(packId),
      new Response(JSON.stringify({
        schemaVersion: MODEL_CACHE_MANIFEST_SCHEMA_VERSION,
        packId,
        committedAt: Date.now(),
        token,
      }), { headers: { 'content-type': 'application/json' } }),
    )
    const committed: ModelPackManifest = {
      ...manifest,
      state: 'committed',
      updatedAt: Date.now(),
      commitMarker: token,
    }
    await writeModelPackManifest(manifestCache, manifestRequest, committed)
    await deleteStagingEntriesForPack(stagingCache, packId)
    return cached
  })
}

export function kokoroQ8PrefetchPaths(voiceId: string): string[] {
  return [...SELF_HOSTED_KOKORO_MODEL_PATHS, `voices/${voiceId}.bin`]
}

export async function readKokoroQ8PackManifest(voiceId: string): Promise<ModelPackManifest | null> {
  if (typeof caches === 'undefined') return null
  const cache = await caches.open(MODEL_PACK_MANIFEST_CACHE)
  return readModelPackManifest(cache, modelPackManifestRequest(kokoroPackId(voiceId)))
}

export async function readModelPackStatuses(): Promise<ModelPackStatus[]> {
  if (typeof caches === 'undefined') return []
  const manifestCache = await caches.open(MODEL_PACK_MANIFEST_CACHE)
  const commitCache = await caches.open(MODEL_PACK_COMMIT_CACHE)
  const statuses: ModelPackStatus[] = []
  for (const entry of await readRawManifests(manifestCache)) {
    const marker = await readCommitMarker(commitCache, entry.manifest.packId)
    statuses.push({
      packId: entry.manifest.packId,
      voiceId: entry.manifest.voiceId,
      state: entry.manifest.state,
      assetCount: entry.manifest.assets.length,
      verifiedAssetCount: entry.manifest.assets.filter(isVerifiedAssetRecord).length,
      updatedAt: entry.manifest.updatedAt,
      repairable: entry.manifest.state === 'staging' || marker?.token !== entry.manifest.commitMarker,
    })
  }
  return statuses
}

export async function cleanupStaleModelPackBuilds(now = Date.now()): Promise<number> {
  if (typeof caches === 'undefined') return 0

  const manifestCache = await caches.open(MODEL_PACK_MANIFEST_CACHE)
  const stagingCache = await caches.open(MODEL_PACK_STAGING_CACHE)
  const commitCache = await caches.open(MODEL_PACK_COMMIT_CACHE)
  const raw = await readRawManifests(manifestCache)
  const livePackIds = new Set<string>()
  let cleaned = 0

  for (const entry of raw) {
    const { manifest, request } = entry
    livePackIds.add(manifest.packId)
    if (manifest.state === 'committed') {
      // Staging is no longer needed after the commit marker is durable.
      await deleteStagingEntriesForPack(stagingCache, manifest.packId)
      continue
    }
    if (!Number.isFinite(manifest.updatedAt) || now - manifest.updatedAt <= MODEL_CACHE_PACK_STALE_AFTER_MS) continue

    await removeFinalAssetsForManifest(
      manifest,
      await caches.open(TRANSFORMERS_CACHE),
      await caches.open(KOKORO_VOICE_CACHE),
    )
    await deleteStagingEntriesForPack(stagingCache, manifest.packId)
    await commitCache.delete(modelPackCommitRequest(manifest.packId))
    await manifestCache.delete(request)
    cleaned += 1
  }

  // A crash before the manifest write can leave an orphaned staging response.
  // Its encoded pack id is part of the key, so it can be removed safely.
  for (const request of await stagingCache.keys()) {
    const packId = packIdFromStagingUrl(request.url)
    if (packId && !livePackIds.has(packId)) {
      await stagingCache.delete(request)
      cleaned += 1
    }
  }
  for (const request of await commitCache.keys()) {
    const packId = packIdFromCommitUrl(request.url)
    if (packId && !livePackIds.has(packId)) {
      await commitCache.delete(request)
      cleaned += 1
    }
  }
  return cleaned
}

async function fetchKokoroPrefetchAsset(path: string): Promise<Response> {
  const candidates = isSelfHostedKokoroAsset(path)
    ? [kokoroLocalAssetUrl(path), kokoroRemoteAssetUrl(path)]
    : [kokoroRemoteAssetUrl(path)]

  for (const url of candidates) {
    try {
      const response = await fetch(url, { cache: 'reload' })
      if (response.ok && !response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
        return await verifyKokoro(path, response)
      }
    } catch {
      /* try the next source */
    }
  }

  throw new Error(`Could not prefetch ${path}`)
}

async function inspectAssetResponse(path: string, response: Response): Promise<ModelPackAssetRecord> {
  await verifyKokoro(path, response)
  const bytes = new Uint8Array(await response.clone().arrayBuffer())
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Model pack verification requires crypto.subtle.')
  const digest = await subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return {
    path,
    url: kokoroRemoteAssetUrl(path),
    cacheNames: cacheNamesForPath(path),
    sizeBytes: bytes.byteLength,
    sha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join(''),
  }
}

async function inspectFinalAsset(path: string, transformersCache: Cache, voiceCache: Cache): Promise<ModelPackAssetRecord | null> {
  const record = await inspectCacheAsset(path, transformersCache, kokoroRemoteAssetUrl(path))
  if (!record) return null
  if (path.startsWith('voices/')) {
    const voiceRecord = await inspectCacheAsset(path, voiceCache, kokoroRemoteAssetUrl(path))
    if (!voiceRecord || !sameAssetRecord(record, voiceRecord)) return null
  }
  return record
}

async function inspectStagedAsset(packId: string, path: string, expected: ModelPackAssetRecord | null, stagingCache: Cache): Promise<ModelPackAssetRecord | null> {
  const response = await stagingCache.match(modelPackStagingRequest(packId, path))
  if (!response) return null
  try {
    const record = await inspectAssetResponse(path, response)
    return expected && !sameAssetRecord(expected, record) ? null : record
  } catch {
    return null
  }
}

async function inspectCacheAsset(path: string, cache: Cache, url: string): Promise<ModelPackAssetRecord | null> {
  const response = await cache.match(url)
  if (!response) return null
  try {
    return await inspectAssetResponse(path, response)
  } catch {
    return null
  }
}

async function verifyFinalAsset(record: ModelPackAssetRecord, transformersCache: Cache, voiceCache: Cache): Promise<boolean> {
  const current = await inspectFinalAsset(record.path, transformersCache, voiceCache)
  return current !== null && sameAssetRecord(record, current)
}

async function verifyFinalPack(manifest: ModelPackManifest, transformersCache: Cache, voiceCache: Cache): Promise<boolean> {
  if (manifest.assets.length === 0) return false
  return manifest.assets.every((record) => verifyFinalAsset(record, transformersCache, voiceCache))
}

async function inspectExistingFinalAssets(paths: string[], transformersCache: Cache, voiceCache: Cache): Promise<ModelPackAssetRecord[]> {
  const records: ModelPackAssetRecord[] = []
  for (const path of paths) {
    const record = await inspectFinalAsset(path, transformersCache, voiceCache)
    if (record) records.push(record)
  }
  return records
}

function createModelPackManifest(packId: string, voiceId: string, assets: ModelPackAssetRecord[]): ModelPackManifest {
  const now = Date.now()
  return {
    schemaVersion: MODEL_CACHE_MANIFEST_SCHEMA_VERSION,
    packId,
    voiceId,
    state: 'staging',
    createdAt: now,
    updatedAt: now,
    assets,
  }
}

function replaceManifestAsset(manifest: ModelPackManifest, asset: ModelPackAssetRecord): ModelPackManifest {
  return {
    ...manifest,
    assets: [...manifest.assets.filter((candidate) => candidate.path !== asset.path), asset],
  }
}

function removeManifestAsset(manifest: ModelPackManifest, path: string): ModelPackManifest {
  return { ...manifest, assets: manifest.assets.filter((asset) => asset.path !== path) }
}

function isManifestForPaths(manifest: ModelPackManifest | null, packId: string, voiceId: string, paths: string[]): manifest is ModelPackManifest {
  if (!manifest || manifest.schemaVersion !== MODEL_CACHE_MANIFEST_SCHEMA_VERSION || manifest.packId !== packId || manifest.voiceId !== voiceId) return false
  const expectedPaths = new Set(paths)
  return manifest.assets.every((asset) => expectedPaths.has(asset.path))
}

function isCompleteManifest(manifest: ModelPackManifest, paths: string[]): boolean {
  if (manifest.assets.length !== paths.length) return false
  const assetPaths = new Set(manifest.assets.map((asset) => asset.path))
  return paths.every((path) => assetPaths.has(path))
}

function isVerifiedAssetRecord(asset: ModelPackAssetRecord): boolean {
  return asset.sizeBytes >= 0 && /^[a-f0-9]{64}$/u.test(asset.sha256) && asset.url.length > 0 && asset.cacheNames.length > 0
}

function sameAssetRecord(left: ModelPackAssetRecord, right: ModelPackAssetRecord): boolean {
  return left.path === right.path
    && left.url === right.url
    && left.sizeBytes === right.sizeBytes
    && left.sha256 === right.sha256
}

function cacheNamesForPath(path: string): string[] {
  return path.startsWith('voices/') ? [TRANSFORMERS_CACHE, KOKORO_VOICE_CACHE] : [TRANSFORMERS_CACHE]
}

function kokoroPackId(voiceId: string): string {
  return `kokoro-q8:${voiceId}`
}

function modelPackManifestRequest(packId: string): Request {
  return new Request(`${MODEL_PACK_MANIFEST_PREFIX}${encodeURIComponent(packId)}`)
}

function modelPackStagingRequest(packId: string, path: string): Request {
  return new Request(`${MODEL_PACK_STAGING_PREFIX}${encodeURIComponent(packId)}/${encodeURIComponent(path)}`)
}

function modelPackCommitRequest(packId: string): Request {
  return new Request(`${MODEL_PACK_COMMIT_PREFIX}${encodeURIComponent(packId)}`)
}

function isModelPackCache(cacheName: string): boolean {
  return cacheName === MODEL_PACK_MANIFEST_CACHE || cacheName === MODEL_PACK_STAGING_CACHE || cacheName === MODEL_PACK_COMMIT_CACHE
}

async function readModelPackManifest(cache: Cache, request: Request): Promise<ModelPackManifest | null> {
  const response = await cache.match(request)
  if (!response) return null
  try {
    return parseModelPackManifest(JSON.parse(await response.text()))
  } catch {
    return null
  }
}

async function writeModelPackManifest(cache: Cache, request: Request, manifest: ModelPackManifest): Promise<void> {
  await cache.put(request, new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } }))
}

async function readCommitMarker(cache: Cache, packId: string): Promise<{ token: string } | null> {
  const response = await cache.match(modelPackCommitRequest(packId))
  if (!response) return null
  try {
    const value: unknown = JSON.parse(await response.text())
    if (!value || typeof value !== 'object') return null
    const record = value as { schemaVersion?: unknown; packId?: unknown; token?: unknown }
    return record.schemaVersion === MODEL_CACHE_MANIFEST_SCHEMA_VERSION && record.packId === packId && typeof record.token === 'string'
      ? { token: record.token }
      : null
  } catch {
    return null
  }
}

function parseModelPackManifest(value: unknown): ModelPackManifest | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<ModelPackManifest>
  if (record.schemaVersion !== MODEL_CACHE_MANIFEST_SCHEMA_VERSION
    || typeof record.packId !== 'string'
    || typeof record.voiceId !== 'string'
    || (record.state !== 'staging' && record.state !== 'committed')
    || typeof record.createdAt !== 'number'
    || typeof record.updatedAt !== 'number'
    || !Array.isArray(record.assets)) return null

  const assets = record.assets.filter((asset): asset is ModelPackAssetRecord => {
    if (!asset || typeof asset !== 'object') return false
    const candidate = asset as Partial<ModelPackAssetRecord>
    return typeof candidate.path === 'string'
      && typeof candidate.url === 'string'
      && Array.isArray(candidate.cacheNames)
      && candidate.cacheNames.every((name) => typeof name === 'string')
      && typeof candidate.sizeBytes === 'number'
      && typeof candidate.sha256 === 'string'
  })
  return {
    schemaVersion: MODEL_CACHE_MANIFEST_SCHEMA_VERSION,
    packId: record.packId,
    voiceId: record.voiceId,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    assets,
    ...(typeof record.commitMarker === 'string' ? { commitMarker: record.commitMarker } : {}),
  }
}

async function readRawManifests(cache: Cache): Promise<Array<{ manifest: ModelPackManifest; request: Request }>> {
  const results: Array<{ manifest: ModelPackManifest; request: Request }> = []
  for (const request of await cache.keys()) {
    if (!request.url.startsWith(MODEL_PACK_MANIFEST_PREFIX)) continue
    const manifest = await readModelPackManifest(cache, request)
    if (manifest) results.push({ manifest, request })
  }
  return results
}

async function resetPackTransaction(
  manifest: ModelPackManifest,
  manifestCache: Cache,
  commitCache: Cache,
  transformersCache: Cache,
  voiceCache: Cache,
  stagingCache: Cache,
): Promise<void> {
  await removeFinalAssets(manifest.assets.map((asset) => asset.path), transformersCache, voiceCache)
  await deleteStagingEntriesForPack(stagingCache, manifest.packId)
  await commitCache.delete(modelPackCommitRequest(manifest.packId))
  await manifestCache.delete(modelPackManifestRequest(manifest.packId))
}

async function removeFinalAssets(paths: string[], transformersCache: Cache, voiceCache: Cache): Promise<void> {
  for (const path of paths) await removeFinalAsset(path, transformersCache, voiceCache)
}

async function removeFinalAsset(path: string, transformersCache: Cache, voiceCache: Cache): Promise<void> {
  const url = kokoroRemoteAssetUrl(path)
  await transformersCache.delete(url)
  if (path.startsWith('voices/')) await voiceCache.delete(url)
}

async function removeFinalAssetsForManifest(manifest: ModelPackManifest, transformersCache: Cache, voiceCache: Cache): Promise<void> {
  await removeFinalAssets(manifest.assets.map((asset) => asset.path), transformersCache, voiceCache)
}

async function deleteStagingEntriesForPack(cache: Cache, packId: string): Promise<void> {
  const prefix = `${MODEL_PACK_STAGING_PREFIX}${encodeURIComponent(packId)}/`
  for (const request of await cache.keys()) {
    if (request.url.startsWith(prefix)) await cache.delete(request)
  }
}

async function clearKokoroPackTransactions(): Promise<void> {
  const manifestCache = await caches.open(MODEL_PACK_MANIFEST_CACHE)
  const stagingCache = await caches.open(MODEL_PACK_STAGING_CACHE)
  const commitCache = await caches.open(MODEL_PACK_COMMIT_CACHE)
  for (const { manifest } of await readRawManifests(manifestCache)) {
    const transformersCache = await caches.open(TRANSFORMERS_CACHE)
    const voiceCache = await caches.open(KOKORO_VOICE_CACHE)
    await removeFinalAssetsForManifest(manifest, transformersCache, voiceCache)
    await deleteStagingEntriesForPack(stagingCache, manifest.packId)
    await manifestCache.delete(modelPackManifestRequest(manifest.packId))
    await commitCache.delete(modelPackCommitRequest(manifest.packId))
  }
}

function packIdFromStagingUrl(url: string): string | null {
  if (!url.startsWith(MODEL_PACK_STAGING_PREFIX)) return null
  const encoded = url.slice(MODEL_PACK_STAGING_PREFIX.length).split('/')[0]
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

function packIdFromCommitUrl(url: string): string | null {
  if (!url.startsWith(MODEL_PACK_COMMIT_PREFIX)) return null
  try {
    return decodeURIComponent(url.slice(MODEL_PACK_COMMIT_PREFIX.length))
  } catch {
    return null
  }
}

function reportCachedProgress(paths: string[], onProgress: (done: number, total: number, path: string) => void): void {
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index]
    onProgress(index, paths.length, path)
    onProgress(index + 1, paths.length, path)
  }
}

async function withModelPackLock<T>(packId: string, task: () => Promise<T>): Promise<T> {
  const previous = modelPackLocks.get(packId)
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  modelPackLocks.set(packId, current)
  if (previous) await previous

  try {
    const lockName = `bettertts-model-pack:${packId}`
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return await navigator.locks.request(lockName, { mode: 'exclusive' }, task)
    }
    return await task()
  } finally {
    release()
    if (modelPackLocks.get(packId) === current) modelPackLocks.delete(packId)
  }
}

async function ensureModelCacheCapacity(additionalBytes: number): Promise<void> {
  if (!Number.isFinite(additionalBytes) || additionalBytes <= 0) return
  const status = await readModelCacheStorageStatus()
  if (status.usageBytes == null || status.quotaBytes == null || status.quotaBytes <= 0) return
  if (status.usageBytes + additionalBytes > status.quotaBytes * MODEL_CACHE_QUOTA_HEADROOM) {
    throw new Error(`Not enough persistent storage for the Kokoro pack (${formatStorageBytes(additionalBytes)} needed; ${formatStorageBytes(Math.max(0, status.quotaBytes * MODEL_CACHE_QUOTA_HEADROOM - status.usageBytes))} available before the safety limit).`)
  }
}

function formatStorageBytes(bytes: number): string {
  if (bytes < 1_024) return `${Math.round(bytes)} B`
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KiB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`
}

function cachedResponseSize(response: Response | undefined): number | null {
  const value = response?.headers.get('content-length')
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
