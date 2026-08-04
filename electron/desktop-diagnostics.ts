import { arch, platform, release } from 'node:os'
import type { DesktopDiagnosticsSnapshot, DesktopLogEntry } from '../src/lib/desktop-diagnostics.ts'

const MAX_LOGS = 100
const MAX_TEXT = 240
const desktopLogs: DesktopLogEntry[] = []

export type DesktopDiagnosticsContext = {
  appVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  packaged: boolean
  userDataPath: string
  resourcesPath: string
  modelCachePath: string
  nativeManifests: Record<string, unknown>
  ffmpeg: unknown
}

export type DesktopDiagnosticsRequest = {
  selection?: unknown
  generation?: unknown
  runtime?: unknown
}

export function recordDesktopLog(level: DesktopLogEntry['level'], source: unknown, message: unknown, now = new Date()): void {
  const safeSource = sanitizeDesktopText(source).slice(0, 80)
  desktopLogs.push({
    time: now.toISOString(),
    level,
    source: safeSource,
    message: sanitizeDesktopLogMessage(message, safeSource),
  })
  if (desktopLogs.length > MAX_LOGS) desktopLogs.splice(0, desktopLogs.length - MAX_LOGS)
}

export function getDesktopLogs(): DesktopLogEntry[] {
  return desktopLogs.map((entry) => ({ ...entry }))
}

export function clearDesktopLogs(): void {
  desktopLogs.splice(0, desktopLogs.length)
}

export function sanitizeDesktopText(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? '')
  return raw
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 REDACTED')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd)=)[^&\s]+/gi, '$1REDACTED')
    .replace(/([?&](?:key|token|secret|password)=)[^&\s]+/gi, '$1REDACTED')
    .replace(/(?<![A-Za-z])(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp)\/)[^\r\n"'<>|?*]+/gu, '<path>')
    .replace(/\r?\n/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_TEXT)
}

function text(value: unknown, fallback = 'unknown'): string {
  const result = sanitizeDesktopText(value)
  return result || fallback
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function hasRecord(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeDesktopLogMessage(value: unknown, source: string): string {
  const message = sanitizeDesktopText(value)
  if (source === 'subtitle.revoice.missing-audio') return 'Subtitle audio was missing for one cue.'
  if (/^(?:article|subtitle)\./u.test(source)) return message.replace(/\bhttps?:\/\/[^\s<>"']+/giu, '<url>')
  return message
}

function runtimeSummary(value: unknown): Record<string, unknown> {
  const candidate = record(value)
  return {
    ...(bool(candidate.available) === undefined ? {} : { available: candidate.available }),
    ...(bool(candidate.modelReady) === undefined ? {} : { modelReady: candidate.modelReady }),
    ...(bool(candidate.qwenInstalled) === undefined ? {} : { qwenInstalled: candidate.qwenInstalled }),
    ...(bool(candidate.torchInstalled) === undefined ? {} : { torchInstalled: candidate.torchInstalled }),
    ...(bool(candidate.rvcInstalled) === undefined ? {} : { rvcInstalled: candidate.rvcInstalled }),
    ...(bool(record(candidate.nativeAddon).present) === undefined ? {} : { nativeAddonPresent: record(candidate.nativeAddon).present }),
    ...(candidate.runtime ? { runtime: text(candidate.runtime) } : {}),
    ...(candidate.pythonVersion ? { pythonVersion: text(candidate.pythonVersion) } : {}),
    ...(candidate.sherpaVersion ? { sherpaVersion: text(candidate.sherpaVersion) } : {}),
    ...(candidate.ortVersion ? { ortVersion: text(candidate.ortVersion) } : {}),
    ...(candidate.version ? { version: text(candidate.version) } : {}),
    ...(candidate.message ? { message: text(candidate.message) } : {}),
    ...(candidate.recovery ? { recovery: text(candidate.recovery) } : {}),
    ...(candidate.modelId ? { modelId: text(candidate.modelId) } : {}),
    ...(candidate.modelCacheDir ? { modelCacheDir: text(candidate.modelCacheDir) } : {}),
    ...(candidate.pythonPath ? { pythonPath: text(candidate.pythonPath) } : {}),
    ...(candidate.cliPath ? { cliPath: text(candidate.cliPath) } : {}),
  }
}

function selectionSummary(value: unknown, manifests: Record<string, unknown>): DesktopDiagnosticsSnapshot['selection'] {
  const candidate = record(value)
  const engine = text(candidate.engine)
  const routes = record(candidate.modelRoutes)
  const modelRoutes = Object.fromEntries(
    Object.entries(routes)
      .filter(([, route]) => typeof route === 'string')
      .slice(0, 32)
      .map(([key, route]) => [sanitizeDesktopText(key).slice(0, 80), sanitizeDesktopRoute(route as string)]),
  )
  const manifest = manifests[engine]
  const selectedModelText = text(candidate.selectedModel, '')
  const knownModel = Object.values(modelRoutes)
    .filter((route) => !/^<url>$/u.test(route) && !/^<path>$/u.test(route))
    .find((route) => route.length > 0 && selectedModelText.includes(route))
  return {
    engine,
    provider: engine === 'qwen' ? 'Qwen3-TTS Python sidecar' : engine === 'melo' ? 'MeloTTS Sherpa-ONNX' : engine === 'piper' ? 'Piper-plus Sherpa-ONNX' : engine === 'kokoro' ? 'Kokoro Sherpa-ONNX or browser runtime' : 'Browser runtime',
    engineStatus: text(candidate.engineStatus),
    runtime: text(candidate.runtime),
    selectedModel: knownModel ?? `${engine} runtime`,
    modelManifest: manifest ? summarizeManifest(manifest) : { status: engine === 'qwen' ? 'sidecar-managed' : 'not-selected' },
    modelRoutes,
  }
}

function summarizeManifest(value: unknown): Record<string, unknown> {
  const candidate = record(value)
  const files = Array.isArray(candidate.files) ? candidate.files.length : undefined
  const status = typeof candidate.error === 'string'
    ? 'probe-failed'
    : candidate.verified === true
      ? 'verified'
      : candidate.installed === true
        ? 'installed-unverified'
        : 'not-installed'
  return {
    status,
    ...(candidate.id ? { id: text(candidate.id) } : {}),
    ...(candidate.modelId ? { modelId: text(candidate.modelId) } : {}),
    ...(candidate.revision ? { revision: text(candidate.revision) } : {}),
    ...(bool(candidate.installed) === undefined ? {} : { installed: candidate.installed }),
    ...(bool(candidate.verified) === undefined ? {} : { verified: candidate.verified }),
    ...(number(candidate.totalBytes) === undefined ? {} : { totalBytes: candidate.totalBytes }),
    ...(number(candidate.expectedBytes) === undefined ? {} : { expectedBytes: candidate.expectedBytes }),
    ...(files === undefined ? {} : { files }),
    ...(candidate.blockedReason ? { blockedReason: text(candidate.blockedReason) } : {}),
    ...(candidate.error ? { error: text(candidate.error) } : {}),
  }
}

function sanitizeDesktopRoute(value: string): string {
  const safe = sanitizeDesktopText(value)
  try {
    const url = new URL(safe)
    if (!['http:', 'https:'].includes(url.protocol)) return '<url>'
    if (!['huggingface.co', 'github.com', 'raw.githubusercontent.com'].includes(url.hostname.toLowerCase())) return '<url>'
    url.search = ''
    url.hash = ''
    return url.toString().slice(0, MAX_TEXT)
  } catch {
    return safe
  }
}

function pathLabel(value: string, root: string, label: string): string {
  const normalizedValue = value.replaceAll('\\', '/').replace(/\/+$/u, '')
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/u, '')
  if (normalizedValue.toLowerCase() === normalizedRoot.toLowerCase()) return label
  if (normalizedValue.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return `${label}/${normalizedValue.slice(normalizedRoot.length + 1)}`.replaceAll('\\', '/')
  }
  return '<path>'
}

export function buildDesktopDiagnostics(
  request: DesktopDiagnosticsRequest,
  context: DesktopDiagnosticsContext,
): DesktopDiagnosticsSnapshot {
  const runtime = record(request.runtime)
  const native = record(runtime.native)
  const paths = {
    userData: '<user-data>',
    project: '<renderer-managed>',
    modelCache: pathLabel(context.modelCachePath, context.userDataPath, '<user-data>'),
    resources: pathLabel(context.resourcesPath, context.resourcesPath, '<resources>'),
  }
  return {
    schemaVersion: 1,
    app: {
      version: text(context.appVersion),
      platform: platform(),
      arch: arch(),
       osRelease: text(release()),
      electron: text(context.electronVersion),
      chrome: text(context.chromeVersion),
      node: text(context.nodeVersion),
      packaged: context.packaged,
    },
    selection: selectionSummary(request.selection, context.nativeManifests),
    generation: request.generation && typeof request.generation === 'object' ? {
      engine: text(record(request.generation).engine),
      runtime: text(record(request.generation).runtime),
      elapsedMs: number(record(request.generation).elapsedMs) ?? 0,
      timeToFirstAudioMs: number(record(request.generation).timeToFirstAudioMs) ?? null,
      audioDurationSeconds: number(record(request.generation).audioDurationSeconds) ?? 0,
      chars: number(record(request.generation).chars) ?? 0,
    } : null,
    runtimes: {
      native: hasRecord(runtime.native) ? runtimeSummary(native) : { status: 'not-started' },
      qwen: runtimeSummary(runtime.qwen),
      whisper: runtimeSummary(runtime.whisper),
      rvc: runtimeSummary(runtime.rvc),
    },
    ffmpeg: runtimeSummary(context.ffmpeg),
    paths,
    recentLogs: getDesktopLogs(),
  }
}
