export const ENGINE_MANIFEST_SCHEMA_VERSION = 1 as const

export type EngineRuntime = 'browser' | 'native' | 'sidecar'
export type EnginePlatform = 'web' | 'windows' | 'macos' | 'linux'
export type EngineAccelerator = 'cpu' | 'webgpu' | 'cuda' | 'directml'
export type EngineLicenseTier = 'permissive' | 'restricted' | 'non-commercial'
export type EngineSafetyTier = 'standard' | 'experimental' | 'consent-required'
export type EngineModelSource = 'bundled' | 'remote' | 'local'
export type EngineExportFormat = 'wav' | 'mp3' | 'opus' | 'flac' | 'm4b'
export type EngineDiagnosticField = 'runtime' | 'model' | 'revision' | 'license' | 'hardware' | 'queue' | 'latency' | 'cache' | 'audio' | 'error'

export type EngineLicense = {
  spdx: string
  tier: EngineLicenseTier
  url?: string
}

export type EngineModelFile = {
  /** Relative path inside the adapter-managed model root. */
  path: string
  source: EngineModelSource
  sizeBytes: number
  sha256: string
  /** Immutable source revision for remotely fetched files. */
  revision?: string
  sourceUrl?: string
}

export type EngineHardwareRequirements = {
  platforms: readonly EnginePlatform[]
  accelerators: readonly EngineAccelerator[]
  minMemoryBytes?: number
  minVramBytes?: number
}

export type EngineCapabilities = {
  queue: boolean
  streaming: boolean
  timestamps: boolean
  exportFormats: readonly EngineExportFormat[]
}

export type EngineDiagnosticsDescriptor = {
  fields: readonly EngineDiagnosticField[]
  redactPaths: boolean
}

/** Serializable, local-first contract for a synthesizer implementation. */
export type EngineManifest = {
  schemaVersion: typeof ENGINE_MANIFEST_SCHEMA_VERSION
  id: string
  label: string
  runtime: readonly EngineRuntime[]
  license: EngineLicense
  modelFiles: readonly EngineModelFile[]
  hardware: EngineHardwareRequirements
  capabilities: EngineCapabilities
  safetyTier: EngineSafetyTier
  consentRequired: boolean
  diagnostics: EngineDiagnosticsDescriptor
}

export type EngineProbeContext = {
  platform: EnginePlatform
  accelerators: readonly EngineAccelerator[]
  memoryBytes?: number
  vramBytes?: number
}

export type EngineAvailability = {
  available: boolean
  reason?: string
  diagnostics?: Readonly<Record<string, string | number | boolean>>
}

export type EngineProgress = {
  stage: string
  progress?: number
  loadedBytes?: number
  totalBytes?: number
}

export type EngineAdapterContext = EngineProbeContext & {
  signal?: AbortSignal
  reportProgress?: (progress: EngineProgress) => void
}

export type EngineSynthesisRequest = {
  text: string
  voice: string
  speed: number
}

export type EngineAudio = {
  samples: Float32Array
  sampleRate: number
}

export type EngineAdapter<Session = unknown> = {
  manifest: EngineManifest
  probe: (context: EngineProbeContext) => EngineAvailability
  load: (context: EngineAdapterContext) => Promise<Session>
  synthesize: (session: Session, request: EngineSynthesisRequest, context: EngineAdapterContext) => Promise<EngineAudio>
  dispose?: (session: Session) => Promise<void> | void
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const REVISION_PATTERN = /^[a-f0-9]{40,64}$/i
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const SAFE_PATH_PART = /^(?!\.\.?$)[^\\/]+$/
const HTTPS_PATTERN = /^https:\/\/[^\s]+$/i

const RUNTIMES = new Set<EngineRuntime>(['browser', 'native', 'sidecar'])
const PLATFORMS = new Set<EnginePlatform>(['web', 'windows', 'macos', 'linux'])
const ACCELERATORS = new Set<EngineAccelerator>(['cpu', 'webgpu', 'cuda', 'directml'])
const LICENSE_TIERS = new Set<EngineLicenseTier>(['permissive', 'restricted', 'non-commercial'])
const SAFETY_TIERS = new Set<EngineSafetyTier>(['standard', 'experimental', 'consent-required'])
const MODEL_SOURCES = new Set<EngineModelSource>(['bundled', 'remote', 'local'])
const EXPORT_FORMATS = new Set<EngineExportFormat>(['wav', 'mp3', 'opus', 'flac', 'm4b'])
const DIAGNOSTIC_FIELDS = new Set<EngineDiagnosticField>([
  'runtime',
  'model',
  'revision',
  'license',
  'hardware',
  'queue',
  'latency',
  'cache',
  'audio',
  'error',
])

type RecordValue = Record<string, unknown>

function asRecord(value: unknown, label: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid engine manifest: ${label} must be an object.`)
  return value as RecordValue
}

function requiredString(record: RecordValue, key: string, maxLength: number): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid engine manifest: ${key} must be a non-empty string of at most ${maxLength} characters.`)
  }
  return value
}

function optionalString(record: RecordValue, key: string, maxLength: number): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid engine manifest: ${key} must be a non-empty string of at most ${maxLength} characters.`)
  }
  return value
}

function enumValue<T extends string>(record: RecordValue, key: string, values: ReadonlySet<T>): T {
  const value = record[key]
  if (typeof value !== 'string' || !values.has(value as T)) throw new Error(`Invalid engine manifest: ${key} is not supported.`)
  return value as T
}

function enumArray<T extends string>(record: RecordValue, key: string, values: ReadonlySet<T>): T[] {
  const value = record[key]
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || !values.has(entry as T))) {
    throw new Error(`Invalid engine manifest: ${key} must contain at least one supported value.`)
  }
  const result = value as T[]
  if (new Set(result).size !== result.length) throw new Error(`Invalid engine manifest: ${key} contains duplicates.`)
  return [...result]
}

function positiveInteger(record: RecordValue, key: string, required = false): number | undefined {
  const value = record[key]
  if (value === undefined && !required) return undefined
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`Invalid engine manifest: ${key} must be a positive safe integer.`)
  return value as number
}

function requiredBoolean(record: RecordValue, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new Error(`Invalid engine manifest: ${key} must be a boolean.`)
  return value
}

function parseLicense(input: unknown, label: string): EngineLicense {
  const record = asRecord(input, label)
  const spdx = requiredString(record, 'spdx', 120)
  const tier = enumValue(record, 'tier', LICENSE_TIERS)
  const url = optionalString(record, 'url', 500)
  if (url && !HTTPS_PATTERN.test(url)) throw new Error(`Invalid engine manifest: ${label}.url must use HTTPS.`)
  return url ? { spdx, tier, url } : { spdx, tier }
}

function parseModelFile(input: unknown, index: number): EngineModelFile {
  const record = asRecord(input, `modelFiles[${index}]`)
  const path = requiredString(record, 'path', 300)
  const parts = path.split('/')
  if (path.startsWith('/') || parts.some((part) => !SAFE_PATH_PART.test(part))) {
    throw new Error(`Invalid engine manifest: modelFiles[${index}].path must be a safe relative path.`)
  }
  const source = enumValue(record, 'source', MODEL_SOURCES)
  const sizeBytes = positiveInteger(record, 'sizeBytes', true)!
  const sha256 = requiredString(record, 'sha256', 64).toLowerCase()
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`Invalid engine manifest: modelFiles[${index}].sha256 must be a SHA-256 digest.`)
  const revision = optionalString(record, 'revision', 64)
  if (source === 'remote' && (!revision || !REVISION_PATTERN.test(revision))) {
    throw new Error(`Invalid engine manifest: modelFiles[${index}] remote files require an immutable revision.`)
  }
  if (revision && !REVISION_PATTERN.test(revision)) throw new Error(`Invalid engine manifest: modelFiles[${index}].revision must be an immutable commit.`)
  const sourceUrl = optionalString(record, 'sourceUrl', 500)
  if (sourceUrl && !HTTPS_PATTERN.test(sourceUrl)) throw new Error(`Invalid engine manifest: modelFiles[${index}].sourceUrl must use HTTPS.`)
  if (source === 'remote' && !sourceUrl) throw new Error(`Invalid engine manifest: modelFiles[${index}] remote files require an HTTPS sourceUrl.`)
  return { path, source, sizeBytes, sha256, ...(revision ? { revision } : {}), ...(sourceUrl ? { sourceUrl } : {}) }
}

function parseHardware(input: unknown): EngineHardwareRequirements {
  const record = asRecord(input, 'hardware')
  const platforms = enumArray(record, 'platforms', PLATFORMS)
  const accelerators = enumArray(record, 'accelerators', ACCELERATORS)
  const minMemoryBytes = positiveInteger(record, 'minMemoryBytes')
  const minVramBytes = positiveInteger(record, 'minVramBytes')
  return { platforms, accelerators, ...(minMemoryBytes ? { minMemoryBytes } : {}), ...(minVramBytes ? { minVramBytes } : {}) }
}

function parseCapabilities(input: unknown): EngineCapabilities {
  const record = asRecord(input, 'capabilities')
  const queue = requiredBoolean(record, 'queue')
  const streaming = requiredBoolean(record, 'streaming')
  const timestamps = requiredBoolean(record, 'timestamps')
  const exportFormats = enumArray(record, 'exportFormats', EXPORT_FORMATS)
  return { queue, streaming, timestamps, exportFormats }
}

function parseDiagnostics(input: unknown): EngineDiagnosticsDescriptor {
  const record = asRecord(input, 'diagnostics')
  const fields = enumArray(record, 'fields', DIAGNOSTIC_FIELDS)
  for (const required of ['runtime', 'model', 'license', 'error'] as const) {
    if (!fields.includes(required)) throw new Error(`Invalid engine manifest: diagnostics.fields must include ${required}.`)
  }
  return { fields, redactPaths: requiredBoolean(record, 'redactPaths') }
}

/** Parse and validate a manifest before it enters an adapter registry. */
export function validateEngineManifest(input: unknown): EngineManifest {
  const record = asRecord(input, 'root')
  if (record.schemaVersion !== ENGINE_MANIFEST_SCHEMA_VERSION) throw new Error(`Invalid engine manifest: unsupported schemaVersion ${String(record.schemaVersion)}.`)
  const id = requiredString(record, 'id', 64)
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid engine manifest: id must contain only letters, numbers, dots, underscores, and hyphens.`)
  const label = requiredString(record, 'label', 120)
  const runtime = enumArray(record, 'runtime', RUNTIMES)
  const modelFilesInput = record.modelFiles
  if (!Array.isArray(modelFilesInput) || modelFilesInput.length === 0) throw new Error('Invalid engine manifest: modelFiles must not be empty.')
  const modelFiles = modelFilesInput.map(parseModelFile)
  if (new Set(modelFiles.map((file) => file.path)).size !== modelFiles.length) throw new Error('Invalid engine manifest: modelFiles contains duplicate paths.')
  const license = parseLicense(record.license, 'license')
  const hardware = parseHardware(record.hardware)
  const capabilities = parseCapabilities(record.capabilities)
  const safetyTier = enumValue(record, 'safetyTier', SAFETY_TIERS)
  const consentRequired = requiredBoolean(record, 'consentRequired')
  if ((safetyTier === 'consent-required') !== consentRequired) {
    throw new Error('Invalid engine manifest: consentRequired must match the consent-required safety tier.')
  }
  const diagnostics = parseDiagnostics(record.diagnostics)

  return {
    schemaVersion: ENGINE_MANIFEST_SCHEMA_VERSION,
    id,
    label,
    runtime,
    license,
    modelFiles,
    hardware,
    capabilities,
    safetyTier,
    consentRequired,
    diagnostics,
  }
}

export function defineEngineAdapter<Session>(
  manifestInput: unknown,
  implementation: Omit<EngineAdapter<Session>, 'manifest'>,
): EngineAdapter<Session> {
  if (typeof implementation.probe !== 'function' || typeof implementation.load !== 'function' || typeof implementation.synthesize !== 'function') {
    throw new Error('Invalid engine adapter: probe, load, and synthesize functions are required.')
  }
  return { manifest: validateEngineManifest(manifestInput), ...implementation }
}

/** Registry used by platform/runtime hosts; AppShell can consume descriptors without knowing adapter internals. */
export class EngineAdapterRegistry {
  private readonly adapters = new Map<string, EngineAdapter<unknown>>()

  register<Session>(adapter: EngineAdapter<Session>): this {
    const manifest = validateEngineManifest(adapter.manifest)
    if (this.adapters.has(manifest.id)) throw new Error(`Engine adapter already registered: ${manifest.id}`)
    this.adapters.set(manifest.id, adapter as unknown as EngineAdapter<unknown>)
    return this
  }

  get(id: string): EngineAdapter<unknown> | undefined {
    return this.adapters.get(id)
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }

  list(): readonly EngineAdapter<unknown>[] {
    return [...this.adapters.values()]
  }
}
