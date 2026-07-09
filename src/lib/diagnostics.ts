import { opusSupported } from './encode.ts'
import { checkM4bCapability, type M4bCapability } from './m4b.ts'
import { readModelCacheStatus, type ModelCacheSummary } from './model-cache.ts'
import { piperPlusRuntimeSupport, type PiperPlusRuntimeSupport } from './piper-plus.ts'
import {
  detectCrossOriginStorage,
  transformersUpgradeReadiness,
  type CrossOriginStorageStatus,
  type TransformersUpgradeReadiness,
} from './runtime-readiness.ts'

export type DiagnosticLevel = 'warn' | 'error'

export type DiagnosticEvent = {
  time: string
  level: DiagnosticLevel
  source: string
  message: string
}

export type DiagnosticsSelection = {
  engine: string
  engineStatus: string
  runtime: string
  voice: string
  language?: string
  format: string
  bitrate: number
  speed: number
  selectedModel: string
  modelRoutes: Record<string, string>
}

export type StorageDiagnostics = {
  supported: boolean
  persisted?: boolean
  usageBytes?: number
  quotaBytes?: number
  usagePct?: number
  error?: string
}

export type WebGpuDiagnostics = {
  supported: boolean
  adapterAvailable: boolean
  status: string
  adapterInfo?: Record<string, string | number | boolean | null>
  error?: string
}

export type DiagnosticsBundle = {
  schemaVersion: 1
  generatedAt: string
  app: {
    name: 'BetterTTS'
    version: string
    location: string
  }
  browser: {
    userAgent: string
    platform: string
    language: string
    languages: string[]
    online: boolean | null
    secureContext: boolean
    hardwareConcurrency: number | null
    deviceMemoryGb: number | null
  }
  selection: DiagnosticsSelection
  capabilities: {
    webGpu: WebGpuDiagnostics
    webCodecs: {
      audioEncoder: boolean
      audioData: boolean
      opus: boolean
      aacM4b: M4bCapability
    }
    crossOriginStorage: CrossOriginStorageStatus
    transformers: TransformersUpgradeReadiness
    piperPlus: PiperPlusRuntimeSupport
  }
  storage: {
    browser: StorageDiagnostics
    cache: ModelCacheSummary & { error?: string }
  }
  recentEvents: DiagnosticEvent[]
}

type NavigatorDiagnosticsLike = {
  deviceMemory?: number
  hardwareConcurrency?: number
  language?: string
  languages?: readonly string[]
  onLine?: boolean
  platform?: string
  storage?: StorageManager
  userAgent?: string
  crossOriginStorage?: unknown
}

export type DiagnosticsProbes = {
  now?: () => Date
  navigator?: NavigatorDiagnosticsLike
  location?: Pick<Location, 'href'>
  webGpu?: () => Promise<WebGpuDiagnostics>
  storage?: () => Promise<StorageDiagnostics>
  cache?: () => Promise<ModelCacheSummary>
  m4b?: () => Promise<M4bCapability>
  opus?: () => boolean
  crossOriginStorage?: () => CrossOriginStorageStatus
  transformers?: () => TransformersUpgradeReadiness
  piperPlus?: () => PiperPlusRuntimeSupport
  recentEvents?: () => DiagnosticEvent[]
}

const MAX_EVENTS = 20
const recentEvents: DiagnosticEvent[] = []
let captureInstalled = false

export function recordDiagnosticEvent(level: DiagnosticLevel, message: unknown, source = 'app', now = new Date()): void {
  recentEvents.push({
    time: now.toISOString(),
    level,
    source: sanitizeDiagnosticText(source).slice(0, 80),
    message: sanitizeDiagnosticText(message),
  })
  if (recentEvents.length > MAX_EVENTS) recentEvents.splice(0, recentEvents.length - MAX_EVENTS)
}

export function getRecentDiagnosticEvents(): DiagnosticEvent[] {
  return recentEvents.map((event) => ({ ...event }))
}

export function clearDiagnosticEvents(): void {
  recentEvents.splice(0, recentEvents.length)
}

export function installGlobalDiagnosticsCapture(): () => void {
  if (captureInstalled || typeof window === 'undefined') return () => {}
  captureInstalled = true

  const onError = (event: ErrorEvent) => {
    recordDiagnosticEvent('error', event.message || event.error || 'Unhandled window error', 'window.error')
  }
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    recordDiagnosticEvent('error', event.reason ?? 'Unhandled promise rejection', 'window.unhandledrejection')
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onUnhandledRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
    captureInstalled = false
  }
}

export async function collectDiagnostics(
  input: {
    appVersion: string
    selection: DiagnosticsSelection
  },
  probes: DiagnosticsProbes = {},
): Promise<DiagnosticsBundle> {
  const now = probes.now?.() ?? new Date()
  const navigatorLike: NavigatorDiagnosticsLike | undefined =
    probes.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator as NavigatorDiagnosticsLike)
  const locationLike = probes.location ?? (typeof location === 'undefined' ? undefined : location)

  const [webGpu, storage, cache, m4b] = await Promise.all([
    readSafely(probes.webGpu ?? readWebGpuDiagnostics, {
      supported: false,
      adapterAvailable: false,
      status: 'WebGPU probe failed',
    }),
    readSafely(probes.storage ?? readStorageDiagnostics, { supported: false }),
    readSafely(probes.cache ?? readModelCacheStatus, {
      supported: false,
      engines: [],
      totalBytes: 0,
      unknownSizeCount: 0,
    }),
    readSafely(probes.m4b ?? checkM4bCapability, {
      supported: false,
      reason: 'check-failed',
      message: 'Could not verify M4B AAC support.',
    } satisfies M4bCapability),
  ])
  const crossOriginStorage = readSyncSafely(
    probes.crossOriginStorage ?? (() => detectCrossOriginStorage({ navigator: navigatorLike, secureContext: typeof isSecureContext === 'boolean' ? isSecureContext : null })),
    {
      api: 'navigator.crossOriginStorage',
      exposed: false,
      requestFileHandle: false,
      secureContext: null,
      usable: false,
      defaultBehavior: 'disabled',
      message: 'Could not verify Cross-Origin Storage support.',
    } satisfies CrossOriginStorageStatus,
  )
  const transformers = readSyncSafely(probes.transformers ?? transformersUpgradeReadiness, {
    currentVersion: 'unknown',
    targetVersion: '4.3.0',
    readyToSwitch: false,
    criteria: [],
  } satisfies TransformersUpgradeReadiness)
  const piperPlus = readSyncSafely(probes.piperPlus ?? piperPlusRuntimeSupport, {
    packageVersion: 'unknown',
    model: 'unknown',
    modelLabel: 'unknown',
    supported: false,
    wasm: false,
    indexedDb: false,
    webGpu: false,
    defaultFirstLoad: false,
    notes: ['Could not verify Piper-plus runtime support.'],
  } satisfies PiperPlusRuntimeSupport)

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    app: {
      name: 'BetterTTS',
      version: input.appVersion,
      location: sanitizeDiagnosticLocation(locationLike?.href),
    },
    browser: {
      userAgent: navigatorLike?.userAgent ?? 'unknown',
      platform: navigatorLike?.platform ?? 'unknown',
      language: navigatorLike?.language ?? 'unknown',
      languages: Array.from(navigatorLike?.languages ?? []),
      online: typeof navigatorLike?.onLine === 'boolean' ? navigatorLike.onLine : null,
      secureContext: typeof isSecureContext === 'boolean' ? isSecureContext : false,
      hardwareConcurrency: navigatorLike?.hardwareConcurrency ?? null,
      deviceMemoryGb: navigatorLike?.deviceMemory ?? null,
    },
    selection: input.selection,
    capabilities: {
      webGpu,
      webCodecs: {
        audioEncoder: typeof AudioEncoder !== 'undefined',
        audioData: typeof AudioData !== 'undefined',
        opus: readBooleanSafely(probes.opus ?? opusSupported),
        aacM4b: m4b,
      },
      crossOriginStorage,
      transformers,
      piperPlus,
    },
    storage: {
      browser: storage,
      cache,
    },
    recentEvents: probes.recentEvents?.() ?? getRecentDiagnosticEvents(),
  }
}

export async function readStorageDiagnostics(): Promise<StorageDiagnostics> {
  if (typeof navigator === 'undefined' || !navigator.storage) return { supported: false }
  try {
    const [estimate, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted?.() ?? Promise.resolve(undefined),
    ])
    const usageBytes = estimate.usage
    const quotaBytes = estimate.quota
    return {
      supported: true,
      persisted,
      usageBytes,
      quotaBytes,
      usagePct: usageBytes != null && quotaBytes != null && quotaBytes > 0
        ? Math.round((usageBytes / quotaBytes) * 1000) / 10
        : undefined,
    }
  } catch (err) {
    return { supported: true, error: sanitizeDiagnosticText(err) }
  }
}

export async function readWebGpuDiagnostics(): Promise<WebGpuDiagnostics> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return { supported: false, adapterAvailable: false, status: 'navigator.gpu unavailable' }
  }

  try {
    const gpu = navigator.gpu as { requestAdapter(): Promise<unknown | null> }
    const adapter = await gpu.requestAdapter()
    if (!adapter) return { supported: true, adapterAvailable: false, status: 'no adapter available' }
    return {
      supported: true,
      adapterAvailable: true,
      status: 'adapter available',
      adapterInfo: readAdapterInfo(adapter),
    }
  } catch (err) {
    return {
      supported: true,
      adapterAvailable: false,
      status: 'adapter probe failed',
      error: sanitizeDiagnosticText(err),
    }
  }
}

export function sanitizeDiagnosticText(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? '')
  return raw
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 REDACTED')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd)=)[^&\s]+/gi, '$1REDACTED')
    .replace(/([?&](?:key|token|secret|password)=)[^&\s]+/gi, '$1REDACTED')
    .replace(/(\/(?:api[_-]?key|token|secret|password|passwd|pwd)\/)[^/?#\s]+/gi, '$1REDACTED')
    .slice(0, 700)
}

export function sanitizeDiagnosticLocation(href: string | undefined): string {
  if (!href) return 'unknown'
  try {
    const url = new URL(href)
    url.search = ''
    url.hash = ''
    return sanitizeDiagnosticText(url.toString())
  } catch {
    return sanitizeDiagnosticText(href).replace(/[?#].*$/, '') || 'unknown'
  }
}

async function readSafely<T extends object>(reader: () => Promise<T>, fallback: T): Promise<T & { error?: string }> {
  try {
    return await reader() as T & { error?: string }
  } catch (err) {
    return { ...fallback, error: sanitizeDiagnosticText(err) }
  }
}

function readBooleanSafely(reader: () => boolean): boolean {
  try {
    return reader()
  } catch {
    return false
  }
}

function readSyncSafely<T extends object>(reader: () => T, fallback: T): T & { error?: string } {
  try {
    return reader() as T & { error?: string }
  } catch (err) {
    return { ...fallback, error: sanitizeDiagnosticText(err) }
  }
}

function readAdapterInfo(adapter: unknown): Record<string, string | number | boolean | null> | undefined {
  const info = (adapter as { info?: unknown }).info
  if (!info || typeof info !== 'object') return undefined
  const entries = Object.entries(info as Record<string, unknown>)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value) || value == null)
    .map(([key, value]) => [key, value as string | number | boolean | null])
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}
