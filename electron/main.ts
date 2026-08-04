import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell, utilityProcess } from 'electron'
import type { UtilityProcess, WebContents } from 'electron'
import { autoUpdater } from 'electron-updater'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import {
  ProjectConflictError,
  readProjectSnapshot,
  writeProjectFile,
} from './project-files.mjs'
import { buildM4bAudiobook, probeFfmpeg, transcodePcm } from './ffmpeg.mjs'
import { getByoModelOption } from '../src/lib/byo-models.ts'
import { BYO_WEIGHTS_CHANNEL, validateByoWeightsRequest } from './byo-ipc.ts'
import { validateNativeTtsRequest } from './native-ipc.ts'
import { SIDECAR_CHANNEL, validateSidecarRequest } from './sidecar-ipc.ts'
import { WHISPER_CHANNEL, validateWhisperRequest } from './whisper-ipc.ts'
import { resolveRendererRequest } from './app-protocol.ts'
import { resolveSmokeOutputDirectory } from './smoke-output.ts'

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
let ttsHost: UtilityProcess | null = null
let ttsHostSubscriber: WebContents | null = null
let whisperHost: UtilityProcess | null = null
let whisperHostSubscriber: WebContents | null = null
let sidecarHost: UtilityProcess | null = null
let sidecarHostSubscriber: WebContents | null = null
let activeProjectPath: string | null = null
let activeProjectIdentity: {
  revision: string
  sha256: string
  mtimeMs: number
  size: number
} | null = null

function sendToSubscriber(message: unknown): void {
  if (ttsHostSubscriber && !ttsHostSubscriber.isDestroyed()) {
    ttsHostSubscriber.send(NATIVE_TTS_CHANNEL, message)
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
  host.on('message', (message) => sendToSubscriber(message))
  host.on('exit', () => {
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
  if (request.type === 'reset' || request.type === 'cancel-all' || request.type === 'cancel') {
    const host = ttsHost
    ttsHost = null
    host?.kill()
    return
  }
  ensureTtsHost().postMessage(request)
})

// --- whisper.cpp caption host (TF-117) --------------------------------------
// Caption inference follows the same isolated utility-process boundary as
// native TTS. The host owns the optional whisper.cpp executable, the model
// path, temporary audio files, and child-process cancellation.
function sendToWhisperSubscriber(message: unknown): void {
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
    chunks?: Array<{ bytes: Uint8Array; title: string }>
    cover?: { bytes: Uint8Array }
  }
  if (message.action === 'status') return probeFfmpeg()
  if (message.action === 'transcode' && message.samples && message.sampleRate && message.format) {
    return transcodePcm(message)
  }
  if (message.action === 'audiobook' && message.chunks) return buildM4bAudiobook(message)
  throw new Error('Unsupported FFmpeg action.')
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
        ? { kind: window.betterttsPlatform.kind, nativeTts: !!window.betterttsPlatform.nativeTts, updater: !!window.betterttsPlatform.updater, projects: !!window.betterttsPlatform.projects, ffmpeg: !!window.betterttsPlatform.ffmpeg, whisper: !!window.betterttsPlatform.whisper, sidecar: !!window.betterttsPlatform.sidecar, byoWeights: !!window.betterttsPlatform.byoWeights }
        : null,
    }))()`)) as { brand: string | null; railItems: number; generate: boolean; platform: { kind: string; nativeTts: boolean; updater: boolean; projects: boolean; ffmpeg: boolean; whisper: boolean; sidecar: boolean; byoWeights: boolean } | null }

    try {
      const image = await win.webContents.capturePage()
      const screenshotPath = join(smokeOutputDirectory, 'smoke.png')
      await writeFile(screenshotPath, image.toPNG())
      result.screenshot = screenshotPath
    } catch {
      /* capture is best-effort on a hidden window */
    }

    result.updaterUi = await win.webContents.executeJavaScript(`(async () => {
      const toggle = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('System & diagnostics'))
      toggle?.click()
      await new Promise((resolve) => setTimeout(resolve, 50))
      const panel = document.querySelector('[aria-label="Desktop updates"]')
      const projectPanel = document.querySelector('[aria-label="Desktop project"]')
      projectPanel?.scrollIntoView({ block: 'center' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      return {
        panel: !!panel,
        checkAction: !!Array.from(panel?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('Check now')),
        projectPanel: !!projectPanel,
        projectActions: Array.from(projectPanel?.querySelectorAll('button') ?? []).map((button) => button.textContent?.trim()),
      }
    })()`)
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
      return { ...status, outputBytes: output.bytes.byteLength, extension: output.extension }
    })()`)

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

    result.ok =
      probe.brand === 'BetterTTS' &&
      probe.railItems >= 5 &&
      probe.generate &&
      Boolean(probe.platform) &&
      probe.platform?.whisper === true &&
      probe.platform?.sidecar === true &&
      probe.platform?.byoWeights === true &&
      probe.platform?.updater === true &&
      probe.platform?.projects === true &&
      probe.platform?.ffmpeg === true &&
      Boolean((result.updaterUi as { panel?: boolean; checkAction?: boolean } | undefined)?.panel) &&
      Boolean((result.updaterUi as { panel?: boolean; checkAction?: boolean } | undefined)?.checkAction) &&
      Boolean((result.updaterUi as { projectPanel?: boolean } | undefined)?.projectPanel) &&
      ((result.updaterUi as { projectActions?: string[] } | undefined)?.projectActions?.some((label) => label?.includes('Create project')) ?? false) &&
      Boolean((result.projectIo as { saved?: boolean; opened?: boolean } | undefined)?.saved) &&
      Boolean((result.projectIo as { saved?: boolean; opened?: boolean } | undefined)?.opened) &&
      JSON.stringify((result.projectIo as { bytes?: number[] } | undefined)?.bytes) === '[80,75,3,4,5]' &&
      (!((result.ffmpeg as { available?: boolean } | undefined)?.available) || (
        ((result.ffmpeg as { outputBytes?: number } | undefined)?.outputBytes ?? 0) > 0
        && (result.ffmpeg as { extension?: string } | undefined)?.extension === '.flac'
      )) &&
      Boolean(result.nativeHost) &&
      Boolean(result.whisperStatus) &&
      Boolean(result.sidecarStatus) &&
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

app.whenReady().then(() => {
  if (IS_DEV) applyDevSecurityHeaders()
  else registerAppProtocol()

  const win = createWindow()
  configureUpdater()
  if (IS_SMOKE) void runSmoke(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
