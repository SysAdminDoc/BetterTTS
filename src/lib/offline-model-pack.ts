import { zipSync } from 'fflate'
import {
  assertArchivePayloadSizes,
  extractInspectedZipEntries,
  inspectZipArchive,
  type ArchiveBudget,
} from './archive-budget.ts'
import {
  CAPABILITIES,
  capabilityEngine,
  type CapabilityEngine,
  type CapabilityModel,
} from './capabilities.ts'
import { readKokoroQ8PackManifest } from './model-cache.ts'

export const PORTABLE_OFFLINE_PACK_SCHEMA_VERSION = 1 as const
export const PORTABLE_OFFLINE_PACK_FORMAT = 'bettertts.offline-model-pack' as const
export const PORTABLE_OFFLINE_PACK_MANIFEST_PATH = 'manifest.json' as const
export const PORTABLE_OFFLINE_PACK_MAX_ARCHIVE_BYTES = 180 * 1024 * 1024
export const PORTABLE_OFFLINE_PACK_MAX_ENTRY_BYTES = 160 * 1024 * 1024
export const PORTABLE_OFFLINE_PACK_MAX_TOTAL_BYTES = 180 * 1024 * 1024
export const PORTABLE_OFFLINE_PACK_MAX_ASSETS = 128

export const PORTABLE_OFFLINE_PACK_MANIFEST_CACHE = 'bettertts-offline-pack-manifests-v1'
export const PORTABLE_OFFLINE_PACK_STAGING_CACHE = 'bettertts-offline-pack-staging-v1'
export const PORTABLE_OFFLINE_PACK_FINAL_CACHE = 'bettertts-offline-pack-final-v1'

const PORTABLE_OFFLINE_PACK_MANIFEST_PREFIX = 'https://bettertts.invalid/offline-model-packs/v1/manifests/'
const PORTABLE_OFFLINE_PACK_STAGING_PREFIX = 'https://bettertts.invalid/offline-model-packs/v1/staging/'
const PORTABLE_OFFLINE_PACK_FINAL_PREFIX = 'https://bettertts.invalid/offline-model-packs/v1/final/'
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u
const VOICE_ID_PATTERN = /^[a-z]{2}_[a-z0-9_]{2,31}$/u
const IMMUTABLE_REVISION_PATTERN = /^[a-f0-9]{40}$/u

const PORTABLE_ARCHIVE_BUDGET: ArchiveBudget = {
  maxArchiveBytes: PORTABLE_OFFLINE_PACK_MAX_ARCHIVE_BYTES,
  maxEntries: PORTABLE_OFFLINE_PACK_MAX_ASSETS + 1,
  maxEntryBytes: PORTABLE_OFFLINE_PACK_MAX_ENTRY_BYTES,
  maxTotalBytes: PORTABLE_OFFLINE_PACK_MAX_TOTAL_BYTES + 1_024 * 1_024,
  maxCompressionRatio: 100,
}

export type PortableLicenseTier = 'permissive' | 'restricted' | 'non-commercial'

export type PortablePackCacheTarget = {
  cacheName: string
  url: string
}

export type PortablePackAsset = {
  path: string
  sizeBytes: number
  sha256: string
  sourceUrl: string
  cacheTargets: PortablePackCacheTarget[]
}

export type PortablePackAssetBytes = {
  path: string
  bytes: Uint8Array
}

export type PortableOfflinePackManifest = {
  format: typeof PORTABLE_OFFLINE_PACK_FORMAT
  schemaVersion: typeof PORTABLE_OFFLINE_PACK_SCHEMA_VERSION
  packId: string
  engineId: string
  modelId: string
  revision: string
  sourceUrl: string
  license: {
    spdx: string
    tier: PortableLicenseTier
    acknowledgedAt: string
  }
  createdAt: string
  voiceId?: string
  assets: PortablePackAsset[]
}

type StoredPortableOfflinePackManifest = PortableOfflinePackManifest & {
  storageState: 'staging' | 'committed'
  verifiedAt?: string
  lastError?: string
}

export type PortableOfflinePackBuildInput = {
  engineId: string
  packId?: string
  voiceId?: string
  sourceUrl?: string
  licenseAcknowledged: boolean
  licenseAcknowledgedAt?: string
  createdAt?: string
  assets: readonly (PortablePackAssetBytes & {
    sourceUrl?: string
    cacheTargets?: readonly PortablePackCacheTarget[]
  })[]
}

export type PortableEngineResolution = {
  supported: boolean
  engine: CapabilityEngine | null
  model: CapabilityModel | null
  reason?: string
}

export type PortablePackValidationIssue = {
  code:
    | 'invalid-format'
    | 'invalid-identity'
    | 'unsupported-engine'
    | 'invalid-license'
    | 'invalid-asset'
    | 'missing-asset'
    | 'asset-mismatch'
    | 'invalid-target'
    | 'incomplete-pack'
  message: string
}

export type PortableOfflinePackStatus = {
  packId: string
  engineId: string
  modelId: string
  revision: string
  licenseSpdx: string
  licenseTier: PortableLicenseTier
  storageState: 'staging' | 'ready'
  ready: boolean
  repairable: boolean
  assetCount: number
  verifiedAssetCount: number
  totalBytes: number
  updatedAt: string
  error?: string
}

export type PortablePackArchive = {
  manifest: PortableOfflinePackManifest
  assets: PortablePackAssetBytes[]
  totalBytes: number
}

export type PortablePackArchiveOptions = {
  /** Archive inspection can run before an engine cache adapter is selected. */
  requireCacheTargets?: boolean
}

export type PortablePackStorage = Pick<CacheStorage, 'open'>

export class OfflineModelPackError extends Error {
  readonly code: 'license-required' | 'unsupported-engine' | 'invalid-manifest' | 'integrity-failed' | 'archive-invalid' | 'storage-unavailable'

  constructor(code: OfflineModelPackError['code'], message: string) {
    super(message)
    this.name = 'OfflineModelPackError'
    this.code = code
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

function isAssetPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value === PORTABLE_OFFLINE_PACK_MANIFEST_PATH) return false
  if (value.startsWith('/') || value.includes('\\')) return false
  const parts = value.split('/')
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function isImmutableModelAssetUrl(value: string, model: CapabilityModel): boolean {
  if (!isHttpsUrl(value)) return false
  try {
    const modelUrl = new URL(model.sourceUrl)
    const assetUrl = new URL(value)
    return assetUrl.origin === modelUrl.origin && assetUrl.pathname.includes(`/${model.revision}/`)
  } catch {
    return false
  }
}

function expectedKokoroTargetNames(path: string): string[] {
  return path.startsWith('voices/') ? ['transformers-cache', 'kokoro-voices'] : ['transformers-cache']
}

function expectedKokoroAssetUrl(model: CapabilityModel, path: string): string {
  const artifact = model.artifacts?.find((candidate) => candidate.path === path)
  if (artifact?.sourceUrl) return artifact.sourceUrl
  const modelUrl = new URL(model.sourceUrl)
  const resolvePath = modelUrl.pathname.replace(/\/tree\//u, '/resolve/')
  return new URL(`${resolvePath.replace(/\/$/u, '')}/${path}`, modelUrl.origin).toString()
}

export function resolvePortableEngine(engineId: string): PortableEngineResolution {
  const engine = capabilityEngine(engineId)
  if (!engine) return { supported: false, engine: null, model: null, reason: `Engine ${engineId} is not in the reviewed capability manifest.` }
  const model = CAPABILITIES.models.find((candidate) => candidate.modelId === engine.modelId)
  if (!model) return { supported: false, engine, model: null, reason: `Engine ${engine.id} has no reviewed model identity.` }
  if (engine.id === 'browser') return { supported: false, engine, model, reason: 'Browser-provided voices are device-managed and cannot be packed.' }
  if (!engine.platforms.includes('web') || !engine.runtime.includes('browser')) {
    return { supported: false, engine, model, reason: `${engine.label} has no browser offline runtime.` }
  }
  if (!IMMUTABLE_REVISION_PATTERN.test(model.revision) || !isHttpsUrl(model.sourceUrl)) {
    return { supported: false, engine, model, reason: `${engine.label} is missing an immutable HTTPS model identity.` }
  }
  return { supported: true, engine, model }
}

function targetIsAllowed(engineId: string, model: CapabilityModel, asset: PortablePackAsset, target: PortablePackCacheTarget): boolean {
  if (engineId !== 'kokoro' || !isImmutableModelAssetUrl(target.url, model)) return false
  if (!expectedKokoroTargetNames(asset.path).includes(target.cacheName)) return false
  return target.url === asset.sourceUrl
}

export function validatePortableOfflinePackManifest(
  value: unknown,
  options: { requireCacheTargets?: boolean } = {},
): PortablePackValidationIssue[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ code: 'invalid-format', message: 'The model pack manifest is not an object.' }]
  const record = value as Partial<PortableOfflinePackManifest>
  const issues: PortablePackValidationIssue[] = []
  if (record.format !== PORTABLE_OFFLINE_PACK_FORMAT || record.schemaVersion !== PORTABLE_OFFLINE_PACK_SCHEMA_VERSION) {
    issues.push({ code: 'invalid-format', message: 'The model pack format or schema version is unsupported.' })
  }
  const resolution = typeof record.engineId === 'string' ? resolvePortableEngine(record.engineId) : null
  if (!resolution?.supported || !resolution.engine || !resolution.model) {
    issues.push({ code: 'unsupported-engine', message: resolution?.reason ?? 'The model pack engine is unsupported.' })
  }
  if (typeof record.packId !== 'string' || !PACK_ID_PATTERN.test(record.packId)) issues.push({ code: 'invalid-identity', message: 'The model pack ID is invalid.' })
  if (typeof record.modelId !== 'string' || record.modelId !== resolution?.model?.modelId) issues.push({ code: 'invalid-identity', message: 'The model ID does not match the reviewed engine capability.' })
  if (typeof record.revision !== 'string' || record.revision !== resolution?.model?.revision || !IMMUTABLE_REVISION_PATTERN.test(record.revision)) {
    issues.push({ code: 'invalid-identity', message: 'The model revision is not the immutable reviewed revision.' })
  }
  if (typeof record.sourceUrl !== 'string' || record.sourceUrl !== resolution?.model?.sourceUrl || !isHttpsUrl(record.sourceUrl)) {
    issues.push({ code: 'invalid-identity', message: 'The model source URL does not match the reviewed HTTPS source.' })
  }
  if (!validIso(record.createdAt)) issues.push({ code: 'invalid-identity', message: 'The model pack creation time is invalid.' })
  const license = record.license
  if (!license || typeof license !== 'object' || Array.isArray(license)) {
    issues.push({ code: 'invalid-license', message: 'The model pack is missing license metadata.' })
  } else {
    const expectedLicense = resolution?.model?.license
    if (typeof license.spdx !== 'string' || license.spdx !== expectedLicense?.spdx) issues.push({ code: 'invalid-license', message: 'The model license does not match the reviewed capability.' })
    if (license.tier !== 'permissive' && license.tier !== 'restricted' && license.tier !== 'non-commercial') issues.push({ code: 'invalid-license', message: 'The model license tier is invalid.' })
    if (license.tier !== expectedLicense?.tier) issues.push({ code: 'invalid-license', message: 'The model license tier does not match the reviewed capability.' })
    if (!validIso(license.acknowledgedAt)) issues.push({ code: 'invalid-license', message: 'The model license acknowledgement time is missing.' })
  }
  if (record.engineId === 'kokoro' && (typeof record.voiceId !== 'string' || !VOICE_ID_PATTERN.test(record.voiceId))) {
    issues.push({ code: 'invalid-identity', message: 'Kokoro packs require a valid voice ID.' })
  }
  const assets = Array.isArray(record.assets) ? record.assets : []
  if (assets.length === 0 || assets.length > PORTABLE_OFFLINE_PACK_MAX_ASSETS) issues.push({ code: 'invalid-asset', message: 'The model pack must contain a bounded non-empty asset list.' })
  const paths = new Set<string>()
  let totalBytes = 0
  for (const valueAsset of assets) {
    if (!valueAsset || typeof valueAsset !== 'object' || Array.isArray(valueAsset)) {
      issues.push({ code: 'invalid-asset', message: 'The model pack contains invalid asset metadata.' })
      continue
    }
    const asset = valueAsset as Partial<PortablePackAsset>
    if (!isAssetPath(asset.path) || paths.has(asset.path)) {
      issues.push({ code: 'invalid-asset', message: `The model pack contains a duplicate or unsafe asset path: ${String(asset.path)}.` })
    } else {
      paths.add(asset.path)
    }
    if (!Number.isSafeInteger(asset.sizeBytes) || Number(asset.sizeBytes) < 0 || Number(asset.sizeBytes) > PORTABLE_OFFLINE_PACK_MAX_ENTRY_BYTES) {
      issues.push({ code: 'invalid-asset', message: `Asset ${String(asset.path)} has an invalid size.` })
    } else {
      totalBytes += Number(asset.sizeBytes)
    }
    if (typeof asset.sha256 !== 'string' || !SHA256_PATTERN.test(asset.sha256)) issues.push({ code: 'invalid-asset', message: `Asset ${String(asset.path)} has an invalid SHA-256 digest.` })
    if (typeof asset.sourceUrl !== 'string' || !isImmutableModelAssetUrl(asset.sourceUrl, resolution?.model ?? ({ sourceUrl: '' } as CapabilityModel))) {
      issues.push({ code: 'invalid-asset', message: `Asset ${String(asset.path)} has an invalid immutable source URL.` })
    }
    const targets = Array.isArray(asset.cacheTargets) ? asset.cacheTargets : []
    if (options.requireCacheTargets && targets.length === 0) issues.push({ code: 'invalid-target', message: `Asset ${String(asset.path)} has no cache target.` })
    const targetNames = new Set<string>()
    for (const valueTarget of targets) {
      if (!valueTarget || typeof valueTarget !== 'object' || Array.isArray(valueTarget)) {
        issues.push({ code: 'invalid-target', message: `Asset ${String(asset.path)} has invalid cache target metadata.` })
        continue
      }
      const target = valueTarget as Partial<PortablePackCacheTarget>
      if (typeof target.cacheName !== 'string' || targetNames.has(target.cacheName) || typeof target.url !== 'string') {
        issues.push({ code: 'invalid-target', message: `Asset ${String(asset.path)} has duplicate or invalid cache target metadata.` })
        continue
      }
      targetNames.add(target.cacheName)
      if (!resolution?.model || typeof record.engineId !== 'string' || !targetIsAllowed(record.engineId, resolution.model, asset as PortablePackAsset, target as PortablePackCacheTarget)) {
        issues.push({ code: 'invalid-target', message: `Asset ${String(asset.path)} targets a cache outside the engine adapter.` })
      }
    }
    const expected = resolution?.model?.artifacts?.find((artifact) => artifact.path === asset.path)
    if (expected && (asset.sizeBytes !== expected.sizeBytes || asset.sha256 !== expected.sha256 || (expected.sourceUrl && asset.sourceUrl !== expected.sourceUrl))) {
      issues.push({ code: 'asset-mismatch', message: `Asset ${asset.path} does not match the reviewed size, digest, or source.` })
    }
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes > PORTABLE_OFFLINE_PACK_MAX_TOTAL_BYTES) issues.push({ code: 'invalid-asset', message: 'The model pack exceeds its cumulative size limit.' })
  for (const artifact of resolution?.model?.artifacts ?? []) {
    if (!paths.has(artifact.path)) issues.push({ code: 'missing-asset', message: `The model pack is missing reviewed asset ${artifact.path}.` })
  }
  if (record.engineId === 'kokoro' && typeof record.voiceId === 'string' && !paths.has(`voices/${record.voiceId}.bin`)) {
    issues.push({ code: 'incomplete-pack', message: `The Kokoro pack is missing voice asset ${record.voiceId}.` })
  }
  return issues
}

function assertValidManifest(manifest: PortableOfflinePackManifest, options: { requireCacheTargets?: boolean } = {}): void {
  const issues = validatePortableOfflinePackManifest(manifest, options)
  if (issues.length > 0) throw new OfflineModelPackError('invalid-manifest', issues.slice(0, 3).map((issue) => issue.message).join(' '))
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new OfflineModelPackError('integrity-failed', 'Model pack verification requires crypto.subtle.')
  // Hash exactly the view. Cache and archive APIs can hand us a subarray
  // backed by a larger buffer that must not affect the digest.
  const digest = await subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function createPortableOfflinePackManifest(input: PortableOfflinePackBuildInput): Promise<{ manifest: PortableOfflinePackManifest; assets: PortablePackAssetBytes[] }> {
  const resolution = resolvePortableEngine(input.engineId)
  if (!resolution.supported || !resolution.engine || !resolution.model) throw new OfflineModelPackError('unsupported-engine', resolution.reason ?? 'The selected engine cannot be packed for browser offline use.')
  if (!input.licenseAcknowledged) throw new OfflineModelPackError('license-required', 'Explicit license confirmation is required before creating a portable model pack.')
  const acknowledgedAt = input.licenseAcknowledgedAt ?? nowIso()
  if (!validIso(acknowledgedAt)) throw new OfflineModelPackError('license-required', 'The license acknowledgement time is invalid.')
  const createdAt = input.createdAt ?? nowIso()
  if (!validIso(createdAt)) throw new OfflineModelPackError('invalid-manifest', 'The model pack creation time is invalid.')
  const assets: PortablePackAsset[] = []
  const bytes: PortablePackAssetBytes[] = []
  const sourceAssets = new Set<string>()
  for (const source of input.assets) {
    if (!isAssetPath(source.path) || sourceAssets.has(source.path)) throw new OfflineModelPackError('invalid-manifest', `Invalid or duplicate asset path ${source.path}.`)
    sourceAssets.add(source.path)
    const copy = new Uint8Array(source.bytes)
    const sha256 = await sha256Hex(copy)
    const expected = resolution.model.artifacts?.find((artifact) => artifact.path === source.path)
    const sourceUrl = source.sourceUrl ?? expected?.sourceUrl ?? (input.engineId === 'kokoro' ? expectedKokoroAssetUrl(resolution.model, source.path) : undefined)
    if (!sourceUrl) throw new OfflineModelPackError('invalid-manifest', `Asset ${source.path} is missing an immutable source URL.`)
    const cacheTargets = [...(source.cacheTargets ?? (input.engineId === 'kokoro' ? expectedKokoroTargetNames(source.path).map((cacheName) => ({ cacheName, url: sourceUrl })) : []))]
    assets.push({ path: source.path, sizeBytes: copy.byteLength, sha256, sourceUrl, cacheTargets })
    bytes.push({ path: source.path, bytes: copy })
  }
  const manifest: PortableOfflinePackManifest = {
    format: PORTABLE_OFFLINE_PACK_FORMAT,
    schemaVersion: PORTABLE_OFFLINE_PACK_SCHEMA_VERSION,
    packId: input.packId ?? `portable-${input.engineId}-${input.voiceId ?? resolution.model.id}`.replace(/[^a-z0-9._:-]+/giu, '-').slice(0, 128),
    engineId: input.engineId,
    modelId: resolution.model.modelId,
    revision: resolution.model.revision,
    sourceUrl: input.sourceUrl ?? resolution.model.sourceUrl,
    license: { spdx: resolution.model.license.spdx, tier: resolution.model.license.tier, acknowledgedAt },
    createdAt,
    ...(input.voiceId ? { voiceId: input.voiceId } : {}),
    assets,
  }
  assertValidManifest(manifest, { requireCacheTargets: true })
  return { manifest, assets: bytes }
}

export async function buildPortableOfflineModelPackArchive(
  manifest: PortableOfflinePackManifest,
  assets: readonly PortablePackAssetBytes[],
  options: PortablePackArchiveOptions = {},
): Promise<Uint8Array> {
  assertValidManifest(manifest, { requireCacheTargets: options.requireCacheTargets ?? true })
  const byPath = new Map(assets.map((asset) => [asset.path, asset.bytes]))
  if (byPath.size !== assets.length || byPath.size !== manifest.assets.length || manifest.assets.some((asset) => !byPath.has(asset.path))) {
    throw new OfflineModelPackError('invalid-manifest', 'Portable model pack bytes do not match the manifest asset list.')
  }
  const entries: Record<string, Uint8Array> = {
    [PORTABLE_OFFLINE_PACK_MANIFEST_PATH]: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  }
  const sizes = [entries[PORTABLE_OFFLINE_PACK_MANIFEST_PATH].byteLength]
  for (const asset of manifest.assets) {
    const bytes = byPath.get(asset.path)!
    const digest = await sha256Hex(bytes)
    if (bytes.byteLength !== asset.sizeBytes || digest !== asset.sha256) throw new OfflineModelPackError('integrity-failed', `Asset ${asset.path} failed verification before export.`)
    entries[`assets/${asset.path}`] = bytes
    sizes.push(bytes.byteLength)
  }
  assertArchivePayloadSizes(sizes, { maxEntries: PORTABLE_OFFLINE_PACK_MAX_ASSETS + 1, maxEntryBytes: PORTABLE_OFFLINE_PACK_MAX_ENTRY_BYTES, maxTotalBytes: PORTABLE_OFFLINE_PACK_MAX_TOTAL_BYTES + 1_024 * 1_024 }, 'Portable model pack')
  return zipSync(entries, { level: 0 })
}

export async function inspectPortableOfflineModelPack(
  source: Uint8Array | Blob,
  options: PortablePackArchiveOptions = {},
): Promise<PortablePackArchive> {
  const bytes = source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : new Uint8Array(source)
  try {
    const entries = inspectZipArchive(bytes, PORTABLE_ARCHIVE_BUDGET, 'Portable model pack')
    const names = new Set(entries.map((entry) => entry.normalizedName))
    if (!names.has(PORTABLE_OFFLINE_PACK_MANIFEST_PATH) || entries.some((entry) => entry.normalizedName !== PORTABLE_OFFLINE_PACK_MANIFEST_PATH && !entry.normalizedName.startsWith('assets/'))) {
      throw new OfflineModelPackError('archive-invalid', 'Portable model packs may contain only manifest.json and assets/.')
    }
    const extracted = extractInspectedZipEntries(bytes, entries, names, PORTABLE_ARCHIVE_BUDGET, 'Portable model pack')
    const rawManifest = JSON.parse(new TextDecoder().decode(extracted[PORTABLE_OFFLINE_PACK_MANIFEST_PATH])) as unknown
    const issues = validatePortableOfflinePackManifest(rawManifest, { requireCacheTargets: options.requireCacheTargets ?? true })
    if (issues.length > 0) throw new OfflineModelPackError('invalid-manifest', issues.slice(0, 3).map((issue) => issue.message).join(' '))
    const manifest = rawManifest as PortableOfflinePackManifest
    const assets: PortablePackAssetBytes[] = []
    const expectedNames = new Set(manifest.assets.map((asset) => `assets/${asset.path}`))
    for (const entry of entries) {
      if (entry.normalizedName === PORTABLE_OFFLINE_PACK_MANIFEST_PATH) continue
      if (!expectedNames.has(entry.normalizedName)) throw new OfflineModelPackError('archive-invalid', `Unlisted asset ${entry.normalizedName} is not allowed.`)
    }
    for (const asset of manifest.assets) {
      const assetBytes = extracted[`assets/${asset.path}`]
      if (!assetBytes) throw new OfflineModelPackError('archive-invalid', `Portable model pack is missing ${asset.path}.`)
      const digest = await sha256Hex(assetBytes)
      if (assetBytes.byteLength !== asset.sizeBytes || digest !== asset.sha256) throw new OfflineModelPackError('integrity-failed', `Portable model pack asset ${asset.path} failed verification.`)
      assets.push({ path: asset.path, bytes: assetBytes })
    }
    return { manifest, assets, totalBytes: assets.reduce((sum, asset) => sum + asset.bytes.byteLength, extracted[PORTABLE_OFFLINE_PACK_MANIFEST_PATH].byteLength) }
  } catch (error) {
    if (error instanceof OfflineModelPackError) throw error
    throw new OfflineModelPackError('archive-invalid', error instanceof Error ? error.message : 'Portable model pack could not be read.')
  }
}

function getStorage(storage?: PortablePackStorage): PortablePackStorage {
  const resolved = storage ?? (typeof caches === 'undefined' ? undefined : caches)
  if (!resolved) throw new OfflineModelPackError('storage-unavailable', 'The Cache API is unavailable for portable model packs.')
  return resolved
}

function manifestRequest(packId: string): Request {
  return new Request(`${PORTABLE_OFFLINE_PACK_MANIFEST_PREFIX}${encodeURIComponent(packId)}`)
}

function assetRequest(prefix: string, packId: string, path: string): Request {
  return new Request(`${prefix}${encodeURIComponent(packId)}/${encodeURIComponent(path)}`)
}

function storedManifest(value: unknown): StoredPortableOfflinePackManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<StoredPortableOfflinePackManifest>
  if (record.storageState !== 'staging' && record.storageState !== 'committed') return null
  if (validatePortableOfflinePackManifest(record, { requireCacheTargets: true }).length > 0) return null
  return {
    ...(record as PortableOfflinePackManifest),
    storageState: record.storageState,
    ...(validIso(record.verifiedAt) ? { verifiedAt: record.verifiedAt } : {}),
    ...(typeof record.lastError === 'string' ? { lastError: record.lastError.slice(0, 500) } : {}),
  }
}

async function readStoredManifest(cache: Cache, packId: string): Promise<StoredPortableOfflinePackManifest | null> {
  try {
    const response = await cache.match(manifestRequest(packId))
    if (!response) return null
    return storedManifest(JSON.parse(await response.text()))
  } catch {
    return null
  }
}

async function writeStoredManifest(cache: Cache, manifest: StoredPortableOfflinePackManifest): Promise<void> {
  await cache.put(manifestRequest(manifest.packId), new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } }))
}

async function verifyCacheAssets(manifest: PortableOfflinePackManifest, cache: Cache, prefix: string): Promise<{ ok: boolean; verifiedAssetCount: number; totalBytes: number; error?: string }> {
  let verifiedAssetCount = 0
  let totalBytes = 0
  for (const asset of manifest.assets) {
    try {
      const response = await cache.match(assetRequest(prefix, manifest.packId, asset.path))
      if (!response) return { ok: false, verifiedAssetCount, totalBytes, error: `Missing staged asset ${asset.path}.` }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength !== asset.sizeBytes || await sha256Hex(bytes) !== asset.sha256) return { ok: false, verifiedAssetCount, totalBytes, error: `Digest mismatch for ${asset.path}.` }
      verifiedAssetCount += 1
      totalBytes += bytes.byteLength
    } catch (error) {
      return { ok: false, verifiedAssetCount, totalBytes, error: error instanceof Error ? error.message : `Could not verify ${asset.path}.` }
    }
  }
  return { ok: true, verifiedAssetCount, totalBytes }
}

async function verifyCacheTargets(manifest: PortableOfflinePackManifest, storage: PortablePackStorage): Promise<{ ok: boolean; error?: string }> {
  for (const asset of manifest.assets) {
    for (const target of asset.cacheTargets) {
      const cache = await storage.open(target.cacheName)
      const response = await cache.match(target.url)
      if (!response) return { ok: false, error: `Cache target ${target.cacheName} is missing ${asset.path}.` }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength !== asset.sizeBytes || await sha256Hex(bytes) !== asset.sha256) return { ok: false, error: `Cache target ${target.cacheName} failed verification for ${asset.path}.` }
    }
  }
  return { ok: true }
}

async function deleteInternalAssets(cache: Cache, manifest: PortableOfflinePackManifest, prefix: string): Promise<void> {
  await Promise.all(manifest.assets.map((asset) => cache.delete(assetRequest(prefix, manifest.packId, asset.path))))
}

async function deleteTargetAssets(manifest: PortableOfflinePackManifest, storage: PortablePackStorage): Promise<void> {
  for (const asset of manifest.assets) {
    for (const target of asset.cacheTargets) await (await storage.open(target.cacheName)).delete(target.url)
  }
}

async function promoteFromCache(
  manifest: PortableOfflinePackManifest,
  sourceCache: Cache,
  sourcePrefix: string,
  storage: PortablePackStorage,
  manifestCache: Cache,
  stored: StoredPortableOfflinePackManifest,
): Promise<PortableOfflinePackStatus> {
  const finalCache = await storage.open(PORTABLE_OFFLINE_PACK_FINAL_CACHE)
  for (const asset of manifest.assets) {
    const response = await sourceCache.match(assetRequest(sourcePrefix, manifest.packId, asset.path))
    if (!response) throw new OfflineModelPackError('integrity-failed', `Cannot promote missing ${asset.path}.`)
    await finalCache.put(assetRequest(PORTABLE_OFFLINE_PACK_FINAL_PREFIX, manifest.packId, asset.path), response.clone())
  }
  const finalVerification = await verifyCacheAssets(manifest, finalCache, PORTABLE_OFFLINE_PACK_FINAL_PREFIX)
  if (!finalVerification.ok) throw new OfflineModelPackError('integrity-failed', finalVerification.error ?? 'Portable pack final verification failed.')
  for (const asset of manifest.assets) {
    const response = await finalCache.match(assetRequest(PORTABLE_OFFLINE_PACK_FINAL_PREFIX, manifest.packId, asset.path))
    if (!response) throw new OfflineModelPackError('integrity-failed', `Cannot install missing ${asset.path}.`)
    for (const target of asset.cacheTargets) await (await storage.open(target.cacheName)).put(target.url, response.clone())
  }
  const targetVerification = await verifyCacheTargets(manifest, storage)
  if (!targetVerification.ok) throw new OfflineModelPackError('integrity-failed', targetVerification.error ?? 'Portable pack cache targets failed verification.')
  const committed: StoredPortableOfflinePackManifest = {
    ...stored,
    storageState: 'committed',
    verifiedAt: nowIso(),
    lastError: undefined,
  }
  await writeStoredManifest(manifestCache, committed)
  return statusFromManifest(committed, finalVerification.verifiedAssetCount, finalVerification.totalBytes, true)
}

function statusFromManifest(
  manifest: StoredPortableOfflinePackManifest,
  verifiedAssetCount: number,
  totalBytes: number,
  ready: boolean,
  error?: string,
): PortableOfflinePackStatus {
  return {
    packId: manifest.packId,
    engineId: manifest.engineId,
    modelId: manifest.modelId,
    revision: manifest.revision,
    licenseSpdx: manifest.license.spdx,
    licenseTier: manifest.license.tier,
    storageState: ready ? 'ready' : 'staging',
    ready,
    repairable: !ready,
    assetCount: manifest.assets.length,
    verifiedAssetCount,
    totalBytes,
    updatedAt: manifest.createdAt,
    ...(error ? { error: error.slice(0, 500) } : manifest.lastError ? { error: manifest.lastError } : {}),
  }
}

async function stageAndPromote(
  archive: PortablePackArchive,
  storage: PortablePackStorage,
  licenseAcknowledgedAt: string,
): Promise<PortableOfflinePackStatus> {
  const manifestCache = await storage.open(PORTABLE_OFFLINE_PACK_MANIFEST_CACHE)
  const stagingCache = await storage.open(PORTABLE_OFFLINE_PACK_STAGING_CACHE)
  const stored: StoredPortableOfflinePackManifest = {
    ...archive.manifest,
    license: { ...archive.manifest.license, acknowledgedAt: licenseAcknowledgedAt },
    storageState: 'staging',
  }
  await writeStoredManifest(manifestCache, stored)
  await deleteInternalAssets(stagingCache, stored, PORTABLE_OFFLINE_PACK_STAGING_PREFIX)
  try {
    for (const asset of archive.assets) {
      await stagingCache.put(
        assetRequest(PORTABLE_OFFLINE_PACK_STAGING_PREFIX, stored.packId, asset.path),
        new Response(asset.bytes.slice().buffer as ArrayBuffer, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(asset.bytes.byteLength) } }),
      )
    }
    const stagedVerification = await verifyCacheAssets(stored, stagingCache, PORTABLE_OFFLINE_PACK_STAGING_PREFIX)
    if (!stagedVerification.ok) throw new OfflineModelPackError('integrity-failed', stagedVerification.error ?? 'Portable pack staging verification failed.')
    const result = await promoteFromCache(stored, stagingCache, PORTABLE_OFFLINE_PACK_STAGING_PREFIX, storage, manifestCache, stored)
    await deleteInternalAssets(stagingCache, stored, PORTABLE_OFFLINE_PACK_STAGING_PREFIX)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Portable model pack import failed.'
    await writeStoredManifest(manifestCache, { ...stored, storageState: 'staging', lastError: message.slice(0, 500) }).catch(() => undefined)
    // Existing final bytes are never advertised as ready while the imported
    // manifest is staging. They may remain as verified fallback bytes for a
    // later repair, but no new unverified cache entry is activated.
    throw error instanceof OfflineModelPackError ? error : new OfflineModelPackError('storage-unavailable', message)
  }
}

export async function importPortableOfflineModelPack(
  source: Uint8Array | Blob,
  options: { licenseConfirmed: boolean; licenseConfirmedAt?: string; storage?: PortablePackStorage } ,
): Promise<PortableOfflinePackStatus> {
  if (!options.licenseConfirmed) throw new OfflineModelPackError('license-required', 'Confirm the model license before importing a portable pack.')
  const licenseConfirmedAt = options.licenseConfirmedAt ?? nowIso()
  if (!validIso(licenseConfirmedAt)) throw new OfflineModelPackError('license-required', 'The license confirmation time is invalid.')
  const archive = await inspectPortableOfflineModelPack(source)
  return stageAndPromote(archive, getStorage(options.storage), licenseConfirmedAt)
}

export async function readPortableOfflinePackStatuses(storage?: PortablePackStorage): Promise<PortableOfflinePackStatus[]> {
  const resolved = getStorage(storage)
  const manifestCache = await resolved.open(PORTABLE_OFFLINE_PACK_MANIFEST_CACHE)
  const statuses: PortableOfflinePackStatus[] = []
  for (const request of await manifestCache.keys()) {
    if (!request.url.startsWith(PORTABLE_OFFLINE_PACK_MANIFEST_PREFIX)) continue
    let packId: string
    try {
      packId = decodeURIComponent(request.url.slice(PORTABLE_OFFLINE_PACK_MANIFEST_PREFIX.length))
    } catch {
      continue
    }
    const manifest = await readStoredManifest(manifestCache, packId)
    if (!manifest) continue
    const sourceCacheName = manifest.storageState === 'committed' ? PORTABLE_OFFLINE_PACK_FINAL_CACHE : PORTABLE_OFFLINE_PACK_STAGING_CACHE
    const sourcePrefix = manifest.storageState === 'committed' ? PORTABLE_OFFLINE_PACK_FINAL_PREFIX : PORTABLE_OFFLINE_PACK_STAGING_PREFIX
    const verification = await verifyCacheAssets(manifest, await resolved.open(sourceCacheName), sourcePrefix)
    const targetVerification = verification.ok && manifest.storageState === 'committed' ? await verifyCacheTargets(manifest, resolved) : { ok: false, error: undefined }
    const ready = manifest.storageState === 'committed' && verification.ok && targetVerification.ok && manifest.verifiedAt !== undefined
    if (manifest.storageState === 'committed' && !ready) {
      await writeStoredManifest(manifestCache, { ...manifest, storageState: 'staging', lastError: verification.error ?? targetVerification.error ?? 'Portable pack verification is incomplete.' }).catch(() => undefined)
    }
    statuses.push(statusFromManifest(manifest, verification.verifiedAssetCount, verification.totalBytes, ready, verification.error ?? targetVerification.error))
  }
  return statuses
}

export async function repairPortableOfflineModelPack(packId: string, storage?: PortablePackStorage): Promise<PortableOfflinePackStatus | null> {
  if (!PACK_ID_PATTERN.test(packId)) throw new OfflineModelPackError('invalid-manifest', 'The portable model pack ID is invalid.')
  const resolved = getStorage(storage)
  const manifestCache = await resolved.open(PORTABLE_OFFLINE_PACK_MANIFEST_CACHE)
  const manifest = await readStoredManifest(manifestCache, packId)
  if (!manifest) return null
  let sourceIsStaging = manifest.storageState !== 'committed'
  let sourcePrefix = sourceIsStaging ? PORTABLE_OFFLINE_PACK_STAGING_PREFIX : PORTABLE_OFFLINE_PACK_FINAL_PREFIX
  let sourceCache = await resolved.open(sourceIsStaging ? PORTABLE_OFFLINE_PACK_STAGING_CACHE : PORTABLE_OFFLINE_PACK_FINAL_CACHE)
  let verification = await verifyCacheAssets(manifest, sourceCache, sourcePrefix)
  // A crash can leave a complete staged copy alongside a damaged committed
  // copy. Prefer that verified staging transaction when repairing instead of
  // forcing the user to download the pack again.
  if (!verification.ok && manifest.storageState === 'committed') {
    const stagingCache = await resolved.open(PORTABLE_OFFLINE_PACK_STAGING_CACHE)
    const stagedVerification = await verifyCacheAssets(manifest, stagingCache, PORTABLE_OFFLINE_PACK_STAGING_PREFIX)
    if (stagedVerification.ok) {
      sourceCache = stagingCache
      sourceIsStaging = true
      sourcePrefix = PORTABLE_OFFLINE_PACK_STAGING_PREFIX
      verification = stagedVerification
    }
  }
  if (!verification.ok && manifest.storageState === 'staging') {
    const finalCache = await resolved.open(PORTABLE_OFFLINE_PACK_FINAL_CACHE)
    const finalVerification = await verifyCacheAssets(manifest, finalCache, PORTABLE_OFFLINE_PACK_FINAL_PREFIX)
    if (finalVerification.ok) {
      sourceCache = finalCache
      sourceIsStaging = false
      sourcePrefix = PORTABLE_OFFLINE_PACK_FINAL_PREFIX
      verification = finalVerification
    }
  }
  if (!verification.ok) {
    await writeStoredManifest(manifestCache, { ...manifest, storageState: 'staging', lastError: verification.error ?? 'Portable pack needs to be imported again.' })
    return statusFromManifest({ ...manifest, storageState: 'staging', lastError: verification.error }, verification.verifiedAssetCount, verification.totalBytes, false, verification.error)
  }
  try {
    const result = await promoteFromCache(manifest, sourceCache, sourcePrefix, resolved, manifestCache, { ...manifest, storageState: 'staging' })
    if (sourceIsStaging) await deleteInternalAssets(sourceCache, manifest, PORTABLE_OFFLINE_PACK_STAGING_PREFIX)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Portable model pack repair failed.'
    await writeStoredManifest(manifestCache, { ...manifest, storageState: 'staging', lastError: message.slice(0, 500) })
    return statusFromManifest({ ...manifest, storageState: 'staging', lastError: message }, verification.verifiedAssetCount, verification.totalBytes, false, message)
  }
}

export async function removePortableOfflineModelPack(packId: string, storage?: PortablePackStorage): Promise<boolean> {
  if (!PACK_ID_PATTERN.test(packId)) return false
  const resolved = getStorage(storage)
  const manifestCache = await resolved.open(PORTABLE_OFFLINE_PACK_MANIFEST_CACHE)
  const manifest = await readStoredManifest(manifestCache, packId)
  if (!manifest) return false
  await deleteInternalAssets(await resolved.open(PORTABLE_OFFLINE_PACK_STAGING_CACHE), manifest, PORTABLE_OFFLINE_PACK_STAGING_PREFIX)
  await deleteInternalAssets(await resolved.open(PORTABLE_OFFLINE_PACK_FINAL_CACHE), manifest, PORTABLE_OFFLINE_PACK_FINAL_PREFIX)
  await deleteTargetAssets(manifest, resolved)
  await manifestCache.delete(manifestRequest(packId))
  return true
}

export async function exportPortableOfflineModelPack(
  packId: string,
  options: { licenseConfirmed: boolean; storage?: PortablePackStorage },
): Promise<Uint8Array> {
  if (!options.licenseConfirmed) throw new OfflineModelPackError('license-required', 'Confirm the model license before exporting a portable pack.')
  const resolved = getStorage(options.storage)
  const manifestCache = await resolved.open(PORTABLE_OFFLINE_PACK_MANIFEST_CACHE)
  const manifest = await readStoredManifest(manifestCache, packId)
  if (!manifest || manifest.storageState !== 'committed') throw new OfflineModelPackError('integrity-failed', 'Only a committed portable model pack can be exported.')
  const finalCache = await resolved.open(PORTABLE_OFFLINE_PACK_FINAL_CACHE)
  const verification = await verifyCacheAssets(manifest, finalCache, PORTABLE_OFFLINE_PACK_FINAL_PREFIX)
  const targets = await verifyCacheTargets(manifest, resolved)
  if (!verification.ok || !targets.ok || !manifest.verifiedAt) throw new OfflineModelPackError('integrity-failed', verification.error ?? targets.error ?? 'Portable model pack is not verified.')
  const assets: PortablePackAssetBytes[] = []
  for (const asset of manifest.assets) {
    const response = await finalCache.match(assetRequest(PORTABLE_OFFLINE_PACK_FINAL_PREFIX, manifest.packId, asset.path))
    if (!response) throw new OfflineModelPackError('integrity-failed', `Portable model pack is missing ${asset.path}.`)
    assets.push({ path: asset.path, bytes: new Uint8Array(await response.arrayBuffer()) })
  }
  return buildPortableOfflineModelPackArchive(manifest, assets)
}

export async function exportVerifiedKokoroPack(
  voiceId: string,
  options: { licenseConfirmed: boolean; licenseAcknowledgedAt?: string },
): Promise<{ bytes: Uint8Array; manifest: PortableOfflinePackManifest }> {
  if (!options.licenseConfirmed) throw new OfflineModelPackError('license-required', 'Confirm the Kokoro license before exporting a portable pack.')
  if (!VOICE_ID_PATTERN.test(voiceId)) throw new OfflineModelPackError('invalid-manifest', 'The selected Kokoro voice ID is invalid.')
  const cacheManifest = await readKokoroQ8PackManifest(voiceId)
  if (!cacheManifest || cacheManifest.state !== 'committed') throw new OfflineModelPackError('integrity-failed', 'Prefetch the selected Kokoro voice pack before exporting it.')
  if (typeof caches === 'undefined') throw new OfflineModelPackError('storage-unavailable', 'The Cache API is unavailable for Kokoro pack export.')
  const assets: Array<PortablePackAssetBytes & { sourceUrl: string; cacheTargets: PortablePackCacheTarget[] }> = []
  for (const record of cacheManifest.assets) {
    let bytes: Uint8Array | null = null
    for (const cacheName of record.cacheNames) {
      const cache = await caches.open(cacheName)
      const response = await cache.match(record.url)
      if (!response) throw new OfflineModelPackError('integrity-failed', `Cached Kokoro asset ${record.path} is missing from ${cacheName}.`)
      const candidate = new Uint8Array(await response.arrayBuffer())
      if (candidate.byteLength !== record.sizeBytes || await sha256Hex(candidate) !== record.sha256) throw new OfflineModelPackError('integrity-failed', `Cached Kokoro asset ${record.path} failed verification.`)
      bytes ??= candidate
    }
    if (!bytes) throw new OfflineModelPackError('integrity-failed', `Cached Kokoro asset ${record.path} is empty.`)
    assets.push({ path: record.path, bytes, sourceUrl: record.url, cacheTargets: record.cacheNames.map((cacheName) => ({ cacheName, url: record.url })) })
  }
  const built = await createPortableOfflinePackManifest({
    engineId: 'kokoro',
    packId: `portable-kokoro-q8:${voiceId}`,
    voiceId,
    licenseAcknowledged: true,
    licenseAcknowledgedAt: options.licenseAcknowledgedAt,
    assets,
  })
  return { bytes: await buildPortableOfflineModelPackArchive(built.manifest, built.assets), manifest: built.manifest }
}
