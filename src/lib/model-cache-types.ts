export type ModelCacheEngineId = 'kokoro' | 'supertonic' | 'kitten' | 'chatterbox' | 'shell'

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

export type ModelCacheStorageStatus = {
  supported: boolean
  persisted?: boolean
  usageBytes?: number
  quotaBytes?: number
  availableBytes?: number
  pressure?: 'ok' | 'near-limit' | 'unknown'
  error?: string
}

export type ModelPackAssetRecord = {
  path: string
  url: string
  cacheNames: string[]
  sizeBytes: number
  sha256: string
}

export type ModelPackManifest = {
  schemaVersion: 1
  packId: string
  voiceId: string
  state: 'staging' | 'committed'
  createdAt: number
  updatedAt: number
  assets: ModelPackAssetRecord[]
  commitMarker?: string
}

export type ModelPackStatus = {
  packId: string
  voiceId: string
  state: ModelPackManifest['state']
  assetCount: number
  verifiedAssetCount: number
  updatedAt: number
  repairable: boolean
}

export type ModelCacheSummary = {
  supported: boolean
  engines: EngineCacheStatus[]
  totalBytes: number
  unknownSizeCount: number
  storage?: ModelCacheStorageStatus
  packs?: ModelPackStatus[]
}
