import { app, BrowserWindow, ipcMain, protocol, session, shell, utilityProcess } from 'electron'
import type { UtilityProcess, WebContents } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

// In dev the renderer is served by Vite; in production it is served from the
// packaged dist/ over a custom app:// scheme so we control the response headers
// (COOP/COEP for SharedArrayBuffer + threaded WASM, CSP, CORP).
const DEV_URL = process.env.BETTERTTS_DEV_URL
const IS_DEV = Boolean(DEV_URL)
const IS_SMOKE = process.argv.includes('--smoke')
const LOAD_NATIVE_IN_SMOKE = process.env.BETTERTTS_SMOKE_NATIVE_LOAD === '1'

app.setName('BetterTTS')

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
  const root = normalize(rendererDir())
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url)
    let rel = decodeURIComponent(pathname)
    if (rel === '/' || rel === '') rel = '/index.html'
    const filePath = normalize(join(root, rel))
    // Contain the resolved path to the renderer directory.
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      const data = await readFile(filePath)
      return new Response(data, { headers: { 'Content-Type': contentType(filePath), ...SECURITY_HEADERS } })
    } catch {
      // SPA fallback so deep links resolve to the app shell.
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
let ttsHost: UtilityProcess | null = null
let ttsHostSubscriber: WebContents | null = null

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
  ttsHostSubscriber = event.sender
  if (
    message
    && typeof message === 'object'
    && ['reset', 'cancel-all', 'cancel'].includes((message as { type?: string }).type ?? '')
  ) {
    const host = ttsHost
    ttsHost = null
    host?.kill()
    return
  }
  ensureTtsHost().postMessage(message)
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
    if (!IS_SMOKE) win.show()
  })

  win.loadURL(IS_DEV ? DEV_URL! : `${APP_ORIGIN}/index.html`)
  return win
}

// Headless render check: loads the app, confirms React actually mounted, writes
// a screenshot, and exits — without ever stealing focus (window stays hidden).
async function runSmoke(win: BrowserWindow): Promise<void> {
  const result: Record<string, unknown> = { ok: false }
  try {
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
        ? { kind: window.betterttsPlatform.kind, nativeTts: !!window.betterttsPlatform.nativeTts }
        : null,
    }))()`)) as { brand: string | null; railItems: number; generate: boolean; platform: { kind: string; nativeTts: boolean } | null }

    try {
      const image = await win.webContents.capturePage()
      await writeFile(join(app.getAppPath(), 'dist-electron', 'smoke.png'), image.toPNG())
      result.screenshot = 'dist-electron/smoke.png'
    } catch {
      /* capture is best-effort on a hidden window */
    }

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

    result.ok =
      probe.brand === 'BetterTTS' &&
      probe.railItems >= 5 &&
      probe.generate &&
      Boolean(probe.platform) &&
      Boolean(result.nativeHost) &&
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
  if (IS_SMOKE) void runSmoke(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
