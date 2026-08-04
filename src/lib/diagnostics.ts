import { opusSupported } from './encode.ts'
import type { M4bCapability } from './m4b.ts'
import { readModelCacheStatus, type ModelCacheSummary } from './model-cache.ts'
import { getPersistenceOutcome, type PersistenceOutcome } from './persistence.ts'
import { piperPlusRuntimeSupport, type PiperPlusRuntimeSupport } from './piper-plus.ts'
import {
  denylistWebGpuAdapter,
  detectCrossOriginStorage,
  probeWebGpuCapability,
  transformersUpgradeReadiness,
  type CrossOriginStorageStatus,
  type TransformersUpgradeReadiness,
  type WebGpuAdapterInfo,
} from './runtime-readiness.ts'
import type { DesktopDiagnosticsSnapshot } from './desktop-diagnostics.ts'

export type { DesktopDiagnosticsSnapshot, DesktopLogEntry } from './desktop-diagnostics.ts'

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
  webGpuDtype?: string
  voice: string
  language?: string
  format: string
  bitrate: number
  speed: number
  selectedModel: string
  modelRoutes: Record<string, string>
}

export type GenerationDiagnostics = {
  engine: string
  runtime: string
  elapsedMs: number
  timeToFirstAudioMs: number | null
  audioDurationSeconds: number
  chars: number
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
  usable: boolean
  denylisted: boolean
  status: string
  adapterInfo?: WebGpuAdapterInfo
  adapterKey?: string
  denylistReason?: string
  error?: string
}

export type DiagnosticsBundle = {
  schemaVersion: 3
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
  generation: GenerationDiagnostics | null
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
    coordination: {
      broadcastChannel: boolean
      webLocks: boolean
      fallback: 'indexedDB'
    }
    persistence: PersistenceOutcome
  }
  storage: {
    browser: StorageDiagnostics
    cache: ModelCacheSummary & { error?: string }
  }
  recentEvents: DiagnosticEvent[]
  desktop?: DesktopDiagnosticsSnapshot
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

export type WebGpuBadAudioReport = {
  recorded: boolean
  capability: WebGpuDiagnostics
  message: string
}

const MAX_EVENTS = 20
const recentEvents: DiagnosticEvent[] = []
let captureInstalled = false

export function recordDiagnosticEvent(level: DiagnosticLevel, message: unknown, source = 'app', now = new Date()): void {
  const safeSource = sanitizeDiagnosticText(source).slice(0, 80)
  recentEvents.push({
    time: now.toISOString(),
    level,
    source: safeSource,
    message: sanitizeDiagnosticEventText(message, safeSource),
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
    generation?: GenerationDiagnostics
    desktop?: DesktopDiagnosticsSnapshot
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
      usable: false,
      denylisted: false,
      status: 'WebGPU probe failed',
    }),
    readSafely(probes.storage ?? readStorageDiagnostics, { supported: false }),
    readSafely(probes.cache ?? readModelCacheStatus, {
      supported: false,
      engines: [],
      totalBytes: 0,
      unknownSizeCount: 0,
    }),
    readSafely(probes.m4b ?? (() => import('./m4b.ts').then(({ checkM4bCapability }) => checkM4bCapability())), {
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
  const desktop = input.desktop ?? (typeof window === 'undefined'
    ? undefined
    : await window.betterttsPlatform?.desktopDiagnostics?.collect({ selection: input.selection }))

  return {
    schemaVersion: 3,
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
    generation: input.generation ?? null,
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
      coordination: {
        broadcastChannel: typeof BroadcastChannel !== 'undefined',
        webLocks: typeof navigator !== 'undefined' && Boolean(navigator.locks?.request),
        fallback: 'indexedDB',
      },
      persistence: getPersistenceOutcome(),
    },
    storage: {
      browser: storage,
      cache,
    },
    recentEvents: probes.recentEvents?.() ?? getRecentDiagnosticEvents(),
    ...(desktop ? { desktop } : {}),
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
  const result = await probeWebGpuCapability()
  return {
    supported: result.supported,
    adapterAvailable: result.adapterAvailable,
    usable: result.usable,
    denylisted: result.denylisted,
    status: result.status,
    adapterInfo: result.adapterInfo,
    adapterKey: result.adapterKey,
    denylistReason: result.denylistReason,
    error: result.error ? sanitizeDiagnosticText(result.error) : undefined,
  }
}

export async function reportWebGpuBadAudio(
  reason = 'User reported corrupted or unusable WebGPU audio.',
): Promise<WebGpuBadAudioReport> {
  const before = await readWebGpuDiagnostics()
  if (!before.adapterAvailable || !before.adapterKey) {
    const message = 'No identifiable WebGPU adapter is available to report in this session.'
    recordDiagnosticEvent('warn', message, 'webgpu.bad-audio')
    return { recorded: false, capability: before, message }
  }

  const recorded = denylistWebGpuAdapter(before.adapterKey, before.adapterInfo, reason)
  const capability = await readWebGpuDiagnostics()
  const adapterLabel = formatAdapterInfo(before.adapterInfo) || before.adapterKey
  const message = recorded
    ? `WebGPU audio issue recorded for ${adapterLabel}. Kokoro will use WASM q8 on this adapter until the report is cleared.`
    : 'Could not store the WebGPU adapter report; WASM fallback remains available for this session.'
  recordDiagnosticEvent(recorded ? 'warn' : 'error', `${message} ${reason}`, 'webgpu.bad-audio')
  return { recorded, capability, message }
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

function sanitizeDiagnosticEventText(value: unknown, source: string): string {
  const text = sanitizeDiagnosticText(value)
  if (source === 'subtitle.revoice.missing-audio') return 'Subtitle audio was missing for one cue.'
  if (/^(?:article|subtitle)\./u.test(source)) {
    return text
      .replace(/\bhttps?:\/\/[^\s<>"']+/giu, '<url>')
      .replace(/(?<![A-Za-z])(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp)\/)[^\s<>"']+/gu, '<path>')
  }
  return text
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

function formatAdapterInfo(info: WebGpuAdapterInfo | undefined): string {
  if (!info) return ''
  return Object.entries(info)
    .filter(([, value]) => value != null && String(value).trim().length > 0)
    .map(([key, value]) => `${key}=${String(value).slice(0, 120)}`)
    .join(', ')
}
