export const BENCHMARK_SCHEMA_VERSION = 1 as const
export const BENCHMARK_STORAGE_KEY = 'bettertts-benchmark-v1'
export const BENCHMARK_OPT_IN_STORAGE_KEY = 'bettertts-benchmark-enabled'
export const MAX_BENCHMARK_OBSERVATIONS = 32
const MAX_BENCHMARK_REPORT_BYTES = 96 * 1024
const MAX_IDENTIFIER_CHARS = 180
const MAX_INPUT_CHARS = 5_000

export type BenchmarkOutcome = 'completed' | 'cancelled' | 'failed'
export type BenchmarkRuntimeKind = 'browser' | 'native' | 'sidecar' | 'unknown'

export type BenchmarkIdentity = {
  engineId: string
  modelId: string
  modelRevision: string
  runtimeKind: BenchmarkRuntimeKind
  runtimeLabel: string
  runtimeRevision?: string
}

export type BenchmarkIdentityInput = Partial<BenchmarkIdentity>

export type BenchmarkMemoryObservation = {
  supported: boolean
  deviceMemoryGb: number | null
  jsHeapUsedBytes?: number
  jsHeapTotalBytes?: number
  jsHeapLimitBytes?: number
}

export type BenchmarkQuotaObservation = {
  supported: boolean
  persisted: boolean | null
  usageBytes?: number
  quotaBytes?: number
  usagePct?: number
}

export type BenchmarkResourceSnapshot = {
  memory: BenchmarkMemoryObservation
  quota: BenchmarkQuotaObservation
}

export type BenchmarkObservation = {
  id: string
  recordedAt: string
  identity: BenchmarkIdentity
  metrics: {
    elapsedMs: number
    firstAudioLatencyMs: number | null
    audioDurationSeconds: number
    inputChars: number
    throughputCharsPerSecond: number
    realtimeFactor: number
  }
  reliability: {
    outcome: BenchmarkOutcome
    retryCount: number
    failureCount: number
  }
  resources: BenchmarkResourceSnapshot
}

export type BenchmarkObservationInput = {
  id?: string
  recordedAt?: string
  identity: BenchmarkIdentityInput
  elapsedMs: number
  firstAudioLatencyMs?: number | null
  audioDurationSeconds: number
  inputChars: number
  outcome: BenchmarkOutcome
  retryCount?: number
  failureCount?: number
  resources?: BenchmarkResourceSnapshot
}

export type BenchmarkReport = {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION
  localOnly: true
  generatedAt: string
  observations: BenchmarkObservation[]
}

export type BenchmarkStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type BenchmarkResourceProbes = {
  navigator?: {
    deviceMemory?: number
    storage?: {
      estimate?: () => Promise<{ usage?: number; quota?: number }>
      persisted?: () => Promise<boolean>
    }
  }
  performance?: {
    memory?: {
      usedJSHeapSize?: number
      totalJSHeapSize?: number
      jsHeapSizeLimit?: number
    }
  }
}

export type BenchmarkAppendResult = {
  report: BenchmarkReport
  observation: BenchmarkObservation
  persisted: boolean
  error?: string
}

function nowDate(): Date {
  return new Date()
}

function defaultStorage(): BenchmarkStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function safeString(value: unknown, fallback: string, maxLength = MAX_IDENTIFIER_CHARS): string {
  if (typeof value !== 'string') return fallback
  const normalized = value
    .replace(/https?:\/\/\S+/giu, '<redacted-url>')
    .replace(/\b(?:bearer|basic)\s+\S+/giu, 'REDACTED')
    .replace(/([?&](?:api[_-]?key|authorization|password|secret|token)=)[^&\s]+/giu, '$1REDACTED')
  const cleaned = [...normalized].map((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('').trim()
  return cleaned ? cleaned.slice(0, maxLength) : fallback
}

function safeVersion(value: unknown, fallback = 'unknown'): string {
  return safeString(value, fallback, MAX_IDENTIFIER_CHARS)
}

function safeNumber(value: unknown, minimum: number, maximum: number, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, number))
}

function safeInteger(value: unknown, minimum: number, maximum: number, fallback = 0): number {
  return Math.round(safeNumber(value, minimum, maximum, fallback))
}

function safeOptionalBytes(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  return safeInteger(value, 0, Number.MAX_SAFE_INTEGER)
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function safeTimestamp(value: unknown, fallback: Date = nowDate()): string {
  return validTimestamp(value) ? new Date(value).toISOString() : fallback.toISOString()
}

function normalizeRuntimeKind(value: unknown): BenchmarkRuntimeKind {
  return value === 'browser' || value === 'native' || value === 'sidecar' ? value : 'unknown'
}

export function createBenchmarkIdentity(input: BenchmarkIdentityInput = {}): BenchmarkIdentity {
  return {
    engineId: safeString(input.engineId, 'unknown'),
    modelId: safeString(input.modelId, 'unknown'),
    modelRevision: safeVersion(input.modelRevision),
    runtimeKind: normalizeRuntimeKind(input.runtimeKind),
    runtimeLabel: safeString(input.runtimeLabel, 'unknown'),
    ...(input.runtimeRevision ? { runtimeRevision: safeVersion(input.runtimeRevision) } : {}),
  }
}

function normalizeMemory(value: unknown): BenchmarkMemoryObservation {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const used = safeOptionalBytes(candidate.jsHeapUsedBytes)
  const total = safeOptionalBytes(candidate.jsHeapTotalBytes)
  const limit = safeOptionalBytes(candidate.jsHeapLimitBytes)
  return {
    supported: candidate.supported === true,
    deviceMemoryGb: candidate.deviceMemoryGb == null ? null : rounded(safeNumber(candidate.deviceMemoryGb, 0, 1024)),
    ...(used === undefined ? {} : { jsHeapUsedBytes: used }),
    ...(total === undefined ? {} : { jsHeapTotalBytes: total }),
    ...(limit === undefined ? {} : { jsHeapLimitBytes: limit }),
  }
}

function normalizeQuota(value: unknown): BenchmarkQuotaObservation {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const usageBytes = safeOptionalBytes(candidate.usageBytes)
  const quotaBytes = safeOptionalBytes(candidate.quotaBytes)
  const usagePct = usageBytes !== undefined && quotaBytes !== undefined && quotaBytes > 0
    ? rounded(Math.min(100, Math.max(0, (usageBytes / quotaBytes) * 100)))
    : candidate.usagePct == null ? undefined : rounded(safeNumber(candidate.usagePct, 0, 100))
  return {
    supported: candidate.supported === true,
    persisted: typeof candidate.persisted === 'boolean' ? candidate.persisted : null,
    ...(usageBytes === undefined ? {} : { usageBytes }),
    ...(quotaBytes === undefined ? {} : { quotaBytes }),
    ...(usagePct === undefined ? {} : { usagePct }),
  }
}

function normalizeResources(value: unknown): BenchmarkResourceSnapshot {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    memory: normalizeMemory(candidate.memory),
    quota: normalizeQuota(candidate.quota),
  }
}

export function createBenchmarkObservation(input: BenchmarkObservationInput, now: Date = nowDate()): BenchmarkObservation {
  const elapsedMs = rounded(safeNumber(input.elapsedMs, 0, 24 * 60 * 60 * 1000))
  const audioDurationSeconds = rounded(safeNumber(input.audioDurationSeconds, 0, 24 * 60 * 60))
  const inputChars = safeInteger(input.inputChars, 0, MAX_INPUT_CHARS)
  const elapsedSeconds = elapsedMs / 1000
  const firstAudioLatencyMs = input.firstAudioLatencyMs == null
    ? null
    : rounded(safeNumber(input.firstAudioLatencyMs, 0, elapsedMs > 0 ? elapsedMs : 24 * 60 * 60 * 1000))
  return {
    id: safeString(input.id, `benchmark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 100),
    recordedAt: safeTimestamp(input.recordedAt, now),
    identity: createBenchmarkIdentity(input.identity),
    metrics: {
      elapsedMs,
      firstAudioLatencyMs,
      audioDurationSeconds,
      inputChars,
      throughputCharsPerSecond: elapsedSeconds > 0 ? rounded(inputChars / elapsedSeconds) : 0,
      realtimeFactor: elapsedSeconds > 0 ? rounded(audioDurationSeconds / elapsedSeconds) : 0,
    },
    reliability: {
      outcome: input.outcome === 'completed' || input.outcome === 'cancelled' ? input.outcome : 'failed',
      retryCount: safeInteger(input.retryCount, 0, 10_000),
      failureCount: safeInteger(input.failureCount, 0, 10_000),
    },
    resources: normalizeResources(input.resources),
  }
}

export function emptyBenchmarkReport(now: Date = nowDate()): BenchmarkReport {
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    localOnly: true,
    generatedAt: now.toISOString(),
    observations: [],
  }
}

function normalizeReport(value: unknown): BenchmarkReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyBenchmarkReport()
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== BENCHMARK_SCHEMA_VERSION || candidate.localOnly !== true || !Array.isArray(candidate.observations)) return emptyBenchmarkReport()
  const observations = candidate.observations
    .map((entry) => normalizeStoredObservation(entry))
    .filter((entry): entry is BenchmarkObservation => entry !== null)
    .slice(-MAX_BENCHMARK_OBSERVATIONS)
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    localOnly: true,
    generatedAt: safeTimestamp(candidate.generatedAt),
    observations,
  }
}

function normalizeStoredObservation(value: unknown): BenchmarkObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const identity = candidate.identity && typeof candidate.identity === 'object' && !Array.isArray(candidate.identity)
    ? candidate.identity as Record<string, unknown>
    : {}
  const metrics = candidate.metrics && typeof candidate.metrics === 'object' && !Array.isArray(candidate.metrics)
    ? candidate.metrics as Record<string, unknown>
    : {}
  const reliability = candidate.reliability && typeof candidate.reliability === 'object' && !Array.isArray(candidate.reliability)
    ? candidate.reliability as Record<string, unknown>
    : {}
  if (typeof candidate.id !== 'string' || !validTimestamp(candidate.recordedAt) || typeof metrics.inputChars !== 'number' || typeof metrics.elapsedMs !== 'number') return null
  return createBenchmarkObservation({
    id: candidate.id,
    recordedAt: candidate.recordedAt,
    identity: {
      engineId: identity.engineId as string,
      modelId: identity.modelId as string,
      modelRevision: identity.modelRevision as string,
      runtimeKind: identity.runtimeKind as BenchmarkRuntimeKind,
      runtimeLabel: identity.runtimeLabel as string,
      runtimeRevision: identity.runtimeRevision as string,
    },
    elapsedMs: metrics.elapsedMs,
    firstAudioLatencyMs: metrics.firstAudioLatencyMs == null ? null : Number(metrics.firstAudioLatencyMs),
    audioDurationSeconds: Number(metrics.audioDurationSeconds),
    inputChars: metrics.inputChars,
    outcome: reliability.outcome === 'completed' || reliability.outcome === 'cancelled' ? reliability.outcome : 'failed',
    retryCount: Number(reliability.retryCount),
    failureCount: Number(reliability.failureCount),
    resources: normalizeResources(candidate.resources),
  })
}

export function readBenchmarkReport(storage: BenchmarkStorage | undefined = defaultStorage()): BenchmarkReport {
  if (!storage) return emptyBenchmarkReport()
  try {
    const raw = storage.getItem(BENCHMARK_STORAGE_KEY)
    if (!raw || raw.length > MAX_BENCHMARK_REPORT_BYTES) return emptyBenchmarkReport()
    return normalizeReport(JSON.parse(raw))
  } catch {
    return emptyBenchmarkReport()
  }
}

export async function captureBenchmarkResources(probes: BenchmarkResourceProbes = {}): Promise<BenchmarkResourceSnapshot> {
  const navigatorLike: BenchmarkResourceProbes['navigator'] = probes.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator as unknown as BenchmarkResourceProbes['navigator'])
  const performanceLike = probes.performance ?? (typeof performance === 'undefined' ? undefined : performance as unknown as BenchmarkResourceProbes['performance'])
  const memory = performanceLike?.memory
  const memorySupported = memory != null || typeof navigatorLike?.deviceMemory === 'number'
  const memorySnapshot = normalizeMemory({
    supported: memorySupported,
    deviceMemoryGb: navigatorLike?.deviceMemory,
    jsHeapUsedBytes: memory?.usedJSHeapSize,
    jsHeapTotalBytes: memory?.totalJSHeapSize,
    jsHeapLimitBytes: memory?.jsHeapSizeLimit,
  })

  const storage = navigatorLike?.storage
  if (!storage?.estimate) return { memory: memorySnapshot, quota: normalizeQuota({ supported: false }) }
  try {
    const [estimate, persisted] = await Promise.all([
      storage.estimate(),
      storage.persisted?.() ?? Promise.resolve(null),
    ])
    return {
      memory: memorySnapshot,
      quota: normalizeQuota({
        supported: true,
        persisted,
        usageBytes: estimate.usage,
        quotaBytes: estimate.quota,
      }),
    }
  } catch {
    return { memory: memorySnapshot, quota: normalizeQuota({ supported: true }) }
  }
}

export async function appendBenchmarkObservation(
  input: BenchmarkObservationInput,
  storage: BenchmarkStorage | undefined = defaultStorage(),
  probes: BenchmarkResourceProbes = {},
): Promise<BenchmarkAppendResult> {
  const resources = input.resources ?? await captureBenchmarkResources(probes)
  const observation = createBenchmarkObservation({ ...input, resources })
  const previous = readBenchmarkReport(storage)
  const report = {
    ...previous,
    generatedAt: new Date().toISOString(),
    observations: [...previous.observations, observation].slice(-MAX_BENCHMARK_OBSERVATIONS),
  } satisfies BenchmarkReport
  if (!storage) return { report, observation, persisted: false, error: 'Local storage is unavailable.' }
  try {
    const serialized = exportBenchmarkJson(report)
    if (serialized.length > MAX_BENCHMARK_REPORT_BYTES) throw new Error('Benchmark history reached its local size limit.')
    storage.setItem(BENCHMARK_STORAGE_KEY, serialized)
    return { report, observation, persisted: true }
  } catch (error) {
    return { report, observation, persisted: false, error: safeString(error, 'Could not persist benchmark history.') }
  }
}

export function clearBenchmarkReport(storage: BenchmarkStorage | undefined = defaultStorage()): boolean {
  if (!storage) return false
  try {
    storage.removeItem(BENCHMARK_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

export function exportBenchmarkJson(report: BenchmarkReport): string {
  return `${JSON.stringify(normalizeReport(report), null, 2)}\n`
}
