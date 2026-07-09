import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { chromium } from 'playwright'
import { zipSync } from 'fflate'

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

function makeDocxUpload() {
  const documentXml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Imported DOCX body.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Repeated Header</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second cleaned paragraph.</w:t></w:r></w:p>
  </w:body>
</w:document>`
  const zipped = zipSync({
    '[Content_Types].xml': new TextEncoder().encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'word/document.xml': new TextEncoder().encode(documentXml),
  })
  return {
    name: 'smoke.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(zipped),
  }
}

async function seedCompletedQueueJob(page, id) {
  await page.evaluate(async (jobId) => {
    function makeWavBlob(seconds = 3) {
      const sampleRate = 8000
      const samples = Math.floor(sampleRate * seconds)
      const buffer = new ArrayBuffer(44 + samples * 2)
      const view = new DataView(buffer)
      const write = (offset, value) => {
        for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
      }
      write(0, 'RIFF')
      view.setUint32(4, 36 + samples * 2, true)
      write(8, 'WAVE')
      write(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      write(36, 'data')
      view.setUint32(40, samples * 2, true)
      for (let i = 0; i < samples; i += 1) {
        const sample = Math.round(Math.sin((i / sampleRate) * Math.PI * 2 * 220) * 12000)
        view.setInt16(44 + i * 2, sample, true)
      }
      return new Blob([buffer], { type: 'audio/wav' })
    }

    const cueSet = [
      { index: 1, startSec: 0, endSec: 1.5, text: 'Smoke sentence one.' },
      { index: 2, startSec: 1.5, endSec: 3, text: 'Smoke sentence two.' },
    ]

    await new Promise((resolve) => {
      const deleteReq = indexedDB.deleteDatabase('bettertts-queue')
      deleteReq.onsuccess = deleteReq.onerror = deleteReq.onblocked = () => resolve()
    })
    await new Promise((resolve) => {
      const deleteReq = indexedDB.deleteDatabase('bettertts-library')
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
      format: 'wav',
      bitrate: 96,
      chunks: [
        { index: 0, text: 'Smoke chapter one.', status: 'done', chapterTitle: 'One', chapterIndex: 0, duration: '3.0s', cues: cueSet },
        { index: 1, text: 'Smoke chapter two.', status: 'done', chapterTitle: 'Two', chapterIndex: 1, duration: '3.0s', cues: cueSet },
      ],
    })
    tx.objectStore('chunks').put(makeWavBlob(), `${jobId}:0`)
    tx.objectStore('chunks').put(makeWavBlob(), `${jobId}:1`)
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()

    const libraryDb = await new Promise((resolve, reject) => {
      const req = indexedDB.open('bettertts-library', 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const libraryTx = libraryDb.transaction(['clips', 'blobs'], 'readwrite')
    libraryTx.objectStore('clips').put({
      id: 'smoke-library',
      filename: 'smoke-library.wav',
      label: 'Smoke library clip',
      voice: 'af_heart',
      speed: 1,
      createdAt: Date.now(),
      size: 48044,
      duration: '3.0s',
      cues: cueSet,
    })
    libraryTx.objectStore('blobs').put(makeWavBlob(), 'smoke-library')
    await new Promise((resolve, reject) => {
      libraryTx.oncomplete = resolve
      libraryTx.onerror = () => reject(libraryTx.error)
    })
    libraryDb.close()

    localStorage.setItem('bettertts-playback-v1', JSON.stringify({
      version: 1,
      items: {
        [`queue:${jobId}:0`]: { timeSec: 1.1, cueIndex: 0, updatedAt: Date.now() },
        'clip:smoke-library': { timeSec: 1.1, cueIndex: 0, updatedAt: Date.now() },
      },
    }))
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
    if (!bodyLower.includes('script') || !bodyLower.includes('control console')) throw new Error('App shell did not render expected content')
    if (/Vite Error|Internal Server Error|Failed to compile/i.test(body)) throw new Error('Framework error overlay detected')

    console.log('Checking theme and diagnostics...')
    const beforeTheme = await desktop.page.evaluate(() => document.documentElement.dataset.theme)
    await desktop.page.getByRole('button', { name: /Switch to/ }).click()
    const afterTheme = await desktop.page.evaluate(() => document.documentElement.dataset.theme)
    if (!afterTheme || afterTheme === beforeTheme) throw new Error(`Theme toggle did not change theme; got ${afterTheme}`)

    await desktop.page.getByLabel('Diagnostics export').scrollIntoViewIfNeeded()
    await desktop.page.getByRole('button', { name: 'Copy JSON' }).click()
    await desktop.page.getByText('Diagnostics copied to clipboard.').waitFor({ timeout: 20000 })

    console.log('Checking experimental Piper-plus controls...')
    await desktop.page.getByRole('checkbox', { name: 'Enable experimental Piper-plus' }).check()
    await desktop.page.getByRole('button', { name: /Piper-plus/ }).click()
    await desktop.page.getByLabel('Piper language').selectOption('en')
    await desktop.page.getByText(/Experimental Piper-plus jobs can generate clips/).waitFor({ timeout: 20000 })

    await desktop.page.getByRole('button', { name: 'Advanced options' }).click()
    for (const label of ['Skip citations', 'Drop page headers', 'Skip footnotes', 'Normalize numbers', 'Drop book metadata']) {
      await desktop.page.getByLabel(label).waitFor({ timeout: 20000 })
    }

    console.log('Checking DOCX and unsupported file import...')
    const fileInput = desktop.page.locator('input[type="file"]').first()
    await fileInput.setInputFiles(makeDocxUpload())
    await desktop.page.getByText(/smoke\.docx imported from DOCX/).waitFor({ timeout: 20000 })
    const importedText = await desktop.page.getByLabel('Text to synthesize').inputValue()
    if (!importedText.includes('Imported DOCX body.') || !importedText.includes('Second cleaned paragraph.')) {
      throw new Error(`DOCX import did not populate the editor: ${importedText}`)
    }
    await fileInput.setInputFiles({ name: 'smoke.rtf', mimeType: 'application/rtf', buffer: Buffer.from('unsupported') })
    await desktop.page.getByText('Import supports .txt, .epub, .pdf, and .docx files.').waitFor({ timeout: 20000 })

    console.log('Checking queue playback controls...')
    const queue = desktop.page.getByLabel('Generation queue')
    await queue.scrollIntoViewIfNeeded()
    await desktop.page.getByRole('button', { name: /ZIP/ }).waitFor({ timeout: 20000 })
    const queueChunks = desktop.page.getByLabel('Smoke queue completed chunks')
    await queueChunks.getByRole('button', { name: 'Play' }).first().click()
    await queueChunks.getByRole('button', { name: /Previous sentence/ }).waitFor({ timeout: 20000 })
    await queueChunks.getByRole('button', { name: /Next sentence/ }).waitFor({ timeout: 20000 })
    await queueChunks.getByText(/Resumed at/).waitFor({ timeout: 20000 })
    await queueChunks.getByRole('button', { name: 'Edit' }).first().click()
    const chunkEditor = queueChunks.locator('.queue-chunk-editor').first()
    await chunkEditor.getByLabel('Chapter title').fill('Smoke revised chapter')
    await chunkEditor.getByRole('button', { name: 'Save title' }).click()
    await desktop.page.getByText('Chapter metadata updated.').waitFor({ timeout: 20000 })
    await queueChunks.getByText('Smoke revised chapter').waitFor({ timeout: 20000 })
    await queueChunks.getByRole('button', { name: 'Edit' }).first().click()
    await chunkEditor.getByLabel('Segment text').fill('Smoke replacement segment.')
    await chunkEditor.getByRole('button', { name: 'Regenerate' }).waitFor({ timeout: 20000 })
    await chunkEditor.getByRole('button', { name: 'Cancel' }).click()

    console.log('Checking library playback controls...')
    const libraryPanel = desktop.page.getByLabel('Clip library')
    await libraryPanel.scrollIntoViewIfNeeded()
    await libraryPanel.getByRole('button', { name: 'Play' }).click()
    await libraryPanel.getByRole('button', { name: /Previous sentence/ }).waitFor({ timeout: 20000 })
    await libraryPanel.getByRole('button', { name: /Next sentence/ }).waitFor({ timeout: 20000 })
    await libraryPanel.getByText(/Resumed at/).waitFor({ timeout: 20000 })
    await desktop.page.screenshot({ path: join(smokeDir, 'desktop.png'), fullPage: false })
    await desktopContext.close()

    console.log('Checking mobile fallback state...')
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
  const distRoot = normalize(distDir)
  if (candidate !== distRoot && !candidate.startsWith(distRoot + sep)) throw new ResponseError(403)

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
