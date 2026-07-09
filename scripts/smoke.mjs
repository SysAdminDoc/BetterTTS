import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'

const root = process.cwd()
const port = Number(process.env.BETTERTTS_SMOKE_PORT ?? 4873)
const baseUrl = `http://127.0.0.1:${port}/BetterTTS/`
const distDir = join(root, 'dist')
const smokeDir = join(root, 'dist', 'smoke')
const allowedConsole = [
  'No available adapters',
  'WebGPU',
]

function command(name, args) {
  if (process.platform !== 'win32') return { file: name, args }
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', name, ...args] }
}

function runChecked(name, args) {
  const cmd = command(name, args)
  const result = spawnSync(cmd.file, cmd.args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    stdio: 'pipe',
    timeout: 180000,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

async function seedCompletedQueueJob(page, id) {
  await page.evaluate(async (jobId) => {
    await new Promise((resolve) => {
      const deleteReq = indexedDB.deleteDatabase('bettertts-queue')
      deleteReq.onsuccess = deleteReq.onerror = deleteReq.onblocked = () => resolve()
    })

    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('bettertts-queue', 2)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

    const tx = db.transaction(['jobs', 'chunks'], 'readwrite')
    tx.objectStore('jobs').put({
      schemaVersion: 2,
      id: jobId,
      title: 'Smoke queue',
      createdAt: Date.now(),
      engine: 'kokoro',
      voice: 'af_heart',
      language: 'en-us',
      speed: 1,
      format: 'opus',
      bitrate: 96,
      chunks: [
        { index: 0, text: 'Smoke chapter one.', status: 'done', chapterTitle: 'One', chapterIndex: 0 },
        { index: 1, text: 'Smoke chapter two.', status: 'done', chapterTitle: 'Two', chapterIndex: 1 },
      ],
    })
    tx.objectStore('chunks').put(new Blob(['first'], { type: 'audio/webm' }), `${jobId}:0`)
    tx.objectStore('chunks').put(new Blob(['second'], { type: 'audio/webm' }), `${jobId}:1`)
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, id)
}

async function openSeededApp(context, jobId) {
  const page = await context.newPage()
  const messages = []
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) messages.push(`${msg.type()}: ${msg.text()}`)
  })
  page.on('pageerror', (err) => messages.push(`pageerror: ${err.message}`))

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.getByText('BetterTTS').first().waitFor({ timeout: 20000 })
  await seedCompletedQueueJob(page, jobId)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByLabel('Generation queue').waitFor({ timeout: 20000 })
  return { page, messages }
}

async function runSmoke() {
  console.log('Building production app...')
  runChecked('npm', ['run', 'build'])
  if (existsSync(smokeDir)) rmSync(smokeDir, { recursive: true, force: true })
  mkdirSync(smokeDir, { recursive: true })
  console.log(`Starting smoke server at ${baseUrl}`)
  const server = await startStaticServer()
  try {
    console.log('Running Chromium smoke checks...')

    const browser = await chromium.launch({ headless: true })
    const desktopContext = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1440, height: 950 },
    })
    await desktopContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })
    const desktop = await openSeededApp(desktopContext, 'smoke-default')
    const title = await desktop.page.title()
    if (!title.includes('BetterTTS')) throw new Error(`Unexpected page title: ${title}`)
    const body = await desktop.page.locator('body').innerText()
    const bodyLower = body.toLowerCase()
    if (!bodyLower.includes('script editor') || !bodyLower.includes('control console')) throw new Error('App shell did not render expected content')
    if (/Vite Error|Internal Server Error|Failed to compile/i.test(body)) throw new Error('Framework error overlay detected')

    const beforeTheme = await desktop.page.evaluate(() => document.documentElement.dataset.theme)
    await desktop.page.getByRole('button', { name: /Switch to/ }).click()
    const afterTheme = await desktop.page.evaluate(() => document.documentElement.dataset.theme)
    if (!afterTheme || afterTheme === beforeTheme) throw new Error(`Theme toggle did not change theme; got ${afterTheme}`)

    await desktop.page.getByLabel('Diagnostics export').scrollIntoViewIfNeeded()
    await desktop.page.getByRole('button', { name: 'Copy JSON' }).click()
    await desktop.page.getByText('Diagnostics copied to clipboard.').waitFor({ timeout: 20000 })

    const queue = desktop.page.getByLabel('Generation queue')
    await queue.scrollIntoViewIfNeeded()
    await desktop.page.getByRole('button', { name: /ZIP/ }).waitFor({ timeout: 20000 })
    await desktop.page.screenshot({ path: join(smokeDir, 'desktop.png'), fullPage: false })
    await desktopContext.close()

    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
    })
    await mobileContext.addInitScript(() => {
      class FakeAudioEncoder {
        static async isConfigSupported() {
          return { supported: false }
        }
      }
      Object.defineProperty(window, 'AudioEncoder', { configurable: true, value: FakeAudioEncoder })
      Object.defineProperty(window, 'AudioData', { configurable: true, value: class FakeAudioData {} })
      Object.defineProperty(window, 'AudioContext', {
        configurable: true,
        value: class FakeAudioContext {
          close() {
            return Promise.resolve()
          }
        },
      })
    })
    const mobile = await openSeededApp(mobileContext, 'smoke-unsupported')
    const fallbackText = await mobile.page.locator('.capability-strip').innerText()
    if (!fallbackText.includes('chaptered ZIP fallback')) throw new Error(`Missing M4B fallback copy: ${fallbackText}`)
    await mobile.page.getByRole('button', { name: 'ZIP fallback' }).waitFor({ timeout: 20000 })
    const m4bButton = mobile.page.getByRole('button', { name: 'M4B' })
    if (!(await m4bButton.isDisabled())) throw new Error('M4B button should be disabled in unsupported AAC smoke state')
    await mobile.page.getByLabel('Diagnostics export').scrollIntoViewIfNeeded()
    await mobile.page.screenshot({ path: join(smokeDir, 'mobile.png'), fullPage: false })
    await mobileContext.close()
    await browser.close()

    const allMessages = [...desktop.messages, ...mobile.messages]
    const unexpected = allMessages.filter((msg) => !allowedConsole.some((allowed) => msg.includes(allowed)))
    if (unexpected.length > 0) throw new Error(`Unexpected console messages:\n${unexpected.join('\n')}`)

    const summary = {
      ok: true,
      url: baseUrl,
      screenshots: ['dist/smoke/desktop.png', 'dist/smoke/mobile.png'],
      allowedConsoleMessages: allMessages,
    }
    await writeFile(join(smokeDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function startStaticServer() {
  const server = createServer(async (req, res) => {
    try {
      const filePath = await resolveRequestPath(req.url ?? '/')
      const body = await readFile(filePath)
      res.writeHead(200, { 'content-type': contentType(filePath) })
      res.end(body)
    } catch (err) {
      const status = err instanceof ResponseError ? err.status : 500
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(status === 404 ? 'Not found' : 'Smoke server error')
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

async function resolveRequestPath(rawUrl) {
  const pathname = new URL(rawUrl, baseUrl).pathname
  const basePath = '/BetterTTS/'
  let relativePath = pathname === '/BetterTTS'
    ? ''
    : pathname.startsWith(basePath)
      ? pathname.slice(basePath.length)
      : pathname.slice(1)
  if (!relativePath || relativePath.endsWith('/')) relativePath = `${relativePath}index.html`

  const candidate = normalize(join(distDir, decodeURIComponent(relativePath)))
  if (!candidate.startsWith(normalize(distDir))) throw new ResponseError(403)

  try {
    const info = await stat(candidate)
    if (info.isFile()) return candidate
  } catch {
    return join(distDir, 'index.html')
  }
  throw new ResponseError(404)
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case '.css': return 'text/css; charset=utf-8'
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.wasm': return 'application/wasm'
    case '.webmanifest': return 'application/manifest+json; charset=utf-8'
    case '.png': return 'image/png'
    case '.svg': return 'image/svg+xml'
    default: return 'application/octet-stream'
  }
}

class ResponseError extends Error {
  constructor(status) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

runSmoke().catch(async (err) => {
  console.error(err)
  process.exitCode = 1
})
