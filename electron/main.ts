import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, protocol, screen, session, shell, Tray, utilityProcess } from 'electron'
import type { UtilityProcess, WebContents } from 'electron'
import { autoUpdater } from 'electron-updater'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  ProjectConflictError,
  readProjectSnapshot,
  writeProjectFile,
} from './project-files.mjs'
import { buildM4bAudiobook, probeFfmpeg, transcodePcm } from './ffmpeg.mjs'
import { getByoModelOption } from '../src/lib/byo-models.ts'
import { encodeWav } from '../src/lib/wav.ts'
import { BYO_WEIGHTS_CHANNEL, validateByoWeightsRequest } from './byo-ipc.ts'
import { validateNativeTtsRequest } from './native-ipc.ts'
import { NATIVE_CANCEL_GRACE_MS, startNativeGenerationWatchdog, validateNativePcm } from './native-tts-runtime.ts'
import { OPENAI_TTS_CHANNEL, validateOpenAiTtsRequest } from './openai-ipc.ts'
import { createOpenAiTtsServer, type OpenAiSpeechRequest } from './openai-server.ts'
import { RVC_CHANNEL, RVC_WEIGHTS_CHANNEL, validateRvcRequest, validateRvcWeightsRequest } from './rvc-ipc.ts'
import { SIDECAR_CHANNEL, validateSidecarRequest } from './sidecar-ipc.ts'
import { WHISPER_CHANNEL, validateWhisperRequest } from './whisper-ipc.ts'
import { resolveRendererRequest } from './app-protocol.ts'
import { resolveSmokeOutputDirectory } from './smoke-output.ts'
import { buildDesktopDiagnostics, recordDesktopLog, type DesktopDiagnosticsRequest } from './desktop-diagnostics.ts'
import { readSherpaPackStatus, SHERPA_KOKORO_PACK, SHERPA_MELO_PACK, SHERPA_PIPER_PACK, type SherpaModelPack } from './sherpa-models.ts'
import {
  DEFAULT_DESKTOP_INTEGRATIONS,
  DESKTOP_INTEGRATION_HOTKEY,
  MAX_FOLDER_IMPORT_BYTES,
  MAX_FOLDER_IMPORT_FILES,
  associationRegistrySubkeys,
  associationRegistryValues,
  desktopIntegrationKey,
  explorerCommand,
  explorerRegistrySubkeys,
  externalFileMime,
  isSupportedExternalFile,
  parseExternalOpenPath,
  sanitizeDesktopIntegrationSettings,
  type DesktopIntegrationKind,
  type DesktopRenderStatus,
  type DesktopIntegrationSettings,
  type DesktopIntegrationStatus,
} from './desktop-integrations.ts'

// In dev the renderer is served by Vite; in production it is served from the
// packaged dist/ over a custom app:// scheme so we control the response headers
// (COOP/COEP for SharedArrayBuffer + threaded WASM, CSP, CORP).
const DEV_URL = process.env.BETTERTTS_DEV_URL
const IS_DEV = Boolean(DEV_URL)
const IS_SMOKE = process.argv.includes('--smoke')
const LOAD_NATIVE_IN_SMOKE = process.env.BETTERTTS_SMOKE_NATIVE_LOAD === '1'
// The normal smoke lane keeps the window hidden. Isolation-driven desktop
// verification may opt into a visible window so the private-desktop harness
// can prove placement before the smoke script exits.
const SHOW_SMOKE_WINDOW = process.env.BETTERTTS_SMOKE_SHOW_WINDOW === '1'

app.setName('BetterTTS')
if (IS_SMOKE && process.env.BETTERTTS_SMOKE_USER_DATA) {
  // Isolation smoke runs use a disposable profile so the user's existing
  // Electron state is never opened or modified.
  app.setPath('userData', process.env.BETTERTTS_SMOKE_USER_DATA)
}
const HAS_SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock()
if (!HAS_SINGLE_INSTANCE_LOCK) app.quit()

const execFile = promisify(execFileCallback)
const initialExternalOpenPath = parseExternalOpenPath(process.argv)

if (HAS_SINGLE_INSTANCE_LOCK) {
  app.on('second-instance', (_event, commandLine) => {
    const externalPath = parseExternalOpenPath(commandLine)
    if (externalPath) void initializeDesktopIntegrations().then(() => queueExternalFile(externalPath))
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

// Serving the renderer over app:// keeps it a proper secure origin (needed for
// crossOriginIsolated, service-worker-free storage, and a stable "self" for CSP).
const APP_ORIGIN = 'app://bettertts'

// COEP: credentialless keeps SharedArrayBuffer available while still allowing
// cross-origin model fetches from Hugging Face that lack CORP headers.
const SECURITY_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Content-Security-Policy': [
    "default-src 'self' app:",
    "script-src 'self' app: 'wasm-unsafe-eval'",
    // https: is needed for HF-hosted model/voice fetches; script-src stays
    // locked to self so a fetched page can never inject executable code.
    "connect-src 'self' app: https:",
    "style-src 'self' app: 'unsafe-inline'",
    "img-src 'self' app: blob: data:",
    "media-src 'self' app: blob:",
    "worker-src 'self' app: blob:",
    "font-src 'self' app:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; '),
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

function contentType(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

// Must run before app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
])

function rendererDir(): string {
  // dist-electron/main.cjs → packaged app root holds dist/ alongside it.
  return join(app.getAppPath(), 'dist')
}

function registerAppProtocol(): void {
  const root = rendererDir()
  protocol.handle('app', async (request) => {
    const resolution = resolveRendererRequest(root, request.url, request.headers.get('accept') ?? '')
    if (!resolution) return new Response('Forbidden', { status: 403, headers: SECURITY_HEADERS })
    try {
      const data = await readFile(resolution.filePath)
      return new Response(data, { headers: { 'Content-Type': contentType(resolution.filePath), ...SECURITY_HEADERS } })
    } catch {
      if (!resolution.allowSpaFallback) {
        return new Response('Not found', { status: 404, headers: SECURITY_HEADERS })
      }
      // HTML navigation fallback so deep links resolve to the app shell,
      // without turning missing scripts/models into misleading 200 HTML.
      const html = await readFile(join(root, 'index.html'))
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS } })
    }
  })
}

// --- Native TTS inference host (TF-99) ---------------------------------------
// A lazy utilityProcess runs kokoro-js on onnxruntime-node (CPU EP) so heavy
// inference never touches the renderer or main thread. Main only relays
// structured-cloneable messages between the renderer and the host.
const NATIVE_TTS_CHANNEL = 'bettertts:native-tts'
const UPDATE_STATUS_CHANNEL = 'bettertts:update-status'
const UPDATE_ACTION_CHANNEL = 'bettertts:update-action'
const PROJECT_CHANNEL = 'bettertts:project'
const FFMPEG_CHANNEL = 'bettertts:ffmpeg'
const RVC_MODEL_EXTENSIONS = new Set(['.pth'])
const RVC_INDEX_EXTENSIONS = new Set(['.index'])
let ttsHost: UtilityProcess | null = null
let ttsHostSubscriber: WebContents | null = null
const nativeHostGenerations = new Map<number, {
  host: UtilityProcess
  watchdog: () => void
  cancellation?: ReturnType<typeof setTimeout>
}>()
let whisperHost: UtilityProcess | null = null
let whisperHostSubscriber: WebContents | null = null
let sidecarHost: UtilityProcess | null = null
let sidecarHostSubscriber: WebContents | null = null
let rvcHost: UtilityProcess | null = null
let rvcHostSubscriber: WebContents | null = null
let activeProjectPath: string | null = null
let activeProjectIdentity: {
  revision: string
  sha256: string
  mtimeMs: number
  size: number
} | null = null

// --- Windows workflow integrations (TF-123) -------------------------------
// All three integrations are opt-in and persisted outside the renderer. The
// renderer receives file bytes rather than arbitrary paths, and OCR runs in a
// short-lived PowerShell capture + Tesseract process with no shell expansion.
const DESKTOP_INTEGRATIONS_STATUS_CHANNEL = 'bettertts:desktop-integrations-status'
const DESKTOP_INTEGRATIONS_TEXT_CHANNEL = 'bettertts:desktop-integrations-text'
const DESKTOP_INTEGRATIONS_FILES_CHANNEL = 'bettertts:desktop-integrations-files'
const DESKTOP_INTEGRATIONS_ERROR_CHANNEL = 'bettertts:desktop-integrations-error'
const DESKTOP_INTEGRATIONS_CHANNEL = 'bettertts:desktop-integrations'
const DESKTOP_INTEGRATIONS_OCR_CHANNEL = 'bettertts:desktop-integrations-ocr'
const DESKTOP_INTEGRATIONS_RENDER_CHANNEL = 'bettertts:desktop-integrations-render'
const DESKTOP_DIAGNOSTICS_CHANNEL = 'bettertts:desktop-diagnostics'
const DESKTOP_DIAGNOSTICS_LOG_CHANNEL = 'bettertts:desktop-diagnostics-log'
const MAX_EXTERNAL_FILE_BYTES = 25 * 1024 * 1024
const MAX_EXTERNAL_TEXT_CHARS = 5_000
const MAX_FOLDER_IMPORT_DIRECTORIES = 1_000
type ExternalFilePayload = { name: string; type: string; bytes: Uint8Array }
type ExternalFolderPayload = { canceled: boolean; files: ExternalFilePayload[]; skipped: number; truncated: boolean }

let desktopIntegrationSettings: DesktopIntegrationSettings = { ...DEFAULT_DESKTOP_INTEGRATIONS }
let desktopIntegrationReady: Promise<void> | null = null
let desktopHotkeyRegistered = false
let desktopExplorerRegistered = false
let desktopAssociationRegistered = false
let desktopTray: Tray | null = null
let desktopTesseractPath: string | undefined
let desktopIntegrationLastError: string | undefined
let pendingExternalFiles: ExternalFilePayload[] = []
let pendingExternalText: { text: string; source: string } | null = null
let desktopIntegrationRendererReady = false
let desktopRenderStatus: DesktopRenderStatus = { state: 'idle' }

function desktopIntegrationSettingsPath(): string {
  return join(app.getPath('userData'), 'desktop-integrations.json')
}

function desktopIntegrationStatus(): DesktopIntegrationStatus {
  return {
    ...desktopIntegrationSettings,
    hotkey: DESKTOP_INTEGRATION_HOTKEY,
    hotkeyRegistered: desktopHotkeyRegistered,
    explorerRegistered: desktopExplorerRegistered,
    associationRegistered: desktopAssociationRegistered,
    ocrAvailable: Boolean(desktopTesseractPath),
    trayReady: Boolean(desktopTray),
    notificationsAvailable: Notification.isSupported(),
    renderState: desktopRenderStatus.state,
    ...(desktopRenderStatus.message ? { renderMessage: desktopRenderStatus.message } : {}),
    ...(desktopRenderStatus.progress === undefined ? {} : { renderProgress: desktopRenderStatus.progress }),
    ...(desktopTesseractPath ? { tesseractPath: desktopTesseractPath } : {}),
    ...(desktopIntegrationLastError ? { lastError: desktopIntegrationLastError } : {}),
  }
}

function broadcastDesktopIntegrationStatus(): void {
  const status = desktopIntegrationStatus()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(DESKTOP_INTEGRATIONS_STATUS_CHANNEL, status)
  }
}

function recordNativeHostMessage(source: string, message: unknown): void {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return
  const candidate = message as { type?: unknown; message?: unknown; source?: unknown; status?: unknown; key?: unknown }
  if (candidate.type === 'diagnostic') {
    recordDesktopLog('warn', candidate.source ?? source, candidate.message)
    return
  }
  if (candidate.type === 'status' && candidate.status && typeof candidate.status === 'object') {
    const status = candidate.status as { available?: unknown; message?: unknown; recovery?: unknown }
    if (status.available === false) recordDesktopLog('warn', `${source}.status`, status.message ?? status.recovery ?? 'Runtime unavailable')
    return
  }
  if (candidate.type === 'error' || candidate.type === 'loadError' || candidate.type === 'generateError' || candidate.type === 'crashed') {
    recordDesktopLog('error', `${source}.${String(candidate.type)}`, candidate.message ?? 'Native host error')
  }
}

function setDesktopIntegrationError(error: unknown): void {
  desktopIntegrationLastError = (error instanceof Error ? error.message : String(error)).replaceAll(process.cwd(), '<app>').slice(0, 300)
  recordDesktopLog('error', 'desktop.integration', desktopIntegrationLastError)
  broadcastDesktopIntegrationStatus()
}

async function saveDesktopIntegrationSettings(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(desktopIntegrationSettingsPath(), `${JSON.stringify(desktopIntegrationSettings, null, 2)}\n`, 'utf8')
}

async function loadDesktopIntegrationSettings(): Promise<void> {
  try {
    desktopIntegrationSettings = sanitizeDesktopIntegrationSettings(JSON.parse(await readFile(desktopIntegrationSettingsPath(), 'utf8')))
  } catch {
    desktopIntegrationSettings = { ...DEFAULT_DESKTOP_INTEGRATIONS }
  }
}

async function findTesseract(): Promise<string | undefined> {
  const candidates = [
    process.env.BETTERTTS_TESSERACT_PATH,
    join(app.getPath('userData'), 'tesseract', 'tesseract.exe'),
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Tesseract-OCR', 'tesseract.exe') : undefined,
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Tesseract-OCR', 'tesseract.exe') : undefined,
    process.resourcesPath ? join(process.resourcesPath, 'tesseract', 'tesseract.exe') : undefined,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // Continue to the next configured location or PATH lookup.
    }
  }
  if (process.platform !== 'win32') return undefined
  try {
    const result = await execFile('where.exe', ['tesseract.exe'], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 })
    const path = result.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean)
    return path || undefined
  } catch {
    return undefined
  }
}

async function configureExplorerRegistry(enabled: boolean): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Explorer integration is available on Windows only.')
  const keys = explorerRegistrySubkeys()
  if (!enabled) {
    await Promise.all(keys.map((key) => execFile('reg.exe', ['DELETE', key, '/f'], { windowsHide: true, timeout: 8000 }).catch(() => undefined)))
    await Promise.all(associationRegistryValues().map(({ key, name }) => execFile('reg.exe', ['DELETE', key, '/v', name, '/f'], { windowsHide: true, timeout: 8000 }).catch(() => undefined)))
    await Promise.all(associationRegistrySubkeys().map((key) => execFile('reg.exe', ['DELETE', key, '/f'], { windowsHide: true, timeout: 8000 }).catch(() => undefined)))
    desktopExplorerRegistered = false
    desktopAssociationRegistered = false
    return
  }
  const command = explorerCommand(process.execPath, app.getAppPath(), app.isPackaged)
  for (const key of keys) {
    await execFile('reg.exe', ['ADD', key, '/ve', '/d', 'Listen in BetterTTS', '/f'], { windowsHide: true, timeout: 8000 })
    await execFile('reg.exe', ['ADD', key, '/v', 'Icon', '/d', `${process.execPath},0`, '/f'], { windowsHide: true, timeout: 8000 })
    await execFile('reg.exe', ['ADD', `${key}\\command`, '/ve', '/d', command, '/f'], { windowsHide: true, timeout: 8000 })
  }
  const applicationRoot = 'HKCU\\Software\\Classes\\Applications\\BetterTTS.exe'
  await execFile('reg.exe', ['ADD', applicationRoot, '/ve', '/d', 'BetterTTS', '/f'], { windowsHide: true, timeout: 8000 })
  await execFile('reg.exe', ['ADD', `${applicationRoot}\\DefaultIcon`, '/ve', '/d', `${process.execPath},0`, '/f'], { windowsHide: true, timeout: 8000 })
  await execFile('reg.exe', ['ADD', `${applicationRoot}\\shell\\open`, '/ve', '/d', 'Open with BetterTTS', '/f'], { windowsHide: true, timeout: 8000 })
  await execFile('reg.exe', ['ADD', `${applicationRoot}\\shell\\open\\command`, '/ve', '/d', command, '/f'], { windowsHide: true, timeout: 8000 })
  for (const extension of ['.txt', '.epub', '.pdf', '.docx'] as const) {
    const progId = `BetterTTS.Document${extension.slice(1).toUpperCase()}`
    const progIdRoot = `HKCU\\Software\\Classes\\${progId}`
    await execFile('reg.exe', ['ADD', `${applicationRoot}\\SupportedTypes`, '/v', extension, '/t', 'REG_SZ', '/d', '', '/f'], { windowsHide: true, timeout: 8000 })
    await execFile('reg.exe', ['ADD', `HKCU\\Software\\Classes\\${extension}\\OpenWithProgids`, '/v', progId, '/t', 'REG_SZ', '/d', '', '/f'], { windowsHide: true, timeout: 8000 })
    await execFile('reg.exe', ['ADD', progIdRoot, '/ve', '/d', `BetterTTS ${extension.slice(1).toUpperCase()} document`, '/f'], { windowsHide: true, timeout: 8000 })
    await execFile('reg.exe', ['ADD', `${progIdRoot}\\DefaultIcon`, '/ve', '/d', `${process.execPath},0`, '/f'], { windowsHide: true, timeout: 8000 })
    await execFile('reg.exe', ['ADD', `${progIdRoot}\\shell\\open\\command`, '/ve', '/d', command, '/f'], { windowsHide: true, timeout: 8000 })
  }
  desktopExplorerRegistered = true
  desktopAssociationRegistered = true
}

function configureDesktopHotkey(enabled: boolean): void {
  if (desktopHotkeyRegistered) {
    globalShortcut.unregister(DESKTOP_INTEGRATION_HOTKEY)
    desktopHotkeyRegistered = false
  }
  if (!enabled || IS_SMOKE) return
  if (!globalShortcut.register(DESKTOP_INTEGRATION_HOTKEY, () => {
    const text = clipboard.readText().trim().slice(0, MAX_EXTERNAL_TEXT_CHARS)
    if (text) sendDesktopIntegrationText(text, 'clipboard / copied selection')
    else setDesktopIntegrationError('Copy a selection first, then press the BetterTTS read-selection hotkey.')
  })) throw new Error(`Could not register ${DESKTOP_INTEGRATION_HOTKEY}; another application may already use it.`)
  desktopHotkeyRegistered = true
}

function desktopTrayIcon() {
  const candidates = [
    join(process.resourcesPath, 'bettertts.ico'),
    join(app.getAppPath(), 'build', 'icon.ico'),
  ]
  for (const candidate of candidates) {
    const icon = nativeImage.createFromPath(candidate)
    if (!icon.isEmpty()) return icon
  }
  throw new Error('BetterTTS tray icon is unavailable.')
}

function desktopRenderLabel(): string {
  if (desktopRenderStatus.state === 'running') {
    return desktopRenderStatus.progress === undefined
      ? desktopRenderStatus.message ?? 'Rendering'
      : `${desktopRenderStatus.message ?? 'Rendering'} (${Math.round(desktopRenderStatus.progress * 100)}%)`
  }
  if (desktopRenderStatus.state === 'error') return desktopRenderStatus.message ?? 'Render failed'
  if (desktopRenderStatus.state === 'complete') return desktopRenderStatus.message ?? 'Render complete'
  return 'Idle'
}

function showDesktopWindow(): void {
  const existing = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  const win = existing ?? (app.isReady() ? createWindow() : null)
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function refreshDesktopTrayMenu(): void {
  if (!desktopTray) return
  desktopTray.setToolTip(`BetterTTS - ${desktopRenderLabel()}`)
  desktopTray.setContextMenu(Menu.buildFromTemplate([
    { label: `Status: ${desktopRenderLabel()}`, enabled: false },
    { type: 'separator' },
    { label: 'Show BetterTTS', click: showDesktopWindow },
    { label: 'Quit BetterTTS', click: () => app.quit() },
  ]))
}

function configureDesktopTray(enabled: boolean): void {
  if (desktopTray) {
    desktopTray.destroy()
    desktopTray = null
  }
  if (!enabled || IS_SMOKE) return
  desktopTray = new Tray(desktopTrayIcon())
  desktopTray.on('click', showDesktopWindow)
  refreshDesktopTrayMenu()
}

function notifyDesktopRender(status: DesktopRenderStatus): void {
  if (IS_SMOKE || !desktopIntegrationSettings.notificationsEnabled || !Notification.isSupported()) return
  try {
    new Notification({
      title: status.state === 'error' ? 'BetterTTS render failed' : 'BetterTTS render complete',
      body: status.message ?? (status.state === 'error' ? 'The render could not be completed.' : 'Your audio is ready.'),
      silent: true,
    }).show()
  } catch (error) {
    setDesktopIntegrationError(error)
  }
}

function setDesktopRenderStatus(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const candidate = value as { state?: unknown; message?: unknown; progress?: unknown }
  if (candidate.state !== 'idle' && candidate.state !== 'running' && candidate.state !== 'complete' && candidate.state !== 'error') return
  const next: DesktopRenderStatus = {
    state: candidate.state,
    ...(typeof candidate.message === 'string' ? { message: candidate.message.slice(0, 180) } : {}),
    ...(typeof candidate.progress === 'number' && Number.isFinite(candidate.progress) ? { progress: Math.min(1, Math.max(0, candidate.progress)) } : {}),
  }
  const previous = desktopRenderStatus
  desktopRenderStatus = next
  refreshDesktopTrayMenu()
  broadcastDesktopIntegrationStatus()
  if (previous.state === 'running' && (next.state === 'complete' || next.state === 'error')) notifyDesktopRender(next)
}

async function configureDesktopIntegration(kind: DesktopIntegrationKind, enabled: boolean): Promise<DesktopIntegrationStatus> {
  if (IS_SMOKE) return desktopIntegrationStatus()
  const key = desktopIntegrationKey(kind)
  if (kind === 'hotkey') configureDesktopHotkey(enabled)
  if (kind === 'explorer') await configureExplorerRegistry(enabled)
  if (kind === 'tray') configureDesktopTray(enabled)
  desktopIntegrationSettings = { ...desktopIntegrationSettings, [key]: enabled }
  await saveDesktopIntegrationSettings()
  desktopIntegrationLastError = undefined
  desktopTesseractPath = await findTesseract()
  broadcastDesktopIntegrationStatus()
  return desktopIntegrationStatus()
}

async function initializeDesktopIntegrations(): Promise<void> {
  if (desktopIntegrationReady) return desktopIntegrationReady
  desktopIntegrationReady = (async () => {
    await loadDesktopIntegrationSettings()
    desktopTesseractPath = await findTesseract()
    if (!IS_SMOKE) {
      try { configureDesktopHotkey(desktopIntegrationSettings.hotkeyEnabled) } catch (error) { setDesktopIntegrationError(error) }
      if (desktopIntegrationSettings.explorerEnabled) {
        try { await configureExplorerRegistry(true) } catch (error) { setDesktopIntegrationError(error) }
      }
      if (desktopIntegrationSettings.trayEnabled) {
        try { configureDesktopTray(true) } catch (error) { setDesktopIntegrationError(error) }
      }
    }
  })()
  return desktopIntegrationReady
}

function sendDesktopIntegrationText(text: string, source: string): void {
  const payload = { text: text.slice(0, MAX_EXTERNAL_TEXT_CHARS), source }
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (win && desktopIntegrationRendererReady) win.webContents.send(DESKTOP_INTEGRATIONS_TEXT_CHANNEL, payload)
  else pendingExternalText = payload
}

function sendDesktopIntegrationError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (win && desktopIntegrationRendererReady) win.webContents.send(DESKTOP_INTEGRATIONS_ERROR_CHANNEL, { message })
  setDesktopIntegrationError(message)
}

function sendPendingDesktopIntegrationEvents(): void {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!win || !desktopIntegrationRendererReady) return
  if (pendingExternalText) {
    win.webContents.send(DESKTOP_INTEGRATIONS_TEXT_CHANNEL, pendingExternalText)
    pendingExternalText = null
  }
  if (pendingExternalFiles.length > 0) {
    win.webContents.send(DESKTOP_INTEGRATIONS_FILES_CHANNEL, pendingExternalFiles)
    pendingExternalFiles = []
  }
}

async function queueExternalFile(path: string): Promise<void> {
  if (!desktopIntegrationSettings.explorerEnabled) {
    sendDesktopIntegrationError('Document integration is disabled in BetterTTS settings.')
    return
  }
  if (!isSupportedExternalFile(path)) {
    sendDesktopIntegrationError('BetterTTS Explorer import supports TXT, EPUB, PDF, and DOCX files.')
    return
  }
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_EXTERNAL_FILE_BYTES) throw new Error('The selected file is missing, not a regular file, or larger than 25 MB.')
    const bytes = new Uint8Array(await readFile(path))
    const payload: ExternalFilePayload = { name: basename(path), type: externalFileMime(path), bytes }
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
    if (win && desktopIntegrationRendererReady) win.webContents.send(DESKTOP_INTEGRATIONS_FILES_CHANNEL, [payload])
    else pendingExternalFiles.push(payload)
  } catch (error) {
    sendDesktopIntegrationError(error)
  }
}

async function readExternalFolder(root: string): Promise<ExternalFolderPayload> {
  const directories = [root]
  const files: ExternalFilePayload[] = []
  let directoriesVisited = 0
  let totalBytes = 0
  let skipped = 0
  let truncated = false

  while (directories.length > 0 && directoriesVisited < MAX_FOLDER_IMPORT_DIRECTORIES) {
    const directory = directories.shift()!
    directoriesVisited += 1
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      skipped += 1
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink() || directories.length + directoriesVisited >= MAX_FOLDER_IMPORT_DIRECTORIES) {
          truncated = true
        } else {
          directories.push(path)
        }
        continue
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !isSupportedExternalFile(path)) continue
      if (files.length >= MAX_FOLDER_IMPORT_FILES) {
        truncated = true
        continue
      }
      try {
        const info = await stat(path)
        if (!info.isFile() || info.size > MAX_EXTERNAL_FILE_BYTES || totalBytes + info.size > MAX_FOLDER_IMPORT_BYTES) {
          skipped += 1
          truncated ||= totalBytes + info.size > MAX_FOLDER_IMPORT_BYTES
          continue
        }
        const bytes = new Uint8Array(await readFile(path))
        files.push({ name: basename(path), type: externalFileMime(path), bytes })
        totalBytes += bytes.byteLength
      } catch {
        skipped += 1
      }
    }
  }
  if (directories.length > 0) truncated = true
  return { canceled: false, files, skipped, truncated }
}

async function chooseExternalFolder(owner: BrowserWindow): Promise<ExternalFolderPayload> {
  if (IS_SMOKE) return { canceled: true, files: [], skipped: 0, truncated: false }
  const choice = await dialog.showOpenDialog(owner, {
    title: 'Import BetterTTS folder',
    properties: ['openDirectory'],
  })
  if (choice.canceled || !choice.filePaths[0]) return { canceled: true, files: [], skipped: 0, truncated: false }
  return readExternalFolder(choice.filePaths[0])
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function captureScreenPng(): Promise<{ root: string; imagePath: string }> {
  if (process.platform !== 'win32') throw new Error('Screen OCR is available on Windows only.')
  const root = await mkdtemp(join(app.getPath('temp'), 'bettertts-ocr-'))
  const imagePath = join(root, 'screen.png')
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$out = ${powershellLiteral(imagePath)}`,
    '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size)',
    '$bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$graphics.Dispose()',
    '$bitmap.Dispose()',
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  try {
    await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    })
    return { root, imagePath }
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`Could not capture the Windows screen for OCR: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runDesktopOcr(): Promise<{ text: string; tesseractPath?: string }> {
  if (!desktopIntegrationSettings.ocrEnabled) throw new Error('Screen OCR is disabled in BetterTTS settings.')
  desktopTesseractPath ??= await findTesseract()
  if (!desktopTesseractPath) throw new Error('Tesseract was not found. Install Tesseract OCR or set BETTERTTS_TESSERACT_PATH, then enable Screen OCR again.')
  const captured = await captureScreenPng()
  try {
    const result = await execFile(desktopTesseractPath, [captured.imagePath, 'stdout', '-l', 'eng', '--psm', '6'], {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    })
    const text = result.stdout.replace(/\r\n?/gu, '\n').trim().slice(0, MAX_EXTERNAL_TEXT_CHARS)
    if (!text) throw new Error('Tesseract found no readable text on the captured screen.')
    return { text, tesseractPath: desktopTesseractPath }
  } finally {
    await rm(captured.root, { recursive: true, force: true }).catch(() => undefined)
  }
}

ipcMain.handle(DESKTOP_INTEGRATIONS_CHANNEL, async (event, request: unknown) => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner) throw new Error('Invalid desktop integration request.')
  await initializeDesktopIntegrations()
  if (!request || typeof request !== 'object') return desktopIntegrationStatus()
  const message = request as { action?: unknown; kind?: unknown; enabled?: unknown }
  if (message.action === 'status') return desktopIntegrationStatus()
  if (message.action === 'folder') {
    try {
      return await chooseExternalFolder(owner)
    } catch (error) {
      setDesktopIntegrationError(error)
      throw error
    }
  }
  if (message.action === 'set-enabled' && (message.kind === 'hotkey' || message.kind === 'explorer' || message.kind === 'ocr' || message.kind === 'tray' || message.kind === 'notifications') && typeof message.enabled === 'boolean') {
    try {
      return await configureDesktopIntegration(message.kind, message.enabled)
    } catch (error) {
      setDesktopIntegrationError(error)
      throw error
    }
  }
  throw new Error('Unsupported desktop integration request.')
})

ipcMain.on(DESKTOP_INTEGRATIONS_RENDER_CHANNEL, (event, status: unknown) => {
  if (!BrowserWindow.fromWebContents(event.sender)) return
  setDesktopRenderStatus(status)
})

ipcMain.handle(DESKTOP_INTEGRATIONS_OCR_CHANNEL, async (event) => {
  if (!BrowserWindow.fromWebContents(event.sender)) throw new Error('Invalid screen OCR request.')
  await initializeDesktopIntegrations()
  try {
    const result = await runDesktopOcr()
    desktopIntegrationLastError = undefined
    broadcastDesktopIntegrationStatus()
    return result
  } catch (error) {
    setDesktopIntegrationError(error)
    throw error
  }
})

async function readDesktopManifest(pack: SherpaModelPack): Promise<unknown> {
  try {
    return await readSherpaPackStatus(
      process.env.BETTERTTS_MODEL_CACHE?.trim() || join(app.getPath('userData'), 'native-models'),
      pack,
      { deep: false },
    )
  } catch (error) {
    return {
      id: pack.id,
      modelId: pack.modelId,
      revision: pack.revision,
      installed: false,
      verified: false,
      files: [],
      totalBytes: 0,
      expectedBytes: pack.archive.size,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

ipcMain.handle(DESKTOP_DIAGNOSTICS_CHANNEL, async (event, request: unknown) => {
  if (!BrowserWindow.fromWebContents(event.sender)) throw new Error('Invalid desktop diagnostics request.')
  const message = request && typeof request === 'object' && !Array.isArray(request)
    ? request as { action?: unknown; selection?: unknown; generation?: unknown; runtime?: unknown }
    : {}
  if (message.action !== 'collect') throw new Error('Unsupported desktop diagnostics request.')

  const [kokoro, piper, melo, ffmpeg] = await Promise.all([
    readDesktopManifest(SHERPA_KOKORO_PACK),
    readDesktopManifest(SHERPA_PIPER_PACK),
    readDesktopManifest(SHERPA_MELO_PACK),
    probeFfmpeg(),
  ])
  recordDesktopLog('info', 'desktop.diagnostics', 'Collected a redacted native support snapshot.')
  const diagnosticsRequest: DesktopDiagnosticsRequest = {
    selection: message.selection,
    generation: message.generation,
    runtime: message.runtime,
  }
  return buildDesktopDiagnostics(diagnosticsRequest, {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    packaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    resourcesPath: process.resourcesPath,
    modelCachePath: process.env.BETTERTTS_MODEL_CACHE?.trim() || join(app.getPath('userData'), 'native-models'),
    nativeManifests: { kokoro, piper, melo },
    ffmpeg,
  })
})

ipcMain.on(DESKTOP_DIAGNOSTICS_LOG_CHANNEL, (event, request: unknown) => {
  if (!BrowserWindow.fromWebContents(event.sender)) return
  if (!request || typeof request !== 'object' || Array.isArray(request)) return
  const message = request as { level?: unknown; source?: unknown; message?: unknown }
  if (message.level !== 'info' && message.level !== 'warn' && message.level !== 'error') return
  recordDesktopLog(message.level, message.source, message.message)
})

function sendToSubscriber(message: unknown): void {
  recordNativeHostMessage('native', message)
  if (ttsHostSubscriber && !ttsHostSubscriber.isDestroyed()) {
    ttsHostSubscriber.send(NATIVE_TTS_CHANNEL, message)
  }
}

function disarmNativeGeneration(id: number): void {
  const entry = nativeHostGenerations.get(id)
  if (!entry) return
  entry.watchdog()
  if (entry.cancellation) clearTimeout(entry.cancellation)
  nativeHostGenerations.delete(id)
}

function clearNativeGenerations(host: UtilityProcess): void {
  for (const [id, entry] of nativeHostGenerations) {
    if (entry.host !== host) continue
    disarmNativeGeneration(id)
  }
}

function stopTtsHost(host: UtilityProcess | null = ttsHost): void {
  if (!host) return
  clearNativeGenerations(host)
  if (ttsHost === host) ttsHost = null
  host.kill()
}

function armNativeGeneration(host: UtilityProcess, id: number): void {
  disarmNativeGeneration(id)
  const watchdog = startNativeGenerationWatchdog(() => {
    if (ttsHost !== host) return
    sendToSubscriber({ type: 'generateError', message: 'Native generation timed out; the utility host was restarted.', id })
    stopTtsHost(host)
  })
  nativeHostGenerations.set(id, { host, watchdog })
}

function cancelNativeHost(request: { type: 'cancel'; id: number } | { type: 'cancel-all' }): void {
  const host = ttsHost
  if (!host) return
  host.postMessage(request)
  for (const [id, entry] of nativeHostGenerations) {
    if (entry.host !== host || (request.type === 'cancel' && id !== request.id)) continue
    if (entry.cancellation) clearTimeout(entry.cancellation)
    entry.cancellation = setTimeout(() => {
      if (ttsHost === host) stopTtsHost(host)
    }, NATIVE_CANCEL_GRACE_MS)
  }
}

function ensureTtsHost(): UtilityProcess {
  if (ttsHost) return ttsHost
  const env: Record<string, string | undefined> = {
    ...process.env,
    BETTERTTS_MODEL_CACHE: process.env.BETTERTTS_MODEL_CACHE ?? join(app.getPath('userData'), 'native-models'),
    BETTERTTS_APP_PACKAGED: app.isPackaged ? '1' : '0',
  }
  // Same dev-environment hazard as scripts/run-electron.mjs: a present-but-set
  // ELECTRON_RUN_AS_NODE must be deleted, never blanked.
  delete env.ELECTRON_RUN_AS_NODE
  const host = utilityProcess.fork(join(__dirname, 'tts-host.mjs'), [], {
    serviceName: 'BetterTTS native inference',
    env: env as Record<string, string>,
  })
  host.on('message', (message) => {
    if (message && typeof message === 'object') {
      const response = message as { type?: unknown; id?: unknown }
      if ((response.type === 'generated' || response.type === 'generateError') && typeof response.id === 'number') {
        disarmNativeGeneration(response.id)
      }
    }
    sendToSubscriber(message)
  })
  host.on('exit', () => {
    clearNativeGenerations(host)
    if (ttsHost === host) {
      ttsHost = null
      sendToSubscriber({ type: 'crashed' })
    }
  })
  ttsHost = host
  return host
}

ipcMain.on(NATIVE_TTS_CHANNEL, (event, message: unknown) => {
  if (!BrowserWindow.fromWebContents(event.sender)) return
  const request = validateNativeTtsRequest(message)
  if (!request) {
    const candidate = message as { type?: unknown; id?: unknown }
    if (candidate?.type === 'generate' && Number.isSafeInteger(candidate.id) && Number(candidate.id) >= 0) {
      event.sender.send(NATIVE_TTS_CHANNEL, { type: 'generateError', message: 'Invalid native inference request.', id: Number(candidate.id) })
    } else {
      event.sender.send(NATIVE_TTS_CHANNEL, { type: 'loadError', message: 'Invalid native inference request.', key: 'cpu:q8' })
    }
    return
  }
  ttsHostSubscriber = event.sender
  if (request.type === 'reset') {
    stopTtsHost()
    return
  }
  if (request.type === 'cancel-all' || request.type === 'cancel') {
    cancelNativeHost(request)
    return
  }
  const host = ensureTtsHost()
  if (request.type === 'generate') armNativeGeneration(host, request.id)
  host.postMessage(request)
})

// --- whisper.cpp caption host (TF-117) --------------------------------------
// Caption inference follows the same isolated utility-process boundary as
// native TTS. The host owns the optional whisper.cpp executable, the model
// path, temporary audio files, and child-process cancellation.
function sendToWhisperSubscriber(message: unknown): void {
  recordNativeHostMessage('whisper', message)
  if (whisperHostSubscriber && !whisperHostSubscriber.isDestroyed()) {
    whisperHostSubscriber.send(WHISPER_CHANNEL, message)
  }
}

function ensureWhisperHost(): UtilityProcess {
  if (whisperHost) return whisperHost
  const env: Record<string, string | undefined> = {
    ...process.env,
    BETTERTTS_WHISPER_MODEL_DIR: join(app.getPath('userData'), 'models', 'whisper'),
  }
  delete env.ELECTRON_RUN_AS_NODE
  const host = utilityProcess.fork(join(__dirname, 'whisper-host.mjs'), [], {
    serviceName: 'BetterTTS whisper captions',
    env: env as Record<string, string>,
  })
  host.on('message', (message) => sendToWhisperSubscriber(message))
  host.on('exit', () => {
    if (whisperHost === host) {
      whisperHost = null
      sendToWhisperSubscriber({ type: 'error', id: 0, code: 'failed', message: 'The whisper.cpp caption host stopped. Try captioning the audio again.' })
    }
  })
  whisperHost = host
  return host
}

ipcMain.on(WHISPER_CHANNEL, (event, message: unknown) => {
  if (!BrowserWindow.fromWebContents(event.sender)) return
  const request = validateWhisperRequest(message)
  const candidate = message as { id?: unknown }
  if (!request) {
    if (Number.isSafeInteger(candidate?.id) && Number(candidate.id) >= 0) {
      event.sender.send(WHISPER_CHANNEL, {
        type: 'error',
        id: Number(candidate.id),
        code: 'failed',
        message: 'Invalid whisper caption request.',
      })
    }
    return
  }
  whisperHostSubscriber = event.sender
  ensureWhisperHost().postMessage(request)
})

// --- Optional Qwen3-TTS Python sidecar (TF-118) -----------------------------
// The Python environment and model cache live under Electron userData. The
// installer carries only the small protocol script and requirements manifest;
// torch, qwen-tts, and model weights are downloaded after install on request.
function sendToSidecarSubscriber(message: unknown): void {
  recordNativeHostMessage('qwen', message)
  if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'diagnostic') return
  if (sidecarHostSubscriber && !sidecarHostSubscriber.isDestroyed()) {
    sidecarHostSubscriber.send(SIDECAR_CHANNEL, message)
  }
}

function ensureSidecarHost(): UtilityProcess {
  if (sidecarHost) return sidecarHost
  const packagedSidecarRoot = app.isPackaged ? join(process.resourcesPath, 'sidecar') : join(__dirname, '..', 'sidecar')
  const env: Record<string, string | undefined> = {
    ...process.env,
    BETTERTTS_SIDECAR_DIR: join(app.getPath('userData'), 'sidecar'),
    BETTERTTS_SIDECAR_MODEL_DIR: join(app.getPath('userData'), 'models', 'qwen'),
    BETTERTTS_SIDECAR_SCRIPT: join(packagedSidecarRoot, 'bettertts_sidecar.py'),
    BETTERTTS_SIDECAR_REQUIREMENTS: join(packagedSidecarRoot, 'requirements-qwen.txt'),
    BETTERTTS_SIDECAR_MANIFEST: join(packagedSidecarRoot, 'qwen-runtime-manifest.json'),
  }
  delete env.ELECTRON_RUN_AS_NODE
  const host = utilityProcess.fork(join(__dirname, 'sidecar-host.mjs'), [], {
    serviceName: 'BetterTTS Qwen3-TTS sidecar',
    env: env as Record<string, string>,
  })
  host.on('message', (message) => sendToSidecarSubscriber(message))
  host.on('exit', () => {
    if (sidecarHost === host) {
      sidecarHost = null
      sendToSidecarSubscriber({ type: 'crashed', message: 'The Qwen3-TTS sidecar host stopped. Try again to restart it.' })
    }
  })
  sidecarHost = host
  return host
}

ipcMain.on(SIDECAR_CHANNEL, (event, message: unknown) => {
  if (!BrowserWindow.fromWebContents(event.sender)) return
  const request = validateSidecarRequest(message)
  const candidate = message as { id?: unknown }
  if (!request) {
    if (Number.isSafeInteger(candidate?.id) && Number(candidate.id) >= 0) {
      event.sender.send(SIDECAR_CHANNEL, {
        type: 'error',
        id: Number(candidate.id),
        code: 'failed',
        message: 'Invalid Qwen3-TTS sidecar request.',
      })
    }
    return
  }
  sidecarHostSubscriber = event.sender
  ensureSidecarHost().postMessage(request)
})

// Optional RVC post-stage host (TF-120). Python, torch, and user-selected
// weights stay outside the renderer and outside the installer payload.
function sendToRvcSubscriber(message: unknown): void {
  recordNativeHostMessage('rvc', message)
  if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'diagnostic') return
  if (rvcHostSubscriber && !rvcHostSubscriber.isDestroyed()) {
    rvcHostSubscriber.send(RVC_CHANNEL, message)
  }
}

function ensureRvcHost(): UtilityProcess {
  if (rvcHost) return rvcHost
  const packagedSidecarRoot = app.isPackaged ? join(process.resourcesPath, 'sidecar') : join(__dirname, '..', 'sidecar')
  const env: Record<string, string | undefined> = {
    ...process.env,
    BETTERTTS_RVC_DIR: join(app.getPath('userData'), 'rvc'),
    BETTERTTS_RVC_SCRIPT: join(packagedSidecarRoot, 'bettertts_rvc.py'),
    BETTERTTS_RVC_REQUIREMENTS: join(packagedSidecarRoot, 'requirements-rvc.txt'),
  }
  delete env.ELECTRON_RUN_AS_NODE
  const host = utilityProcess.fork(join(__dirname, 'rvc-host.mjs'), [], {
    serviceName: 'BetterTTS RVC voice conversion',
    env: env as Record<string, string>,
  })
  host.on('message', (message) => sendToRvcSubscriber(message))
  host.on('exit', () => {
    if (rvcHost === host) {
      rvcHost = null
      sendToRvcSubscriber({ type: 'crashed', message: 'The RVC utility host stopped. Try again to restart it.' })
    }
  })
  rvcHost = host
  return host
}

ipcMain.on(RVC_CHANNEL, (event, message: unknown) => {
  if (!BrowserWindow.fromWebContents(event.sender)) return
  const request = validateRvcRequest(message)
  const candidate = message as { id?: unknown }
  if (!request) {
    if (Number.isSafeInteger(candidate?.id) && Number(candidate.id) >= 0) {
      event.sender.send(RVC_CHANNEL, {
        type: 'error',
        id: Number(candidate.id),
        code: 'failed',
        message: 'Invalid RVC voice conversion request.',
      })
    }
    return
  }
  rvcHostSubscriber = event.sender
  ensureRvcHost().postMessage(request)
})

ipcMain.handle(BYO_WEIGHTS_CHANNEL, async (event, message: unknown) => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  const request = validateByoWeightsRequest(message)
  if (!owner || !request) throw new Error('Invalid bring-your-own weights request.')
  if (IS_SMOKE) return { canceled: true }

  const option = getByoModelOption(request.modelId)
  const choice = await dialog.showOpenDialog(owner, {
    title: `Select self-supplied ${option.label} weights`,
    properties: ['openFile', 'openDirectory'],
  })
  const selectedPath = choice.filePaths[0]
  if (choice.canceled || !selectedPath) return { canceled: true }
  const selected = await stat(selectedPath)
  if (!selected.isFile() && !selected.isDirectory()) throw new Error('The selected weights path is not a file or directory.')
  return {
    canceled: false,
    path: selectedPath,
    name: basename(selectedPath),
    kind: selected.isDirectory() ? 'directory' : 'file',
  }
})

ipcMain.handle(RVC_WEIGHTS_CHANNEL, async (event, message: unknown) => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  const request = validateRvcWeightsRequest(message)
  if (!owner || !request) throw new Error('Invalid RVC model selection request.')
  if (IS_SMOKE) return { canceled: true }
  const isIndex = request.action === 'index'
  const choice = await dialog.showOpenDialog(owner, {
    title: isIndex ? 'Select optional RVC index file' : 'Select RVC model weights',
    properties: ['openFile'],
    filters: [{ name: isIndex ? 'RVC index files' : 'RVC model files', extensions: [isIndex ? 'index' : 'pth'] }],
  })
  const selectedPath = choice.filePaths[0]
  if (choice.canceled || !selectedPath) return { canceled: true }
  const selected = await stat(selectedPath)
  const extension = extname(selectedPath).toLowerCase()
  const allowed = (isIndex ? RVC_INDEX_EXTENSIONS : RVC_MODEL_EXTENSIONS).has(extension)
  if (!selected.isFile() || !allowed) throw new Error(`Choose a local RVC ${isIndex ? '.index' : '.pth'} file.`)
  return {
    canceled: false,
    path: selectedPath,
    name: basename(selectedPath),
  }
})

const openAiAllowedOrigins = new Set(['app://bettertts', 'http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5173', 'http://127.0.0.1:5174'])
if (DEV_URL) {
  try {
    openAiAllowedOrigins.add(new URL(DEV_URL).origin)
  } catch {
    // The dev URL is validated by the desktop launcher; keep the explicit
    // default origin set if an invalid override reaches this process.
  }
}
const openAiTtsServer = createOpenAiTtsServer({ synthesize: synthesizeOpenAiSpeech, allowedOrigins: [...openAiAllowedOrigins] })

ipcMain.handle(OPENAI_TTS_CHANNEL, async (event, message: unknown) => {
  if (!BrowserWindow.fromWebContents(event.sender)) throw new Error('Invalid local TTS server request.')
  const request = validateOpenAiTtsRequest(message)
  if (!request) throw new Error('Invalid local TTS server request.')
  if (request.action === 'status') return openAiTtsServer.status()
  if (request.action === 'start') return openAiTtsServer.start(request.port)
  return openAiTtsServer.stop()
})

type UpdateStatus = {
  state: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  percent?: number
  message?: string
  manual?: boolean
}

let updateDownloadAvailable = false
let updateDownloaded = false
let manualUpdateCheck = false

function broadcastUpdateStatus(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(UPDATE_STATUS_CHANNEL, status)
  }
}

function safeUpdateError(error: Error): string {
  return error.message
    .replaceAll(process.cwd(), '<app>')
    .replace(/https?:\/\/\S+/gi, '<update feed>')
    .slice(0, 220)
}

function configureUpdater(): void {
  if (!app.isPackaged || IS_SMOKE) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false
  autoUpdater.on('checking-for-update', () => broadcastUpdateStatus({ state: 'checking', manual: manualUpdateCheck }))
  autoUpdater.on('update-available', (info) => {
    updateDownloadAvailable = true
    manualUpdateCheck = false
    broadcastUpdateStatus({ state: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', (info) => {
    updateDownloadAvailable = false
    broadcastUpdateStatus({ state: 'not-available', version: info.version, manual: manualUpdateCheck })
    manualUpdateCheck = false
  })
  autoUpdater.on('download-progress', (progress) => {
    broadcastUpdateStatus({ state: 'downloading', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true
    broadcastUpdateStatus({ state: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (error) => {
    broadcastUpdateStatus({ state: 'error', message: safeUpdateError(error), manual: manualUpdateCheck })
    manualUpdateCheck = false
  })
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => undefined)
  }, 5000)
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => undefined)
  }, 6 * 60 * 60 * 1000).unref()
}

ipcMain.on(UPDATE_ACTION_CHANNEL, (event, action: unknown) => {
  if (!app.isPackaged || IS_SMOKE || !BrowserWindow.fromWebContents(event.sender)) return
  if (action === 'check') {
    manualUpdateCheck = true
    autoUpdater.checkForUpdates().catch(() => undefined)
  } else if (action === 'download' && updateDownloadAvailable) {
    autoUpdater.downloadUpdate().catch(() => undefined)
  } else if (action === 'install' && updateDownloaded) {
    autoUpdater.quitAndInstall(false, true)
  }
})

ipcMain.handle(PROJECT_CHANNEL, async (event, request: unknown) => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || !request || typeof request !== 'object') throw new Error('Invalid project request.')
  const message = request as { action?: string; bytes?: Uint8Array; suggestedName?: string; saveAs?: boolean }
  if (message.action === 'forget') {
    if (IS_SMOKE && activeProjectPath) await unlink(activeProjectPath).catch(() => undefined)
    activeProjectPath = null
    activeProjectIdentity = null
    return { canceled: false }
  }
  if (message.action === 'open') {
    if (IS_SMOKE && activeProjectPath) {
      const opened = await readProjectSnapshot(activeProjectPath)
      activeProjectIdentity = opened.identity
      return { canceled: false, name: basename(activeProjectPath), bytes: opened.bytes }
    }
    if (IS_SMOKE) return { canceled: true }
    const choice = await dialog.showOpenDialog(owner, {
      title: 'Open BetterTTS project',
      properties: ['openFile'],
      filters: [{ name: 'BetterTTS project', extensions: ['bettertts'] }],
    })
    if (choice.canceled || !choice.filePaths[0]) return { canceled: true }
    const path = choice.filePaths[0]
    const opened = await readProjectSnapshot(path)
    activeProjectPath = path
    activeProjectIdentity = opened.identity
    return { canceled: false, name: basename(path), bytes: opened.bytes }
  }
  if (message.action === 'save') {
    if (!message.bytes) throw new Error('Project data is missing.')
    let path = message.saveAs ? null : activeProjectPath
    if (IS_SMOKE) path = join(app.getPath('temp'), `bettertts-project-smoke-${process.pid}.bettertts`)
    if (!path) {
      const safeName = [...(message.suggestedName ?? 'Untitled project')]
        .map((character) => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '-' : character)
        .join('')
        .slice(0, 80)
      const choice = await dialog.showSaveDialog(owner, {
        title: message.saveAs ? 'Save BetterTTS project as' : 'Save BetterTTS project',
        defaultPath: `${safeName || 'Untitled project'}.bettertts`,
        filters: [{ name: 'BetterTTS project', extensions: ['bettertts'] }],
      })
      if (choice.canceled || !choice.filePath) return { canceled: true }
      path = choice.filePath
    }
    try {
      const saved = await writeProjectFile(path, message.bytes, {
        expectedIdentity: path === activeProjectPath ? activeProjectIdentity : null,
      })
      activeProjectPath = saved.path
      activeProjectIdentity = saved.identity
      return { canceled: false, name: basename(saved.path) }
    } catch (error) {
      if (!(error instanceof ProjectConflictError) || !activeProjectPath) throw error
      const conflictPath = activeProjectPath
      const choice = await dialog.showMessageBox(owner, {
        type: 'warning',
        title: 'Project changed outside BetterTTS',
        message: `${basename(conflictPath)} was modified by another app window or process.`,
        detail: 'Reload the external version, save your current workspace as a copy, or explicitly overwrite the changed file.',
        buttons: ['Reload external version', 'Save current workspace as a copy', 'Overwrite external version', 'Cancel'],
        defaultId: 0,
        cancelId: 3,
        noLink: true,
      })
      if (choice.response === 0) {
        const opened = await readProjectSnapshot(conflictPath)
        activeProjectIdentity = opened.identity
        return {
          canceled: false,
          name: basename(conflictPath),
          bytes: opened.bytes,
          conflictResolution: 'reload',
        }
      }
      if (choice.response === 1) {
        const copyChoice = await dialog.showSaveDialog(owner, {
          title: 'Save BetterTTS project copy',
          defaultPath: `${basename(conflictPath, '.bettertts')} copy.bettertts`,
          filters: [{ name: 'BetterTTS project', extensions: ['bettertts'] }],
        })
        if (copyChoice.canceled || !copyChoice.filePath) return { canceled: true }
        const saved = await writeProjectFile(copyChoice.filePath, message.bytes)
        activeProjectPath = saved.path
        activeProjectIdentity = saved.identity
        return { canceled: false, name: basename(saved.path), conflictResolution: 'save-copy' }
      }
      if (choice.response === 2) {
        const saved = await writeProjectFile(conflictPath, message.bytes)
        activeProjectIdentity = saved.identity
        return { canceled: false, name: basename(conflictPath), conflictResolution: 'overwrite' }
      }
      return { canceled: true, conflictResolution: 'cancel' }
    }
  }
  throw new Error('Unsupported project action.')
})

ipcMain.handle(FFMPEG_CHANNEL, async (event, request: unknown) => {
  if (!BrowserWindow.fromWebContents(event.sender) || !request || typeof request !== 'object') {
    throw new Error('Invalid FFmpeg request.')
  }
  const message = request as {
    action?: string
    samples?: Float32Array
    sampleRate?: number
    format?: string
    bitrate?: number
    title?: string
    loudnessTarget?: number
    cleanupMode?: 'off' | 'denoise' | 'studio'
    chunks?: Array<{ bytes: Uint8Array; title: string }>
    language?: string
    narrator?: string
    cover?: { bytes: Uint8Array }
    provenanceManifest?: unknown
  }
  if (message.action === 'status') {
    const status = await probeFfmpeg()
    if (!status.available) recordDesktopLog('warn', 'ffmpeg.probe', status.message)
    return status
  }
  try {
    if (message.action === 'transcode' && message.samples && message.sampleRate && message.format) {
      return await transcodePcm(message)
    }
    if (message.action === 'audiobook' && message.chunks) return await buildM4bAudiobook(message)
    throw new Error('Unsupported FFmpeg action.')
  } catch (error) {
    recordDesktopLog('error', 'ffmpeg', error)
    throw error
  }
})

// Ask the host for its runtime info without loading any model — used by the
// smoke check to prove the utilityProcess spawns and answers inside Electron.
function probeTtsHostInfo(timeoutMs = 8000): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const host = ensureTtsHost()
    const timer = setTimeout(() => {
      host.removeListener('message', onMessage)
      rejectPromise(new Error('native host info timeout'))
    }, timeoutMs)
    const onMessage = (message: unknown) => {
      if (message && typeof message === 'object' && (message as { type?: string }).type === 'info') {
        clearTimeout(timer)
        host.removeListener('message', onMessage)
        resolvePromise(message)
      }
    }
    host.on('message', onMessage)
    host.postMessage({ type: 'info' })
  })
}

function probeWhisperHostStatus(timeoutMs = 8000): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const host = ensureWhisperHost()
    const id = 92001
    const timer = setTimeout(() => {
      host.removeListener('message', onMessage)
      rejectPromise(new Error('whisper host status timeout'))
    }, timeoutMs)
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object') return
      const response = message as { type?: string; id?: number; status?: unknown }
      if (response.type !== 'status' || response.id !== id) return
      clearTimeout(timer)
      host.removeListener('message', onMessage)
      resolvePromise(response.status)
    }
    host.on('message', onMessage)
    host.postMessage({ type: 'status', id })
  })
}

function probeSidecarHostStatus(timeoutMs = 8000): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const host = ensureSidecarHost()
    const id = 92002
    const timer = setTimeout(() => {
      host.removeListener('message', onMessage)
      rejectPromise(new Error('Qwen3-TTS sidecar status timeout'))
    }, timeoutMs)
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object') return
      const response = message as { type?: string; id?: number; status?: unknown }
      if (response.type !== 'status' || response.id !== id) return
      clearTimeout(timer)
      host.removeListener('message', onMessage)
      resolvePromise(response.status)
    }
    host.on('message', onMessage)
    host.postMessage({ type: 'status', id })
  })
}

function probeTtsHostLoad(timeoutMs = 180000): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const host = ensureTtsHost()
    const timer = setTimeout(() => {
      host.removeListener('message', onMessage)
      rejectPromise(new Error('native host model-load timeout'))
    }, timeoutMs)
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object') return
      const type = (message as { type?: string }).type
      if (type !== 'loaded' && type !== 'loadError') return
      clearTimeout(timer)
      host.removeListener('message', onMessage)
      if (type === 'loaded') resolvePromise(message)
      else rejectPromise(new Error((message as { message?: string }).message ?? 'native host model load failed'))
    }
    host.on('message', onMessage)
    host.postMessage({ type: 'load', dtype: 'q8' })
  })
}

function probeTtsHostGenerate(text: string, id: number, timeoutMs = 180000): Promise<Float32Array> {
  return new Promise((resolvePromise, rejectPromise) => {
    const host = ensureTtsHost()
    const timer = setTimeout(() => {
      host.removeListener('message', onMessage)
      rejectPromise(new Error('native host generation timeout'))
    }, timeoutMs)
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object') return
      const response = message as { type?: string; id?: number; samples?: Float32Array; message?: string }
      if (response.id !== id || (response.type !== 'generated' && response.type !== 'generateError')) return
      clearTimeout(timer)
      host.removeListener('message', onMessage)
      if (response.type === 'generated' && response.samples) resolvePromise(new Float32Array(response.samples))
      else rejectPromise(new Error(response.message ?? 'native host generation failed'))
    }
    host.on('message', onMessage)
    host.postMessage({ type: 'generate', text, voice: 'af_heart', speed: 1, id })
  })
}

let nextOpenAiTtsId = 1_000_000
let openAiGenerationTail: Promise<void> = Promise.resolve()

function waitForTtsHostMessage<T>(
  host: UtilityProcess,
  predicate: (message: unknown) => boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      host.removeListener('message', onMessage)
      host.removeListener('exit', onExit)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onMessage = (message: unknown) => {
      if (predicate(message)) finish(() => resolve(message as T))
    }
    const onExit = () => finish(() => reject(new Error('The native inference host stopped while serving the local API.')))
    const onAbort = () => finish(() => reject(new Error('The local API request was cancelled.')))
    const timer = setTimeout(() => finish(() => reject(new Error('The native inference host timed out.'))), timeoutMs)
    host.on('message', onMessage)
    host.once('exit', onExit)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

async function synthesizeNativeOpenAi(request: OpenAiSpeechRequest, signal: AbortSignal): Promise<{ samples: Float32Array; sampleRate: number }> {
  const operation = openAiGenerationTail.then(async () => {
    if (signal.aborted) throw new Error('The local API request was cancelled.')
    const host = ensureTtsHost()
    const key = request.engine === 'piper' ? 'sherpa:piper' : request.engine === 'melo' ? 'sherpa:melo' : 'cpu:q8'
    const load = waitForTtsHostMessage<{ type: 'loaded'; key: string } | { type: 'loadError'; key: string; message: string }>(
      host,
      (message) => {
        if (!message || typeof message !== 'object') return false
        const response = message as { type?: string; key?: string }
        return (response.type === 'loaded' || response.type === 'loadError') && response.key === key
      },
      180_000,
      signal,
    )
    host.postMessage({ type: 'load', dtype: 'q8', ...(request.engine && request.engine !== 'kokoro' ? { engine: request.engine } : {}) })
    const loaded = await load
    if (loaded.type === 'loadError') throw new Error(loaded.message)

    const id = nextOpenAiTtsId++
    const generated = waitForTtsHostMessage<{ type: 'generated'; samples: Float32Array; sampleRate: number } | { type: 'generateError'; id: number; message: string }>(
      host,
      (message) => {
        if (!message || typeof message !== 'object') return false
        const response = message as { type?: string; id?: number }
        return (response.type === 'generated' || response.type === 'generateError') && response.id === id
      },
      180_000,
      signal,
    )
    armNativeGeneration(host, id)
    host.postMessage({
      type: 'generate',
      text: request.input,
      voice: request.engine === 'piper' ? 'en' : request.engine === 'melo' ? 'melo-default' : request.voice,
      speed: request.speed,
      id,
      ...(request.engine && request.engine !== 'kokoro' ? { engine: request.engine } : {}),
    })
    try {
      const result = await generated
      if (result.type === 'generateError') throw new Error(result.message)
      const samples = result.samples instanceof Float32Array ? result.samples : new Float32Array(result.samples)
      const audio = validateNativePcm(samples, result.sampleRate)
      return { samples: audio.samples, sampleRate: audio.sampleRate }
    } finally {
      if (signal.aborted) cancelNativeHost({ type: 'cancel', id })
    }
  })
  openAiGenerationTail = operation.then(() => undefined, () => undefined)
  return operation
}

async function synthesizeOpenAiSpeech(request: OpenAiSpeechRequest, signal: AbortSignal) {
  const generated = await synthesizeNativeOpenAi(request, signal)
  if (request.responseFormat === 'wav') {
    return {
      bytes: new Uint8Array(encodeWav(generated.samples, generated.sampleRate)),
      mime: 'audio/wav',
      extension: '.wav',
      sampleRate: generated.sampleRate,
    }
  }
  const encoded = await transcodePcm({
    samples: generated.samples,
    sampleRate: generated.sampleRate,
    format: request.responseFormat,
    bitrate: 128,
    title: 'BetterTTS local speech',
  }) as { bytes: Uint8Array; extension: string; mime: string }
  return { ...encoded, sampleRate: generated.sampleRate }
}

async function probeOpenAiTtsServer(): Promise<unknown> {
  const before = openAiTtsServer.status()
  const started = await openAiTtsServer.start(0)
  try {
    if (!started.endpoint || !started.authToken) throw new Error('Local API smoke server did not expose an authenticated endpoint.')
    const healthResponse = await fetch(`${started.endpoint}/health`, { headers: { Authorization: `Bearer ${started.authToken}` } })
    const health = await healthResponse.json() as { ok?: boolean }
    const stopped = await openAiTtsServer.stop()
    return { before, started, health, stopped }
  } finally {
    if (openAiTtsServer.status().running) await openAiTtsServer.stop()
  }
}

async function probeTtsHostCancellation(): Promise<void> {
  const id = 91001
  const pending = probeTtsHostGenerate(
    'The packaged cancellation fixture must discard this unfinished output. '.repeat(15),
    id,
  )
  await new Promise((resolve) => setTimeout(resolve, 25))
  ensureTtsHost().postMessage({ type: 'cancel', id })
  try {
    await pending
    throw new Error('cancelled native generation produced output')
  } catch (error) {
    if (!(error instanceof Error) || !/cancel/i.test(error.message)) throw error
  }
}

function encodeSmokeWav(samples: Float32Array, sampleRate = 24000): Buffer {
  const wav = Buffer.allocUnsafe(44 + samples.length * 2)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + samples.length * 2, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(samples.length * 2, 40)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    wav.writeInt16LE(Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), 44 + index * 2)
  }
  return wav
}

async function decodeSmokeWav(win: BrowserWindow, wav: Buffer): Promise<{ duration: number; sampleRate: number }> {
  const base64 = wav.toString('base64')
  return win.webContents.executeJavaScript(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), character => character.charCodeAt(0))
    const context = new AudioContext()
    try {
      const decoded = await context.decodeAudioData(bytes.buffer)
      return { duration: decoded.duration, sampleRate: decoded.sampleRate }
    } finally {
      await context.close()
    }
  })()`)
}

function applyDevSecurityHeaders(): void {
  // The Vite dev server can't set COOP/COEP itself, so inject them here to keep
  // the isolated-context behavior identical to production.
  const asArrays: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) asArrays[key] = [value]
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, ...asArrays } })
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#05070a',
    // Paint while hidden so ready-to-show and the smoke capture work reliably.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Never let the renderer navigate the top frame away from the app, and open
  // real external links in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN) && !(IS_DEV && DEV_URL && url.startsWith(DEV_URL))) {
      event.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })

  win.once('ready-to-show', () => {
    if (!IS_SMOKE || SHOW_SMOKE_WINDOW) win.show()
  })

  win.webContents.once('did-finish-load', () => {
    desktopIntegrationRendererReady = true
    setTimeout(sendPendingDesktopIntegrationEvents, 100)
  })
  win.on('closed', () => {
    if (BrowserWindow.getAllWindows().length === 0) desktopIntegrationRendererReady = false
  })

  win.loadURL(IS_DEV ? DEV_URL! : `${APP_ORIGIN}/index.html`)
  return win
}

// Headless render check: loads the app, confirms React actually mounted, writes
// a screenshot, and exits — without ever stealing focus (window stays hidden).
async function runSmoke(win: BrowserWindow): Promise<void> {
  const result: Record<string, unknown> = { ok: false }
  try {
    const smokeOutputDirectory = resolveSmokeOutputDirectory({
      appPath: app.getAppPath(),
      tempPath: app.getPath('temp'),
      packaged: app.isPackaged,
      reportPath: process.env.BETTERTTS_SMOKE_REPORT,
    })
    await mkdir(smokeOutputDirectory, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve())
      win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`did-fail-load ${code} ${desc}`)))
    })
    await new Promise((r) => setTimeout(r, 2500))

    // The bridge holds functions (nativeTts.post/onMessage) which cannot cross
    // executeJavaScript's structured clone — probe serializable facts only.
    const probe = (await win.webContents.executeJavaScript(`(() => ({
      brand: document.querySelector('.brand')?.textContent?.trim() ?? null,
      railItems: document.querySelectorAll('.rail-link').length,
      generate: !!document.querySelector('.generate-button'),
      platform: window.betterttsPlatform
        ? { kind: window.betterttsPlatform.kind, nativeTts: !!window.betterttsPlatform.nativeTts, updater: !!window.betterttsPlatform.updater, projects: !!window.betterttsPlatform.projects, ffmpeg: !!window.betterttsPlatform.ffmpeg, whisper: !!window.betterttsPlatform.whisper, sidecar: !!window.betterttsPlatform.sidecar, byoWeights: !!window.betterttsPlatform.byoWeights, rvc: !!window.betterttsPlatform.rvc, rvcWeights: !!window.betterttsPlatform.rvcWeights, openAiServer: !!window.betterttsPlatform.openAiServer, desktopIntegrations: !!window.betterttsPlatform.desktopIntegrations, desktopDiagnostics: !!window.betterttsPlatform.desktopDiagnostics }
        : null,
    }))()`)) as { brand: string | null; railItems: number; generate: boolean; platform: { kind: string; nativeTts: boolean; updater: boolean; projects: boolean; ffmpeg: boolean; whisper: boolean; sidecar: boolean; byoWeights: boolean; rvc: boolean; rvcWeights: boolean; openAiServer: boolean; desktopIntegrations: boolean; desktopDiagnostics: boolean } | null }

    let screenshotSize: { width: number; height: number } | null = null
    try {
      const image = await win.webContents.capturePage()
      screenshotSize = image.getSize()
      const screenshotPath = join(smokeOutputDirectory, 'smoke.png')
      await writeFile(screenshotPath, image.toPNG())
      result.screenshot = screenshotPath
    } catch {
      /* capture is best-effort on a hidden window */
    }

    const display = screen.getDisplayMatching(win.getBounds())
    result.nativeWindow = {
      bounds: win.getBounds(),
      display: {
        id: display.id,
        scaleFactor: display.scaleFactor,
        bounds: display.bounds,
        workArea: display.workArea,
      },
      screenshot: screenshotSize,
      highDpiCapture: Boolean(
        screenshotSize
        && screenshotSize.width > 0
        && screenshotSize.height > 0
        && Number.isFinite(display.scaleFactor)
        && display.scaleFactor >= 1,
      ),
    }

    result.accessibility = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const root = document.documentElement
      const themeButton = document.querySelector('.theme-button')
      const initialTheme = root.dataset.theme ?? null
      themeButton?.click()
      await wait(50)
      const switchedTheme = root.dataset.theme ?? null
      themeButton?.click()
      await wait(50)
      const restoredTheme = root.dataset.theme ?? null

      const focusCheck = (element, surface = element) => {
        if (!element) return { reachable: false, visible: false }
        try { element.focus({ focusVisible: true }) } catch { element.focus() }
        const style = getComputedStyle(surface)
        const outlineVisible = style.outlineStyle !== 'none' && style.outlineWidth !== '0px'
        const ringVisible = style.boxShadow !== 'none'
        return {
          reachable: document.activeElement === element,
          visible: element.matches(':focus-visible') && (outlineVisible || ringVisible),
        }
      }

      const skip = document.querySelector('.skip-link')
      const editor = document.querySelector('#script-editor')
      const editorSurface = editor?.closest('.editor-frame')
      const generate = document.querySelector('.generate-button')
      const skipFocus = focusCheck(skip)
      const editorFocus = focusCheck(editor, editorSurface ?? editor)
      const generateFocus = focusCheck(generate)
      return {
        theme: {
          initial: initialTheme,
          switched: switchedTheme,
          restored: restoredTheme,
          changed: switchedTheme !== null && switchedTheme !== initialTheme && restoredTheme === initialTheme,
        },
        keyboardPath: {
          skipLink: skipFocus,
          editor: editorFocus,
          generate: generateFocus,
          skipTarget: skip?.getAttribute('href') === '#script-editor',
          generateEnabled: generate instanceof HTMLButtonElement && !generate.disabled,
        },
      }
    })()`)

    result.updaterUi = await win.webContents.executeJavaScript(`(async () => {
      const toggle = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('System & diagnostics'))
      toggle?.click()
      await new Promise((resolve) => setTimeout(resolve, 50))
      const panel = document.querySelector('[aria-label="Desktop updates"]')
      const projectPanel = document.querySelector('[aria-label="Desktop project"]')
      projectPanel?.scrollIntoView({ block: 'center' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      const updater = window.betterttsPlatform?.updater
      let statusEvents = 0
      const unsubscribe = updater?.onStatus(() => { statusEvents += 1 })
      updater?.check()
      await new Promise((resolve) => setTimeout(resolve, 100))
      unsubscribe?.()
      return {
        panel: !!panel,
        checkAction: !!Array.from(panel?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('Check now')),
        smokeActionDisabled: statusEvents === 0,
        projectPanel: !!projectPanel,
        projectActions: Array.from(projectPanel?.querySelectorAll('button') ?? []).map((button) => button.textContent?.trim()),
      }
    })()`)
    result.filePicker = await win.webContents.executeJavaScript(`(async () => {
      const platform = window.betterttsPlatform
      const [byo, rvcModel, rvcIndex, folder] = await Promise.all([
        platform?.byoWeights?.choose('f5-tts') ?? Promise.resolve({ canceled: false }),
        platform?.rvcWeights?.chooseModel() ?? Promise.resolve({ canceled: false }),
        platform?.rvcWeights?.chooseIndex() ?? Promise.resolve({ canceled: false }),
        platform?.desktopIntegrations?.chooseFolder() ?? Promise.resolve({ canceled: false }),
      ])
      return {
        available: Boolean(platform?.byoWeights && platform?.rvcWeights && platform?.desktopIntegrations),
        canceled: [byo, rvcModel, rvcIndex, folder].every((entry) => entry?.canceled === true),
      }
    })()`)
    result.desktopIntegrationsUi = await win.webContents.executeJavaScript(`(async () => {
      let panel = document.querySelector('[aria-label="Desktop workflow integrations"]')
      for (let attempt = 0; !panel && attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        panel = document.querySelector('[aria-label="Desktop workflow integrations"]')
      }
      panel?.scrollIntoView({ block: 'center' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      const inputs = Array.from(panel?.querySelectorAll('input[type="checkbox"]') ?? [])
      return {
        panel: !!panel,
        toggleCount: inputs.length,
        disabledByDefault: inputs.length === 5 && inputs.every((input) => !input.checked),
        ocrAction: !!Array.from(panel?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('OCR screen to script')),
        folderAction: !!Array.from(panel?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('Import folder')),
      }
    })()`)
    const desktopIntegrationsImage = await win.webContents.capturePage()
    const desktopIntegrationsScreenshotPath = join(smokeOutputDirectory, 'desktop-integrations-smoke.png')
    await writeFile(desktopIntegrationsScreenshotPath, desktopIntegrationsImage.toPNG())
    result.desktopIntegrationsScreenshot = desktopIntegrationsScreenshotPath
    result.desktopDiagnostics = await win.webContents.executeJavaScript(`(async () => {
      const bridge = window.betterttsPlatform?.desktopDiagnostics
      if (!bridge) return { available: false }
      const snapshot = await bridge.collect({
        selection: {
          engine: 'kokoro',
          engineStatus: 'Smoke check',
          runtime: 'sherpa-onnx-node',
          selectedModel: 'smoke script text must not be forwarded',
          modelRoutes: { importedArticle: 'https://article.test/private/story' },
        },
        runtime: { native: { modelCacheDir: 'C:\\\\Users\\\\smoke\\\\BetterTTS' } },
      })
      const serialized = JSON.stringify(snapshot)
      return {
        available: true,
        schemaVersion: snapshot.schemaVersion,
        hasManifest: !!snapshot.selection?.modelManifest,
        hasFfmpeg: typeof snapshot.ffmpeg?.available === 'boolean',
        hasLogs: Array.isArray(snapshot.recentLogs),
        redacted: !serialized.includes('article.test') && !serialized.includes('smoke script text'),
      }
    })()`)
    result.openAiUi = await win.webContents.executeJavaScript(`(async () => {
      const panel = document.querySelector('[aria-label="Local OpenAI-compatible TTS server"]')
      panel?.scrollIntoView({ block: 'center' })
      await new Promise((resolve) => setTimeout(resolve, 100))
      return {
        panel: !!panel,
        startAction: !!Array.from(panel?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('Start server')),
        stoppedByDefault: panel?.querySelector('[role="status"]')?.textContent?.includes('Stopped') ?? false,
      }
    })()`)
    result.narratorUi = await win.webContents.executeJavaScript(`(async () => {
      const advancedToggle = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Advanced options'))
      if (advancedToggle && advancedToggle.getAttribute('aria-expanded') !== 'true') advancedToggle.click()
      await new Promise((resolve) => setTimeout(resolve, 100))
      const toggle = document.querySelector('#narrator-mode')
      if (toggle && !toggle.checked) toggle.click()
      await new Promise((resolve) => setTimeout(resolve, 100))
      return {
        toggle: !!toggle,
        enabled: toggle?.checked ?? false,
        narrationVoice: !!document.querySelector('[aria-label="Narration voice"]'),
        dialogueVoice: !!document.querySelector('[aria-label="Dialogue voice"]'),
      }
    })()`)
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('[aria-label="Narrator role voices"]')?.scrollIntoView({ block: 'center' })
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const narratorImage = await win.webContents.capturePage()
    const narratorScreenshotPath = join(smokeOutputDirectory, 'narrator-smoke.png')
    await writeFile(narratorScreenshotPath, narratorImage.toPNG())
    result.narratorScreenshot = narratorScreenshotPath
    result.rvcUi = await win.webContents.executeJavaScript(`(async () => {
      const panel = document.querySelector('[aria-label="RVC model registry"]')
      panel?.scrollIntoView({ block: 'center' })
      await new Promise((resolve) => setTimeout(resolve, 100))
      const consentInput = panel?.querySelector('#rvc-consent')
      if (consentInput && !consentInput.checked) consentInput.click()
      await new Promise((resolve) => setTimeout(resolve, 100))
      return {
        panel: !!panel,
        consent: consentInput?.checked ?? false,
        registerAction: !!Array.from(panel?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('Register RVC model')),
        setupAction: !!Array.from(panel?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('Set up RVC runtime')),
      }
    })()`)
    const openAiImage = await win.webContents.capturePage()
    const openAiScreenshotPath = join(smokeOutputDirectory, 'openai-smoke.png')
    await writeFile(openAiScreenshotPath, openAiImage.toPNG())
    result.openAiScreenshot = openAiScreenshotPath
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('[aria-label="Desktop project"]')?.scrollIntoView({ block: 'center' })
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const systemImage = await win.webContents.capturePage()
    const systemScreenshotPath = join(smokeOutputDirectory, 'system-smoke.png')
    await writeFile(systemScreenshotPath, systemImage.toPNG())
    result.systemScreenshot = systemScreenshotPath

    result.projectIo = await win.webContents.executeJavaScript(`(async () => {
      const projects = window.betterttsPlatform?.projects
      if (!projects) return null
      const source = new Uint8Array([0x50, 0x4b, 3, 4, 5])
      const saved = await projects.save(source, 'Smoke project')
      const opened = await projects.open()
      const bytes = opened.bytes ? Array.from(opened.bytes) : []
      await projects.forget()
      return { saved: !saved.canceled && saved.name?.endsWith('.bettertts'), opened: !opened.canceled, bytes }
    })()`)
    result.ffmpeg = await win.webContents.executeJavaScript(`(async () => {
      const bridge = window.betterttsPlatform?.ffmpeg
      if (!bridge) return null
      const status = await bridge.status()
      if (!status.available) return status
      const samples = new Float32Array(2400)
      for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * Math.PI / 12) * 0.1
      const output = await bridge.transcode({ samples, sampleRate: 24000, format: 'flac', bitrate: 128, title: 'Smoke' })
      const cleanup = await bridge.transcode({ samples, sampleRate: 24000, format: 'wav', bitrate: 128, title: 'Smoke cleanup', cleanupMode: 'denoise' })
      const studio = await bridge.transcode({ samples, sampleRate: 24000, format: 'wav', bitrate: 128, title: 'Smoke studio', cleanupMode: 'studio' })
      return { ...status, outputBytes: output.bytes.byteLength, extension: output.extension, cleanupOutputBytes: cleanup.bytes.byteLength, studioOutputBytes: studio.bytes.byteLength }
    })()`)
    result.audioCleanupUi = await win.webContents.executeJavaScript(`(() => {
      const toggle = document.querySelector('#audio-cleanup')
      return {
        control: toggle?.getAttribute('type') === 'checkbox',
        disabledByDefault: toggle?.getAttribute('aria-checked') !== 'true' && toggle?.checked === false,
      }
    })()`)
    result.engineUi = await win.webContents.executeJavaScript(`(() => {
      const locale = document.querySelector('#locale')
      const localeIds = Array.from(locale?.querySelectorAll('option') ?? []).map((option) => option.value)
      const meloCard = Array.from(document.querySelectorAll('.engine-card')).some((card) => card.textContent?.includes('MeloTTS'))
      return {
        japanese: localeIds.includes('ja'),
        mandarin: localeIds.includes('cmn'),
        meloCard,
      }
    })()`)
    result.openAiServer = await probeOpenAiTtsServer()

    try {
      const nativeHost = (await probeTtsHostInfo()) as { runtime?: unknown }
      result.nativeHost = nativeHost.runtime ?? nativeHost
      if (LOAD_NATIVE_IN_SMOKE) {
        const nativeLoad = (await probeTtsHostLoad()) as { key?: unknown; runtime?: unknown }
        result.nativeLoad = { key: nativeLoad.key, runtime: nativeLoad.runtime }
        const cancellationStartedAt = performance.now()
        await probeTtsHostCancellation()
        result.nativeCancellation = { ok: true, elapsedMs: Math.round(performance.now() - cancellationStartedAt) }
        const generationStartedAt = performance.now()
        const samples = await probeTtsHostGenerate('Packaged BetterTTS synthesis is working.', 91002)
        const generationMs = performance.now() - generationStartedAt
        if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample))) throw new Error('native host produced invalid samples')
        const decoded = await decodeSmokeWav(win, encodeSmokeWav(samples))
        const audioSeconds = samples.length / 24000
        result.nativeSynthesis = {
          // decodeAudioData may resample into the machine's output context;
          // duration must still agree with the 24 kHz source header.
          ok: decoded.duration > 0 && Math.abs(decoded.duration - audioSeconds) < 0.02,
          samples: samples.length,
          audioSeconds: Number(audioSeconds.toFixed(2)),
          generationMs: Math.round(generationMs),
          realTimeFactor: Number(((generationMs / 1000) / audioSeconds).toFixed(2)),
          decoded,
          cues: [{ index: 1, startSec: 0, endSec: audioSeconds, text: 'Packaged BetterTTS synthesis is working.' }],
        }
      }
    } catch (err) {
      result.nativeHostError = err instanceof Error ? err.message : String(err)
    }

    try {
      result.whisperStatus = await probeWhisperHostStatus()
    } catch (err) {
      result.whisperStatusError = err instanceof Error ? err.message : String(err)
    }

    try {
      result.sidecarStatus = await probeSidecarHostStatus()
    } catch (err) {
      result.sidecarStatusError = err instanceof Error ? err.message : String(err)
    }

    try {
      result.rvcStatus = await win.webContents.executeJavaScript(`(async () => {
        const bridge = window.betterttsPlatform?.rvc
        if (!bridge) return null
        const id = 987654
        return await Promise.race([
          new Promise((resolve) => {
            const unsubscribe = bridge.onMessage((message) => {
              if (message && typeof message === 'object' && message.type === 'status' && message.id === id) {
                unsubscribe()
                resolve(message.status ?? null)
              }
            })
            bridge.post({ type: 'status', id })
          }),
          new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
        ])
      })()`)
    } catch (err) {
      result.rvcStatusError = err instanceof Error ? err.message : String(err)
    }

    const nativeWindow = result.nativeWindow as { highDpiCapture?: boolean } | undefined
    const accessibility = result.accessibility as {
      theme?: { changed?: boolean }
      keyboardPath?: {
        skipLink?: { reachable?: boolean; visible?: boolean }
        editor?: { reachable?: boolean; visible?: boolean }
        generate?: { reachable?: boolean; visible?: boolean }
        skipTarget?: boolean
        generateEnabled?: boolean
      }
    } | undefined
    const keyboardPath = accessibility?.keyboardPath
    const updaterUi = result.updaterUi as { panel?: boolean; checkAction?: boolean; smokeActionDisabled?: boolean; projectPanel?: boolean; projectActions?: string[] } | undefined
    const filePicker = result.filePicker as { available?: boolean; canceled?: boolean } | undefined
    result.ok =
      probe.brand === 'BetterTTS' &&
      probe.railItems >= 5 &&
      probe.generate &&
      Boolean(probe.platform) &&
      probe.platform?.whisper === true &&
      probe.platform?.sidecar === true &&
      probe.platform?.byoWeights === true &&
      probe.platform?.rvc === true &&
      probe.platform?.rvcWeights === true &&
      probe.platform?.updater === true &&
      probe.platform?.projects === true &&
      probe.platform?.ffmpeg === true &&
      probe.platform?.openAiServer === true &&
      probe.platform?.desktopIntegrations === true &&
      probe.platform?.desktopDiagnostics === true &&
      Boolean(updaterUi?.panel) &&
      Boolean(updaterUi?.checkAction) &&
      Boolean(updaterUi?.smokeActionDisabled) &&
      Boolean(nativeWindow?.highDpiCapture) &&
      Boolean(accessibility?.theme?.changed) &&
      Boolean(keyboardPath?.skipLink?.reachable) &&
      Boolean(keyboardPath?.skipLink?.visible) &&
      Boolean(keyboardPath?.editor?.reachable) &&
      Boolean(keyboardPath?.editor?.visible) &&
      Boolean(keyboardPath?.generate?.reachable) &&
      Boolean(keyboardPath?.generate?.visible) &&
      Boolean(keyboardPath?.skipTarget) &&
      Boolean(keyboardPath?.generateEnabled) &&
      Boolean(filePicker?.available) &&
      Boolean(filePicker?.canceled) &&
      Boolean(updaterUi?.projectPanel) &&
      (updaterUi?.projectActions?.some((label) => label?.includes('Create project')) ?? false) &&
      Boolean((result.openAiUi as { panel?: boolean; startAction?: boolean; stoppedByDefault?: boolean } | undefined)?.panel) &&
      Boolean((result.openAiUi as { startAction?: boolean } | undefined)?.startAction) &&
      Boolean((result.openAiUi as { stoppedByDefault?: boolean } | undefined)?.stoppedByDefault) &&
      Boolean((result.desktopIntegrationsUi as { panel?: boolean; toggleCount?: number; disabledByDefault?: boolean; ocrAction?: boolean; folderAction?: boolean } | undefined)?.panel) &&
      (result.desktopIntegrationsUi as { toggleCount?: number } | undefined)?.toggleCount === 5 &&
      Boolean((result.desktopIntegrationsUi as { disabledByDefault?: boolean } | undefined)?.disabledByDefault) &&
      Boolean((result.desktopIntegrationsUi as { ocrAction?: boolean } | undefined)?.ocrAction) &&
      Boolean((result.desktopIntegrationsUi as { folderAction?: boolean } | undefined)?.folderAction) &&
      Boolean((result.desktopDiagnostics as { available?: boolean; schemaVersion?: number; hasManifest?: boolean; hasFfmpeg?: boolean; hasLogs?: boolean; redacted?: boolean } | undefined)?.available) &&
      (result.desktopDiagnostics as { schemaVersion?: number } | undefined)?.schemaVersion === 1 &&
      Boolean((result.desktopDiagnostics as { hasManifest?: boolean; hasFfmpeg?: boolean; hasLogs?: boolean; redacted?: boolean } | undefined)?.hasManifest) &&
      Boolean((result.desktopDiagnostics as { hasFfmpeg?: boolean } | undefined)?.hasFfmpeg) &&
      Boolean((result.desktopDiagnostics as { hasLogs?: boolean } | undefined)?.hasLogs) &&
      Boolean((result.desktopDiagnostics as { redacted?: boolean } | undefined)?.redacted) &&
      Boolean((result.narratorUi as { toggle?: boolean; enabled?: boolean; narrationVoice?: boolean; dialogueVoice?: boolean } | undefined)?.toggle) &&
      Boolean((result.narratorUi as { enabled?: boolean } | undefined)?.enabled) &&
      Boolean((result.narratorUi as { narrationVoice?: boolean; dialogueVoice?: boolean } | undefined)?.narrationVoice) &&
      Boolean((result.narratorUi as { narrationVoice?: boolean; dialogueVoice?: boolean } | undefined)?.dialogueVoice) &&
      Boolean((result.rvcUi as { panel?: boolean; consent?: boolean; registerAction?: boolean; setupAction?: boolean } | undefined)?.panel) &&
      Boolean((result.rvcUi as { consent?: boolean } | undefined)?.consent) &&
      Boolean((result.rvcUi as { registerAction?: boolean } | undefined)?.registerAction) &&
      Boolean((result.rvcUi as { setupAction?: boolean } | undefined)?.setupAction) &&
      Boolean((result.projectIo as { saved?: boolean; opened?: boolean } | undefined)?.saved) &&
      Boolean((result.projectIo as { saved?: boolean; opened?: boolean } | undefined)?.opened) &&
      JSON.stringify((result.projectIo as { bytes?: number[] } | undefined)?.bytes) === '[80,75,3,4,5]' &&
      (!((result.ffmpeg as { available?: boolean } | undefined)?.available) || (
        ((result.ffmpeg as { outputBytes?: number } | undefined)?.outputBytes ?? 0) > 0
        && (result.ffmpeg as { extension?: string } | undefined)?.extension === '.flac'
        && ((result.ffmpeg as { cleanupOutputBytes?: number } | undefined)?.cleanupOutputBytes ?? 0) > 0
        && ((result.ffmpeg as { studioOutputBytes?: number } | undefined)?.studioOutputBytes ?? 0) > 0
      )) &&
      Boolean((result.audioCleanupUi as { control?: boolean; disabledByDefault?: boolean } | undefined)?.control) &&
      Boolean((result.audioCleanupUi as { disabledByDefault?: boolean } | undefined)?.disabledByDefault) &&
      Boolean((result.engineUi as { japanese?: boolean; mandarin?: boolean; meloCard?: boolean } | undefined)?.japanese) &&
      Boolean((result.engineUi as { mandarin?: boolean } | undefined)?.mandarin) &&
      Boolean((result.engineUi as { meloCard?: boolean } | undefined)?.meloCard) &&
      Boolean(result.nativeHost) &&
      Boolean(result.whisperStatus) &&
      Boolean(result.sidecarStatus) &&
      Boolean((result.openAiServer as { before?: { running?: boolean }; started?: { running?: boolean; host?: string }; health?: { ok?: boolean }; stopped?: { running?: boolean } } | undefined)?.before?.running === false) &&
      Boolean((result.openAiServer as { started?: { running?: boolean; host?: string } } | undefined)?.started?.running === true) &&
      (result.openAiServer as { started?: { host?: string } } | undefined)?.started?.host === '127.0.0.1' &&
      Boolean((result.openAiServer as { health?: { ok?: boolean } } | undefined)?.health?.ok) &&
      Boolean((result.openAiServer as { stopped?: { running?: boolean } } | undefined)?.stopped?.running === false) &&
      (!LOAD_NATIVE_IN_SMOKE || (
        Boolean(result.nativeLoad)
        && Boolean((result.nativeCancellation as { ok?: boolean } | undefined)?.ok)
        && Boolean((result.nativeSynthesis as { ok?: boolean } | undefined)?.ok)
      ))
    result.probe = probe
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  }

  if (process.env.BETTERTTS_SMOKE_REPORT) {
    await writeFile(process.env.BETTERTTS_SMOKE_REPORT, `${JSON.stringify(result, null, 2)}\n`).catch(() => undefined)
  }
  console.log(JSON.stringify(result, null, 2))
  app.exit(result.ok ? 0 : 1)
}

app.whenReady().then(async () => {
  if (!HAS_SINGLE_INSTANCE_LOCK) return
  await initializeDesktopIntegrations()
  if (IS_DEV) applyDevSecurityHeaders()
  else registerAppProtocol()

  const win = createWindow()
  configureUpdater()
  if (IS_SMOKE) void runSmoke(win)
  if (initialExternalOpenPath) void queueExternalFile(initialExternalOpenPath)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  if (desktopHotkeyRegistered) globalShortcut.unregister(DESKTOP_INTEGRATION_HOTKEY)
  if (desktopTray) {
    desktopTray.destroy()
    desktopTray = null
  }
})

app.on('window-all-closed', () => {
  if (desktopTray) return
  if (process.platform !== 'darwin') app.quit()
})
