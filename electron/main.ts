import { app, BrowserWindow, protocol, session, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

// In dev the renderer is served by Vite; in production it is served from the
// packaged dist/ over a custom app:// scheme so we control the response headers
// (COOP/COEP for SharedArrayBuffer + threaded WASM, CSP, CORP).
const DEV_URL = process.env.BETTERTTS_DEV_URL
const IS_DEV = Boolean(DEV_URL)
const IS_SMOKE = process.argv.includes('--smoke')

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
    backgroundColor: '#05080d',
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

    const probe = (await win.webContents.executeJavaScript(`(() => ({
      brand: document.querySelector('.brand')?.textContent?.trim() ?? null,
      railItems: document.querySelectorAll('.rail-link').length,
      generate: !!document.querySelector('.generate-button'),
      platform: window.betterttsPlatform ?? null,
    }))()`)) as { brand: string | null; railItems: number; generate: boolean; platform: unknown }

    try {
      const image = await win.webContents.capturePage()
      await writeFile(join(app.getAppPath(), 'dist-electron', 'smoke.png'), image.toPNG())
      result.screenshot = 'dist-electron/smoke.png'
    } catch {
      /* capture is best-effort on a hidden window */
    }

    result.ok = probe.brand === 'BetterTTS' && probe.railItems >= 5 && probe.generate && Boolean(probe.platform)
    result.probe = probe
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
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
