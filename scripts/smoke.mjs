import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { chromium } from 'playwright'
import { unzipSync, zipSync } from 'fflate'

const root = process.cwd()
const port = Number(process.env.BETTERTTS_SMOKE_PORT ?? 4873)
const baseUrl = `http://127.0.0.1:${port}/BetterTTS/`
const distDir = join(root, 'dist')
const smokeDir = join(root, 'dist', 'smoke')
const performanceBudget = JSON.parse(await readFile(join(root, 'scripts', 'performance-budget.json'), 'utf8'))
const runRealEngine = process.env.BETTERTTS_SMOKE_REAL_ENGINE === '1'
const allowedConsole = [
  'No available adapters',
  'Setting up fake worker',
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

async function assertManifestScreenshots() {
  const manifest = JSON.parse(await readFile(join(distDir, 'manifest.webmanifest'), 'utf8'))
  if (!Array.isArray(manifest.screenshots) || manifest.screenshots.length < 2) {
    throw new Error('PWA manifest must declare desktop and mobile screenshots.')
  }
  for (const screenshot of manifest.screenshots) {
    if (typeof screenshot.src !== 'string' || !screenshot.src.startsWith('screenshots/')) {
      throw new Error(`PWA screenshot path is invalid: ${String(screenshot.src)}`)
    }
    if (screenshot.type !== 'image/png' || typeof screenshot.sizes !== 'string' || !/^\d+x\d+$/u.test(screenshot.sizes)) {
      throw new Error(`PWA screenshot metadata is invalid: ${JSON.stringify(screenshot)}`)
    }
    const info = await stat(join(distDir, screenshot.src))
    if (!info.isFile() || info.size < 10_000) throw new Error(`PWA screenshot is missing or empty: ${screenshot.src}`)
  }
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

function makePdfUpload() {
  const parts = ['%PDF-1.4\n']
  const offsets = [0]
  const addObject = (id, body) => {
    offsets[id] = parts.join('').length
    parts.push(`${id} 0 obj\n${body}\nendobj\n`)
  }
  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>')
  addObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  addObject(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>')
  addObject(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const stream = [
    'BT /F1 18 Tf',
    '1 0 0 1 60 700 Tm (Worker PDF hy-) Tj',
    '1 0 0 1 60 680 Tm (phenated text continues in the left column.) Tj',
    '1 0 0 1 320 700 Tm (Right column starts.) Tj',
    '1 0 0 1 320 680 Tm (Right column continues.) Tj',
    'ET',
  ].join('\n')
  addObject(5, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  const xref = parts.join('').length
  parts.push('xref\n0 6\n0000000000 65535 f \n')
  for (let id = 1; id <= 5; id += 1) parts.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)
  parts.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return { name: 'smoke.pdf', mimeType: 'application/pdf', buffer: Buffer.from(parts.join('')) }
}

function makeSubtitleUpload() {
  return {
    name: 'smoke-revoice.srt',
    mimeType: 'application/x-subrip',
    buffer: Buffer.from('1\n00:00:01,000 --> 00:00:02,500\nFirst timed cue.\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond timed cue.\n'),
  }
}

function makeBgmUpload() {
  const sampleRate = 8000
  const samples = sampleRate / 4
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * 220) * 6000), 44 + index * 2)
  }
  return { name: 'smoke-bgm.wav', mimeType: 'audio/wav', buffer }
}

function makePronunciationPackUpload() {
  return {
    name: 'smoke-pronunciations.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      schemaVersion: 1,
      name: 'Smoke pronunciation pack',
      entries: [{ word: 'README', replacement: 'read me', mode: 'respelling' }],
    })),
  }
}

function makeEpubUpload() {
  const zipped = zipSync({
    'META-INF/container.xml': new TextEncoder().encode('<?xml version="1.0"?><container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>'),
    'content.opf': new TextEncoder().encode('<?xml version="1.0"?><package><manifest><item id="one" href="one.xhtml"/><item id="two" href="two.xhtml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>'),
    'one.xhtml': new TextEncoder().encode('<html><body><h1>One</h1><p>First worker chapter.</p></body></html>'),
    'two.xhtml': new TextEncoder().encode('<html><body><h1>Two</h1><p>Second worker chapter.</p></body></html>'),
  })
  return { name: 'worker-book.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(zipped) }
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
      sourceKind: 'epub',
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
    const libraryCreatedAt = Date.now()
    const libraryClips = [
      {
        id: 'smoke-library',
        filename: 'smoke-library.wav',
        label: 'Smoke library clip',
        voice: 'af_heart',
        engine: 'kokoro',
        speed: 1,
        createdAt: libraryCreatedAt,
        size: 48044,
        duration: '3.0s',
        cues: cueSet,
      },
      {
        id: 'smoke-library-older',
        filename: 'older-chapter.wav',
        label: 'Older chapter',
        voice: 'M1',
        engine: 'supertonic',
        speed: 1,
        createdAt: libraryCreatedAt - 2000,
        size: 32000,
        duration: '1m 15s',
      },
      {
        id: 'smoke-library-uncued',
        filename: 'uncued-note.wav',
        label: 'Uncued note',
        voice: 'af_bella',
        engine: 'piper',
        speed: 1,
        createdAt: libraryCreatedAt - 1000,
        size: 64000,
        duration: '5.0s',
      },
    ]
    for (const clip of libraryClips) {
      libraryTx.objectStore('clips').put(clip)
      libraryTx.objectStore('blobs').put(makeWavBlob(), clip.id)
    }
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
  const navigationStartedAt = performance.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('button:visible').filter({ hasText: /^Generate audio$/ }).first().waitFor({ timeout: 20000 })
  const timeToInteractiveMs = performance.now() - navigationStartedAt
  const initialAssets = await page.evaluate(() => (
    performance.getEntriesByType('resource').map((entry) => new URL(entry.name).pathname)
  ))
  return { page, messages, timeToInteractiveMs, initialAssets }
}

async function assertThemeContrast(page, themeName) {
  const results = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    const resolveColor = (value) => {
      const probe = document.createElement('span')
      probe.style.color = value
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
      if (!channels || channels.length !== 3) throw new Error(`Could not resolve color: ${value}`)
      return channels
    }
    const luminance = (channels) => {
      const linear = channels.map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    }
    const ratio = (foreground, background) => {
      const a = luminance(resolveColor(root.getPropertyValue(foreground)))
      const b = luminance(resolveColor(root.getPropertyValue(background)))
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    return [
      ['body text', ratio('--text', '--surface-0')],
      ['muted text', ratio('--muted', '--surface-0')],
      ['headings', ratio('--heading', '--surface-0')],
      ['accent text', ratio('--accent-text', '--surface-1')],
      ['primary actions', ratio('--accent-action-contrast', '--accent-action')],
    ]
  })
  const failures = results.filter(([, ratio]) => ratio < 4.5)
  if (failures.length > 0) {
    throw new Error(`${themeName} contrast failures: ${failures.map(([name, ratio]) => `${name} ${ratio.toFixed(2)}:1`).join(', ')}`)
  }
}

async function assertAccessibilityStructure(page) {
  const structure = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      text: heading.textContent?.trim() ?? '',
    }))
    const tabProblems = Array.from(document.querySelectorAll('[role="tab"]')).flatMap((tab) => {
      const targetId = tab.getAttribute('aria-controls')
      const target = targetId ? document.getElementById(targetId) : null
      if (!tab.id) return [`Tab "${tab.textContent?.trim()}" has no id`]
      if (!target || target.getAttribute('role') !== 'tabpanel') return [`Tab "${tab.id}" has no tabpanel`]
      const labelledBy = target.getAttribute('aria-labelledby')?.split(/\s+/) ?? []
      return labelledBy.includes(tab.id) ? [] : [`Panel "${targetId}" is not labelled by "${tab.id}"`]
    })
    return {
      headings,
      mainCount: document.querySelectorAll('main').length,
      navigationCount: document.querySelectorAll('nav[aria-label="Workspace"]').length,
      tabProblems,
    }
  })
  if (structure.mainCount !== 1 || structure.navigationCount !== 1) {
    throw new Error(`Expected one main and one workspace navigation landmark; got ${structure.mainCount}/${structure.navigationCount}`)
  }
  if (structure.headings.filter(({ level }) => level === 1).length !== 1) {
    throw new Error(`Expected one h1; got ${JSON.stringify(structure.headings)}`)
  }
  for (let index = 1; index < structure.headings.length; index += 1) {
    if (structure.headings[index].level > structure.headings[index - 1].level + 1) {
      throw new Error(`Heading level skipped: ${JSON.stringify(structure.headings)}`)
    }
  }
  for (const expected of ['Script', 'Render monitor', 'Generated audio', 'Generation queue', 'Clip library', 'Voice chain', 'Model library', 'Runtime licenses', 'Privacy & portability']) {
    if (!structure.headings.some(({ text }) => text.startsWith(expected))) {
      throw new Error(`Missing semantic heading: ${expected}`)
    }
  }
  if (structure.tabProblems.length > 0) throw new Error(structure.tabProblems.join('; '))

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.keyboard.press('Tab')
  if (!(await page.locator('.skip-link').evaluate((element) => element === document.activeElement))) {
    throw new Error('Keyboard traversal did not start at the skip link')
  }
  await page.keyboard.press('Enter')
  if (!(await page.getByLabel('Text to synthesize').evaluate((element) => element === document.activeElement))) {
    throw new Error('Skip link did not focus the script editor')
  }
  const themeButton = page.getByRole('button', { name: /Switch to/ })
  await themeButton.focus()
  const focusStyle = await themeButton.evaluate((element) => {
    const style = getComputedStyle(element)
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) }
  })
  if (focusStyle.style === 'none' || focusStyle.width < 2) throw new Error(`Focus indicator is not visible: ${JSON.stringify(focusStyle)}`)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reducedMotion = await themeButton.evaluate((element) => ({
    matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
    transitionMs: getComputedStyle(element).transitionDuration.split(',').map((value) => Number.parseFloat(value) * (value.includes('ms') ? 1 : 1000)),
  }))
  if (!reducedMotion.matches || reducedMotion.transitionMs.some((duration) => duration > 1)) {
    throw new Error(`Reduced-motion styles are not effective: ${JSON.stringify(reducedMotion)}`)
  }

  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'active' })
  const forcedColors = await themeButton.evaluate((element) => ({
    matches: matchMedia('(forced-colors: active)').matches,
    outline: getComputedStyle(element).outlineStyle,
  }))
  if (!forcedColors.matches || forcedColors.outline === 'none') {
    throw new Error(`Forced-colors focus indicator is not effective: ${JSON.stringify(forcedColors)}`)
  }
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' })
}

async function seedPartiallyCompleteRealQueue(page) {
  await page.evaluate(async () => {
    const sampleRate = 8000
    const samples = sampleRate
    const buffer = new ArrayBuffer(44 + samples * 2)
    const view = new DataView(buffer)
    const write = (offset, value) => {
      for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
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

    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('bettertts-queue', 2)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('jobs')) request.result.createObjectStore('jobs', { keyPath: 'id' })
        if (!request.result.objectStoreNames.contains('chunks')) request.result.createObjectStore('chunks')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction(['jobs', 'chunks'], 'readwrite')
    tx.objectStore('jobs').put({
      schemaVersion: 2,
      id: 'release-real-queue',
      title: 'Pinned real-engine queue',
      createdAt: Date.now(),
      engine: 'kokoro',
      voice: 'af_heart',
      language: 'en-us',
      speed: 1,
      format: 'wav',
      bitrate: 96,
      chunks: [
        { index: 0, text: 'Already completed fixture.', status: 'done', duration: '1.0s', cues: [{ index: 1, startSec: 0, endSec: 1, text: 'Already completed fixture.' }] },
        { index: 1, text: 'The resumed queue generated this verified sentence.', status: 'pending' },
      ],
    })
    tx.objectStore('chunks').put(new Blob([buffer], { type: 'audio/wav' }), 'release-real-queue:0')
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  })
}

async function objectUrlBuffer(locator, attribute) {
  const dataUrl = await locator.evaluate((element, attributeName) => {
    const url = element.getAttribute(attributeName)
    const blob = url ? window.__betterttsSmokeBlobs?.get(url) : null
    if (!(blob instanceof Blob)) throw new Error(`Smoke blob not found for ${attributeName}=${url}`)
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  }, attribute)
  if (typeof dataUrl !== 'string') throw new Error('Smoke blob did not produce a data URL')
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
}

async function inspectGeneratedAudio(page, resultRow) {
  const bytes = await objectUrlBuffer(resultRow.locator('audio'), 'src')
  const header = bytes.subarray(0, 12).toString('ascii')
  const decoded = await page.evaluate(async (base64) => {
    const wav = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const context = new AudioContext()
    try {
      const audio = await context.decodeAudioData(wav.buffer)
      return { duration: audio.duration, sampleRate: audio.sampleRate }
    } finally {
      await context.close()
    }
  }, bytes.toString('base64'))
  return { bytes: bytes.byteLength, header, ...decoded }
}

async function runRealEngineChecks(browser) {
  console.log('Checking pinned real browser engine, cancellation, and queue resume...')
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => {
    const blobs = new Map()
    const createObjectURL = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (blob) => {
      const url = createObjectURL(blob)
      blobs.set(url, blob)
      return url
    }
    window.__betterttsSmokeBlobs = blobs
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await page.locator('.generate-button').waitFor({ timeout: 20000 })
    await page.getByLabel('Text to synthesize').fill('Pinned release synthesis works. Its caption cues are verified.')
    const generationStartedAt = performance.now()
    await page.locator('.generate-button').click()
    const resultRow = page.locator('#generated-output .result-row').first()
    await resultRow.locator('audio').waitFor({ timeout: 300000 })
    const timeToFirstAudioMs = performance.now() - generationStartedAt
    const audio = await inspectGeneratedAudio(page, resultRow)
    if (!audio.header.startsWith('RIFF') || !audio.header.endsWith('WAVE') || audio.bytes <= 44 || audio.duration <= 0) {
      throw new Error(`Real engine produced invalid WAV output: ${JSON.stringify(audio)}`)
    }
    const srt = (await objectUrlBuffer(resultRow.getByRole('link', { name: 'SRT' }), 'href')).toString('utf8')
    const vtt = (await objectUrlBuffer(resultRow.getByRole('link', { name: 'VTT' }), 'href')).toString('utf8')
    if (!srt.includes('-->') || !vtt.startsWith('WEBVTT') || !vtt.includes('-->')) throw new Error('Real engine caption cues are missing')

    const expandedLanguages = {}
    for (const [locale, sampleText] of [
      ['ja', 'こんにちは。これは日本語の音声テストです。'],
      ['cmn', '你好，这是普通话语音测试。'],
    ]) {
      await page.locator('#locale').selectOption(locale)
      await page.getByLabel('Text to synthesize').fill(sampleText)
      await page.locator('.generate-button').click()
      const languageRow = page.locator('#generated-output .result-row').first()
      await languageRow.locator('audio').waitFor({ timeout: 300000 })
      const languageAudio = await inspectGeneratedAudio(page, languageRow)
      if (!languageAudio.header.startsWith('RIFF') || !languageAudio.header.endsWith('WAVE') || languageAudio.bytes <= 44 || languageAudio.duration <= 0) {
        throw new Error(`Expanded Kokoro ${locale} output is invalid: ${JSON.stringify(languageAudio)}`)
      }
      expandedLanguages[locale] = languageAudio
    }

    if (timeToFirstAudioMs > performanceBudget.realEngine.maxTimeToFirstAudioMs) {
      throw new Error(`Browser time to first audio ${timeToFirstAudioMs.toFixed(0)} ms exceeds ${performanceBudget.realEngine.maxTimeToFirstAudioMs} ms`)
    }
    const monitorPlay = page.getByRole('button', { name: 'Play current output' })
    await monitorPlay.click()
    const monitorPause = page.getByRole('button', { name: 'Pause current output' })
    await monitorPause.waitFor({ timeout: 20000 })
    await page.getByLabel('Current output position').waitFor({ state: 'visible' })
    await monitorPause.click()

    const originalResultCount = await page.locator('#generated-output .result-row').count()
    await page.getByLabel('Text to synthesize').fill(`${'Cancellation must discard unfinished audio. '.repeat(90)}Final sentence.`)
    await page.locator('.generate-button').click()
    const cancelButton = page.locator('.generate-button.cancel')
    await cancelButton.waitFor({ timeout: 20000 })
    await page.waitForTimeout(50)
    await cancelButton.click()
    await page.getByText('Generation cancelled.').waitFor({ timeout: 60000 })
    await page.locator('.generate-button').filter({ hasText: /^Generate audio$/ }).waitFor({ timeout: 60000 })
    if (await page.locator('#generated-output .result-row').count() !== originalResultCount) {
      throw new Error('Cancelled browser generation committed a new output')
    }

    await seedPartiallyCompleteRealQueue(page)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: /Queue/ }).click()
    const queue = page.getByLabel('Generation queue')
    await queue.getByRole('button', { name: 'Resume' }).click()
    await page.getByText('Job "Pinned real-engine queue" complete.').waitFor({ timeout: 300000 })
    const resumed = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('bettertts-queue', 2)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const tx = db.transaction(['jobs', 'chunks'], 'readonly')
      const job = await new Promise((resolve, reject) => {
        const request = tx.objectStore('jobs').get('release-real-queue')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const blob = await new Promise((resolve, reject) => {
        const request = tx.objectStore('chunks').get('release-real-queue:1')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      db.close()
      const bytes = blob instanceof Blob ? await blob.arrayBuffer() : new ArrayBuffer(0)
      const header = new TextDecoder('ascii').decode(bytes.slice(0, 12))
      return {
        statuses: job?.chunks?.map((chunk) => chunk.status) ?? [],
        cueCount: job?.chunks?.[1]?.cues?.length ?? 0,
        bytes: bytes.byteLength,
        header,
      }
    })
    if (resumed.statuses.some((status) => status !== 'done') || resumed.cueCount < 1 || resumed.bytes <= 44 || !resumed.header.startsWith('RIFF')) {
      throw new Error(`Partially completed queue did not resume transactionally: ${JSON.stringify(resumed)}`)
    }
    if (pageErrors.length > 0) throw new Error(`Real-engine page errors:\n${pageErrors.join('\n')}`)

    const report = {
      ok: true,
      model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
      license: 'Apache-2.0',
      timeToFirstAudioMs: Math.round(timeToFirstAudioMs),
      realTimeFactor: Number(((timeToFirstAudioMs / 1000) / audio.duration).toFixed(2)),
      audio,
      expandedLanguages,
      captions: { srtBytes: srt.length, vttBytes: vtt.length },
      cancellation: 'passed',
      queueResume: resumed,
    }
    await writeFile(join(smokeDir, 'real-engine.json'), `${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally {
    await context.close()
  }
}

async function assertExtensionHandoff(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  try {
    const page = await context.newPage()
    const payload = 'Read this selection literally, including https://example.com/article.'
    await page.goto(`${baseUrl}?source=extension&text=${encodeURIComponent(payload)}`, { waitUntil: 'domcontentloaded' })
    const editor = page.getByLabel('Text to synthesize')
    await editor.waitFor({ timeout: 20000 })
    await page.waitForFunction((expected) => document.querySelector('#script-editor')?.value === expected, payload, { timeout: 20000 })
    const value = await editor.inputValue()
    if (value !== payload) throw new Error('Extension handoff changed page text into an article import.')
  } finally {
    await context.close()
  }
}

async function runSmoke() {
  console.log('Building production app...')
  runChecked('npm', ['run', 'build'])
  await assertManifestScreenshots()
  if (existsSync(smokeDir)) rmSync(smokeDir, { recursive: true, force: true })
  mkdirSync(smokeDir, { recursive: true })
  console.log(`Starting smoke server at ${baseUrl}`)
  const server = await startStaticServer()
  let browser
  try {
    console.log('Running Chromium smoke checks...')

    browser = await chromium.launch({ headless: true })
    const desktopContext = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1440, height: 950 },
    })
    await desktopContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })
    const desktop = await openSeededApp(desktopContext, 'smoke-default')
    if (desktop.timeToInteractiveMs > performanceBudget.shell.maxTimeToInteractiveMs) {
      throw new Error(`Time to interactive ${desktop.timeToInteractiveMs.toFixed(0)} ms exceeds ${performanceBudget.shell.maxTimeToInteractiveMs} ms`)
    }
    const unexpectedInitialAssets = desktop.initialAssets.filter((asset) => (
      performanceBudget.shell.forbiddenInitialAssetPatterns.some((pattern) => asset.toLowerCase().includes(pattern.toLowerCase()))
    ))
    if (unexpectedInitialAssets.length > 0) {
      throw new Error(`Initial shell loaded lazy assets:\n${unexpectedInitialAssets.join('\n')}`)
    }
    const title = await desktop.page.title()
    if (!title.includes('BetterTTS')) throw new Error(`Unexpected page title: ${title}`)
    const body = await desktop.page.locator('body').innerText()
    await desktop.page.getByRole('main').waitFor({ timeout: 20000 })
    await desktop.page.getByRole('navigation', { name: 'Workspace' }).waitFor({ timeout: 20000 })
    await desktop.page.getByRole('heading', { level: 1, name: 'BetterTTS local speech studio' }).waitFor({ timeout: 20000 })
    await desktop.page.getByLabel('Text to synthesize').waitFor({ timeout: 20000 })
    await desktop.page.getByRole('button', { name: 'Generate audio' }).first().waitFor({ timeout: 20000 })
    if (/Vite Error|Internal Server Error|Failed to compile/i.test(body)) throw new Error('Framework error overlay detected')

    console.log('Checking browser-extension text handoff...')
    await assertExtensionHandoff(browser)

    console.log('Checking semantic structure, keyboard access, and display preferences...')
    await assertAccessibilityStructure(desktop.page)
    await assertThemeContrast(desktop.page, await desktop.page.evaluate(() => document.documentElement.dataset.theme ?? 'initial'))

    console.log('Checking theme and diagnostics...')
    const beforeTheme = await desktop.page.evaluate(() => document.documentElement.dataset.theme)
    await desktop.page.getByRole('button', { name: /Switch to/ }).click()
    const afterTheme = await desktop.page.evaluate(() => document.documentElement.dataset.theme)
    if (!afterTheme || afterTheme === beforeTheme) throw new Error(`Theme toggle did not change theme; got ${afterTheme}`)
    if (afterTheme !== 'light') await desktop.page.getByRole('button', { name: /Switch to light theme/ }).click()
    await assertThemeContrast(desktop.page, 'light')
    await desktop.page.waitForTimeout(250)
    await desktop.page.screenshot({ path: join(smokeDir, 'desktop-light.png'), fullPage: false })

    await desktop.page.getByRole('button', { name: 'System & diagnostics' }).click()
    await desktop.page.getByRole('button', { name: 'Advanced options' }).click()
    const fp16Toggle = desktop.page.locator('label.toggle-row').filter({ hasText: 'WebGPU fp16 (experimental)' }).locator('input[type="checkbox"]')
    await fp16Toggle.waitFor({ timeout: 20000 })
    if (await fp16Toggle.isChecked()) throw new Error('Kokoro WebGPU fp16 should default to opt-out')
    await fp16Toggle.check()
    await desktop.page.reload({ waitUntil: 'domcontentloaded' })
    await desktop.page.getByRole('button', { name: 'System & diagnostics' }).click()
    await desktop.page.getByRole('button', { name: 'Advanced options' }).click()
    const persistedFp16Toggle = desktop.page.locator('label.toggle-row').filter({ hasText: 'WebGPU fp16 (experimental)' }).locator('input[type="checkbox"]')
    await persistedFp16Toggle.waitFor({ timeout: 20000 })
    if (!(await persistedFp16Toggle.isChecked())) throw new Error('Kokoro WebGPU fp16 preference did not persist')
    await persistedFp16Toggle.uncheck()
    console.log('Checking consent-gated voice lab...')
    const voiceLabConsent = desktop.page.locator('#chatterbox-consent')
    await voiceLabConsent.waitFor({ timeout: 20000 })
    if (await voiceLabConsent.isChecked()) throw new Error('Chatterbox voice lab should default to opt-out')
    const voiceLabCopy = await desktop.page.locator('label[for="chatterbox-consent"]').innerText()
    if (!voiceLabCopy.includes('own or have permission')) throw new Error('Voice-lab ownership acknowledgement copy is missing')
    if (await desktop.page.locator('button.engine-card').filter({ hasText: 'Chatterbox' }).count() !== 0) throw new Error('Chatterbox engine should stay hidden before consent')
    await voiceLabConsent.check()
    const chatterboxCard = desktop.page.locator('button.engine-card').filter({ hasText: 'Chatterbox' }).first()
    await chatterboxCard.waitFor({ timeout: 20000 })
    await chatterboxCard.click()
    await desktop.page.getByRole('button', { name: 'Choose audio', exact: true }).waitFor({ timeout: 20000 })
    await desktop.page.locator('button.engine-card').filter({ hasText: 'Kokoro 82M' }).first().click()
    await voiceLabConsent.uncheck()
    await desktop.page.getByLabel('Diagnostics export').scrollIntoViewIfNeeded()
    await desktop.page.getByLabel('WebGPU adapter diagnostics').waitFor({ timeout: 20000 })
    await desktop.page.getByRole('button', { name: 'Report bad audio' }).waitFor({ timeout: 20000 })
    await desktop.page.waitForTimeout(200)
    await desktop.page.screenshot({ path: join(smokeDir, 'diagnostics-light.png'), fullPage: false })
    await desktop.page.getByRole('button', { name: 'Copy JSON' }).click()
    await desktop.page.getByText('Diagnostics copied to clipboard.').waitFor({ timeout: 20000 })
    await desktop.page.evaluate(() => window.dispatchEvent(new Event('bettertts-update-ready')))
    await desktop.page.getByRole('button', { name: 'Refresh now' }).waitFor({ timeout: 20000 })
    await desktop.page.getByRole('button', { name: /Switch to dark theme/ }).click()

    console.log('Checking BGM ducking and loudness controls...')
    const advancedOptionsToggle = desktop.page.getByRole('button', { name: 'Advanced options' })
    if (await advancedOptionsToggle.getAttribute('aria-expanded') !== 'true') await advancedOptionsToggle.click()
    const trainerToggle = desktop.page.getByRole('checkbox', { name: 'Listening speed trainer' })
    await trainerToggle.waitFor({ timeout: 20000 })
    if (await trainerToggle.isChecked()) throw new Error('Listening speed trainer should default to off')
    await trainerToggle.check()
    const trainerInterval = desktop.page.getByLabel('Trainer ramp interval')
    await trainerInterval.selectOption('10')
    const trainerCap = desktop.page.getByLabel('Speed cap')
    await trainerCap.fill('1.25')
    const trainerStatus = desktop.page.locator('.trainer-status[role="status"]')
    if (!(await trainerStatus.innerText()).includes('1.00x now')) throw new Error('Listening trainer indicator did not show the active rate')
    await desktop.page.getByRole('button', { name: 'Reset trainer progress' }).click()
    await trainerToggle.uncheck()
    const optionalPlaybackSurfaces = await desktop.page.evaluate(() => ({
      documentPictureInPicture: Boolean(window.documentPictureInPicture),
      audioOutput: Boolean(navigator.mediaDevices?.selectAudioOutput && typeof document.createElement('audio').setSinkId === 'function'),
    }))
    const miniPlayerTrigger = desktop.page.getByTestId('mini-player-trigger')
    const audioOutputPicker = desktop.page.getByTestId('audio-output-picker')
    if (optionalPlaybackSurfaces.documentPictureInPicture) {
      await miniPlayerTrigger.waitFor({ timeout: 20000 })
    } else if (await miniPlayerTrigger.count() !== 0) {
      throw new Error('Document Picture-in-Picture control rendered without browser support')
    }
    if (optionalPlaybackSurfaces.audioOutput) {
      await audioOutputPicker.waitFor({ timeout: 20000 })
    } else if (await audioOutputPicker.count() !== 0) {
      throw new Error('Audio output picker rendered without browser support')
    }
    const commaPause = desktop.page.getByLabel('Comma pause duration in seconds')
    await commaPause.waitFor({ timeout: 20000 })
    await commaPause.fill('0.25')
    if (await commaPause.inputValue() !== '0.25') throw new Error('Punctuation pause did not update')
    const editor = desktop.page.getByLabel('Text to synthesize')
    await editor.evaluate((node) => {
      node.focus()
      node.setSelectionRange(0, Math.min(18, node.value.length))
    })
    await desktop.page.getByRole('button', { name: 'Apply to selection' }).click()
    if (!(await editor.inputValue()).includes('[prosody rate=')) throw new Error('Prosody emphasis was not applied to the selected text')
    await desktop.page.getByRole('button', { name: 'Reset punctuation pauses' }).click()
    if (await commaPause.inputValue() !== '0') throw new Error('Punctuation pause reset did not restore the default')
    const loudnessPreset = desktop.page.getByLabel('Loudness target')
    await loudnessPreset.waitFor({ timeout: 20000 })
    await loudnessPreset.selectOption('audiobook-mono')
    if (await loudnessPreset.inputValue() !== 'audiobook-mono') throw new Error('Audiobook loudness preset did not select')
    await loudnessPreset.selectOption('podcast-stereo')
    if (await loudnessPreset.inputValue() !== 'podcast-stereo') throw new Error('Podcast loudness preset did not select')
    const bgmInput = desktop.page.locator('.bgm-row input[type="file"]')
    await bgmInput.setInputFiles(makeBgmUpload())
    const duckToggle = desktop.page.getByRole('checkbox', { name: 'Auto-duck under speech' })
    await duckToggle.waitFor({ timeout: 20000 })
    await duckToggle.check()
    if (!(await duckToggle.isChecked())) throw new Error('BGM auto-duck toggle did not enable')
    const duckDepth = desktop.page.getByLabel('Duck depth')
    await duckDepth.waitFor({ timeout: 20000 })
    await duckDepth.fill('0.8')
    if (await duckDepth.inputValue() !== '0.8') throw new Error('BGM duck depth did not update')

    console.log('Checking pronunciation dictionary packs...')
    const pronunciationsToggle = desktop.page.getByRole('button', { name: /Pronunciations \(/ })
    await pronunciationsToggle.click()
    await desktop.page.getByRole('button', { name: 'Add tech starter' }).click()
    await desktop.page.getByText('API', { exact: true }).waitFor({ timeout: 20000 })
    const pronunciationMode = desktop.page.getByLabel('Pronunciation mode')
    await pronunciationMode.selectOption('phoneme')
    await desktop.page.getByLabel('Pronunciation word').fill('SQL')
    await desktop.page.getByLabel('Pronunciation replacement').fill('sˌiːkwəl')
    await desktop.page.getByRole('button', { name: 'Add', exact: true }).click()
    await desktop.page.locator('small').filter({ hasText: 'eSpeak phonemes' }).waitFor({ timeout: 20000 })
    const pronunciationPackInput = desktop.page.locator('input[type="file"][accept="application/json,.json"]')
    await pronunciationPackInput.setInputFiles(makePronunciationPackUpload())
    await desktop.page.getByText(/Imported 1 pronunciation entry from Smoke pronunciation pack\./).waitFor({ timeout: 20000 })
    await desktop.page.getByText('README', { exact: true }).waitFor({ timeout: 20000 })
    const downloadPromise = desktop.page.waitForEvent('download')
    await desktop.page.getByRole('button', { name: 'Export pack' }).click()
    const pronunciationDownload = await downloadPromise
    if (pronunciationDownload.suggestedFilename() !== 'bettertts-pronunciations.json') {
      throw new Error(`Unexpected pronunciation pack filename: ${pronunciationDownload.suggestedFilename()}`)
    }

    console.log('Checking experimental Piper-plus controls...')
    await desktop.page.getByRole('checkbox', { name: 'Enable experimental Piper-plus' }).check()
    await desktop.page.getByRole('button', { name: /Piper-plus/ }).click()
    const piperLanguage = desktop.page.getByLabel('Piper language')
    await piperLanguage.selectOption('en')
    if (await piperLanguage.inputValue() !== 'en') throw new Error('Piper engine controls did not become active')

    if (await advancedOptionsToggle.getAttribute('aria-expanded') !== 'true') await advancedOptionsToggle.click()
    for (const label of ['Skip citations', 'Drop page headers', 'Re-flow PDF lines', 'Skip footnotes', 'Normalize numbers', 'Drop book metadata']) {
      await desktop.page.getByLabel(label).waitFor({ timeout: 20000 })
    }

    console.log('Checking SRT/VTT subtitle re-voice import...')
    const subtitleInput = desktop.page.locator('.caption-import-card input[type="file"]')
    await subtitleInput.setInputFiles(makeSubtitleUpload())
    await desktop.page.getByText(/2 timed cues ready for Piper-plus/).waitFor({ timeout: 20000 })
    await desktop.page.getByRole('button', { name: 'Re-voice subtitles' }).waitFor({ timeout: 20000 })
    const assStyle = desktop.page.getByLabel('ASS caption style')
    await assStyle.selectOption('outline')
    if (await assStyle.inputValue() !== 'outline' || await assStyle.locator('option').count() !== 3) {
      throw new Error('ASS caption style presets did not load')
    }
    await assStyle.selectOption('karaoke-fill')
    if (!(await desktop.page.locator('.caption-import-note').innerText()).includes('original timestamp')) {
      throw new Error('Subtitle re-voice guidance did not render')
    }
    await desktop.page.locator('.caption-import-card').scrollIntoViewIfNeeded()
    await desktop.page.waitForTimeout(200)
    await desktop.page.screenshot({ path: join(smokeDir, 'subtitle-revoice-dark.png'), fullPage: false })

    console.log('Checking DOCX and unsupported file import...')
    const fileInput = desktop.page.locator('input[type="file"]').first()
    await fileInput.setInputFiles(makeDocxUpload())
    try {
      const importResult = await Promise.race([
        desktop.page.getByText(/smoke\.docx imported from DOCX/).waitFor({ timeout: 20000 }).then(() => 'ok'),
        desktop.page.locator('.toast.error').waitFor({ timeout: 20000 }).then(async () => desktop.page.locator('.toast.error').innerText()),
      ])
      if (importResult !== 'ok') throw new Error(importResult)
    } catch (error) {
      const visibleText = await desktop.page.locator('body').innerText()
      throw new Error(`DOCX worker import did not complete (${error instanceof Error ? error.message : error}): ${visibleText.slice(-1200)}`, { cause: error })
    }
    const importedText = await desktop.page.getByLabel('Text to synthesize').inputValue()
    if (!importedText.includes('Imported DOCX body.') || !importedText.includes('Second cleaned paragraph.')) {
      throw new Error(`DOCX import did not populate the editor: ${importedText}`)
    }
    await desktop.page.getByLabel('Text to synthesize').fill('Visit https://example.com/article [12]. SQL costs $12.50.')
    await desktop.page.getByRole('button', { name: 'Preview changes' }).click()
    const normalizationPreview = desktop.page.getByLabel('Text normalization preview')
    await normalizationPreview.waitFor({ timeout: 20000 })
    await normalizationPreview.getByLabel('Enable URLs normalization').uncheck()
    if (await normalizationPreview.getByText('URLs', { exact: true }).count() === 0) throw new Error('Normalization preview did not group URL changes')
    await normalizationPreview.getByRole('button', { name: 'Apply normalization' }).click()
    const normalizedImportedText = await desktop.page.getByLabel('Text to synthesize').inputValue()
    if (!normalizedImportedText.includes('https://example.com/article') || normalizedImportedText.includes('[12]') || !normalizedImportedText.includes('S Q L')) {
      throw new Error(`Normalization preview applied the wrong rule set: ${normalizedImportedText}`)
    }
    await desktop.page.getByRole('button', { name: 'Restore original import' }).click()
    if (!(await desktop.page.getByLabel('Text to synthesize').inputValue()).includes('Imported DOCX body.')) {
      throw new Error('Restore original import did not recover the raw document text')
    }
    await fileInput.setInputFiles(makePdfUpload())
    const pdfImportResult = await Promise.race([
      desktop.page.getByText(/smoke\.pdf imported from PDF/).waitFor({ timeout: 20000 }).then(() => 'ok'),
      desktop.page.locator('.toast.error').waitFor({ timeout: 20000 }).then(async () => desktop.page.locator('.toast.error').innerText()),
    ])
    if (pdfImportResult !== 'ok') throw new Error(`PDF worker import did not complete: ${pdfImportResult}`)
    const pdfPreview = desktop.page.getByLabel('Text normalization preview')
    await pdfPreview.waitFor({ timeout: 20000 })
    await pdfPreview.getByRole('button', { name: 'Apply normalization' }).click()
    await desktop.page.waitForTimeout(200)
    const pdfImportedText = await desktop.page.getByLabel('Text to synthesize').inputValue()
    const normalizedPdfText = pdfImportedText.replace(/\s/g, '')
    if (!normalizedPdfText.includes('WorkerPDFhyphenatedtextcontinuesintheleftcolumn.') || !normalizedPdfText.includes('Rightcolumnstarts.Rightcolumncontinues.')) {
      throw new Error(`PDF worker import did not populate the editor: ${pdfImportedText}`)
    }
    console.log('Checking recoverable script clearing and cancellable article import...')
    await desktop.page.getByRole('button', { name: 'New', exact: true }).click()
    if (await desktop.page.getByLabel('Text to synthesize').inputValue() !== '') {
      throw new Error('New did not clear the script')
    }
    await desktop.page.getByRole('button', { name: 'Undo' }).click()
    if (await desktop.page.getByLabel('Text to synthesize').inputValue() !== pdfImportedText) {
      throw new Error('Undo did not restore the cleared script')
    }
    await desktop.page.evaluate(() => {
      const originalFetch = window.fetch.bind(window)
      window.fetch = (input, init) => {
        if (String(input) !== 'https://smoke.invalid/article') return originalFetch(input, init)
        return new Promise((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted) {
            reject(signal.reason)
            return
          }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
    })
    await desktop.page.getByLabel('Article URL to import').fill('https://smoke.invalid/article')
    await desktop.page.getByRole('button', { name: 'Import', exact: true }).click()
    await desktop.page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await desktop.page.getByText('Article import cancelled. The current script was kept.').waitFor({ timeout: 20000 })
    if (await desktop.page.getByLabel('Text to synthesize').inputValue() !== pdfImportedText) {
      throw new Error('Cancelling article import replaced the current script')
    }
    await fileInput.setInputFiles({ name: 'smoke.rtf', mimeType: 'application/rtf', buffer: Buffer.from('unsupported') })
    await desktop.page.getByText('Import supports .txt, .epub, .pdf, and .docx files.').waitFor({ timeout: 20000 })

    console.log('Checking queue playback controls...')
    const outputTab = desktop.page.getByRole('tab', { name: /Output/ })
    await outputTab.focus()
    await outputTab.press('ArrowRight')
    if (await desktop.page.getByRole('tab', { name: /Queue/ }).getAttribute('aria-selected') !== 'true') {
      throw new Error('ArrowRight did not select the next render workspace tab')
    }
    await desktop.page.getByRole('tab', { name: /Queue/ }).press('ArrowLeft')
    if (await outputTab.getAttribute('aria-selected') !== 'true') {
      throw new Error('ArrowLeft did not restore the previous render workspace tab')
    }
    await desktop.page.getByRole('tab', { name: /Queue/ }).click()
    const queue = desktop.page.getByLabel('Generation queue')
    await queue.scrollIntoViewIfNeeded()
    await desktop.page.waitForTimeout(200)
    await desktop.page.screenshot({ path: join(smokeDir, 'queue-dark.png'), fullPage: false })
    await desktop.page.getByRole('button', { name: /ZIP/ }).waitFor({ timeout: 20000 })
    const overlayDownloadPromise = desktop.page.waitForEvent('download')
    await queue.getByRole('button', { name: 'EPUB overlays' }).click()
    const overlayDownload = await overlayDownloadPromise
    if (overlayDownload.suggestedFilename() !== 'smoke-queue-media-overlays.epub') {
      throw new Error(`Unexpected EPUB overlay filename: ${overlayDownload.suggestedFilename()}`)
    }
    const overlayPath = join(smokeDir, 'media-overlays.epub')
    await overlayDownload.saveAs(overlayPath)
    const overlayEntries = unzipSync(new Uint8Array(await readFile(overlayPath)))
    for (const entry of ['mimetype', 'META-INF/container.xml', 'OEBPS/package.opf', 'OEBPS/media/0001.smil', 'OEBPS/audio/0001.mp3']) {
      if (!overlayEntries[entry]) throw new Error(`EPUB overlay export is missing ${entry}`)
    }
    const overlayDecoder = new TextDecoder()
    const overlayPackage = overlayDecoder.decode(overlayEntries['OEBPS/package.opf'])
    const overlaySmil = overlayDecoder.decode(overlayEntries['OEBPS/media/0001.smil'])
    if (!overlayPackage.includes('version="3.0"') || !overlayPackage.includes('media-overlay="smil-0"')) {
      throw new Error('EPUB overlay package is missing EPUB3 media-overlay metadata')
    }
    if (!overlaySmil.includes('clipBegin="0.000s"') || !overlaySmil.includes('#reader-c0-p0-s0')) {
      throw new Error('EPUB overlay SMIL is missing synchronized text timing')
    }
    const queueChunks = desktop.page.getByLabel('Smoke queue completed chunks')
    const sentenceRetakes = queueChunks.getByLabel('Sentence retakes for chunk 1')
    await sentenceRetakes.waitFor({ timeout: 20000 })
    await sentenceRetakes.getByRole('button', { name: '1. Smoke sentence one.' }).click()
    await sentenceRetakes.getByLabel('Retake text for sentence 1').waitFor({ timeout: 20000 })
    if (await sentenceRetakes.getByRole('button', { name: 'Retake sentence' }).count() !== 1) {
      throw new Error('Sentence retake controls did not load for the completed queue chunk')
    }
    const companionMessages = []
    const companion = await desktopContext.newPage()
    companion.on('console', (msg) => {
      if (['error', 'warning'].includes(msg.type())) companionMessages.push(`${msg.type()}: ${msg.text()}`)
    })
    companion.on('pageerror', (err) => companionMessages.push(`pageerror: ${err.message}`))
    await companion.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await companion.locator('button:visible').filter({ hasText: /^Generate audio$/ }).first().waitFor({ timeout: 20000 })
    await companion.getByRole('tab', { name: /Queue/ }).click()
    await companion.getByLabel('Generation queue').getByText('Smoke queue').waitFor({ timeout: 20000 })

    await queueChunks.getByRole('button', { name: 'Play' }).first().click()
    await queueChunks.getByRole('button', { name: /Previous sentence/ }).waitFor({ timeout: 20000 })
    await queueChunks.getByRole('button', { name: /Next sentence/ }).waitFor({ timeout: 20000 })
    if (optionalPlaybackSurfaces.documentPictureInPicture) {
      await outputTab.click()
      await miniPlayerTrigger.waitFor({ state: 'visible', timeout: 20000 })
      await miniPlayerTrigger.click()
      await desktop.page.locator('[data-testid="mini-player-trigger"][aria-label="Close mini player"]').waitFor({ timeout: 20000 })
      const pipSurface = await desktop.page.evaluate(() => {
        const pipWindow = window.documentPictureInPicture?.window
        return {
          available: Boolean(pipWindow),
          hasPrevious: Boolean(pipWindow?.document.querySelector('[aria-label="Previous sentence"]')),
          hasNext: Boolean(pipWindow?.document.querySelector('[aria-label="Next sentence"]')),
          hasHighlight: Boolean(pipWindow?.document.querySelector('.mini-player-cue')?.textContent?.trim()),
        }
      })
      if (!pipSurface.available || !pipSurface.hasPrevious || !pipSurface.hasNext || !pipSurface.hasHighlight) {
        throw new Error(`Document Picture-in-Picture transport did not render correctly: ${JSON.stringify(pipSurface)}`)
      }
      await desktop.page.evaluate(() => window.documentPictureInPicture?.window?.close())
      await desktop.page.locator('[data-testid="mini-player-trigger"][aria-label="Open mini player"]').waitFor({ timeout: 20000 })
      await desktop.page.getByRole('tab', { name: /Queue/ }).click()
    }
    await queueChunks.getByText(/Resumed at/).waitFor({ timeout: 20000 })
    await queueChunks.getByRole('button', { name: 'Edit' }).first().click()
    const chunkEditor = queueChunks.locator('.queue-chunk-editor').first()
    await chunkEditor.getByLabel('Chapter title').fill('Smoke revised chapter')
    await companion.evaluate(async () => {
      navigator.locks.request('bettertts-job:smoke-default', { mode: 'exclusive' }, async () => {
        window.__betterttsSmokeLeaseHeld = true
        await new Promise((resolve) => {
          window.__betterttsSmokeReleaseLease = resolve
        })
      })
      while (!window.__betterttsSmokeLeaseHeld) await new Promise((resolve) => setTimeout(resolve, 10))
    })
    await chunkEditor.getByRole('button', { name: 'Save title' }).click()
    await desktop.page.getByText(/active in another BetterTTS tab/).waitFor({ timeout: 20000 })
    await companion.evaluate(() => window.__betterttsSmokeReleaseLease?.())
    await chunkEditor.getByRole('button', { name: 'Save title' }).click()
    await desktop.page.getByText('Chapter metadata updated.').waitFor({ timeout: 20000 })
    await queueChunks.getByText('Smoke revised chapter').waitFor({ timeout: 20000 })
    await queueChunks.getByRole('button', { name: 'Edit' }).first().click()
    await chunkEditor.getByLabel('Segment text').fill('Smoke replacement segment.')
    await chunkEditor.getByRole('button', { name: 'Regenerate' }).waitFor({ timeout: 20000 })
    await chunkEditor.getByRole('button', { name: 'Cancel' }).click()
    await queue.getByRole('button', { name: 'Remove queue job Smoke queue' }).click()
    await queue.getByText('Queue is empty').waitFor({ timeout: 20000 })
    await companion.getByLabel('Generation queue').getByText('Queue is empty').waitFor({ timeout: 20000 })
    await desktop.page.getByRole('button', { name: 'Undo' }).click()
    await queue.getByText('Smoke queue').waitFor({ timeout: 20000 })
    await companion.getByLabel('Generation queue').getByText('Smoke queue').waitFor({ timeout: 20000 })
    await companion.close()

    console.log('Checking library playback controls...')
    await desktop.page.getByRole('tab', { name: /Library/ }).click()
    const libraryPanel = desktop.page.getByRole('tabpanel', { name: /Clip library/ })
    await libraryPanel.scrollIntoViewIfNeeded()
    await desktop.page.waitForTimeout(200)
    await desktop.page.screenshot({ path: join(smokeDir, 'library-dark.png'), fullPage: false })
    const librarySearch = libraryPanel.getByLabel('Search saved clips')
    await librarySearch.focus()
    await librarySearch.fill('Smoke')
    await libraryPanel.getByText('1 of 3 clips shown').waitFor({ timeout: 20000 })
    await libraryPanel.getByLabel('Sort saved clips').selectOption('size-asc')
    await librarySearch.fill('')
    await libraryPanel.getByLabel('Filter saved clips by voice').selectOption('M1')
    await libraryPanel.getByText('Older chapter').waitFor({ timeout: 20000 })
    await libraryPanel.getByLabel('Filter saved clips by engine').selectOption('supertonic')
    await libraryPanel.getByLabel('Filter saved clips by cue state').selectOption('without-cues')
    await libraryPanel.getByText('1 of 3 clips shown').waitFor({ timeout: 20000 })
    await libraryPanel.getByLabel('Filter saved clips by voice').selectOption('all')
    await libraryPanel.getByLabel('Filter saved clips by engine').selectOption('all')
    await libraryPanel.getByLabel('Filter saved clips by cue state').selectOption('all')
    await librarySearch.fill('Smoke')
    await libraryPanel.getByRole('button', { name: 'Play' }).click()
    await libraryPanel.getByRole('button', { name: /Previous sentence/ }).waitFor({ timeout: 20000 })
    await libraryPanel.getByRole('button', { name: /Next sentence/ }).waitFor({ timeout: 20000 })
    await libraryPanel.getByText(/Resumed at/).waitFor({ timeout: 20000 })
    await libraryPanel.getByRole('button', { name: 'Remove Smoke library clip' }).click()
    await libraryPanel.getByText('No clips match these filters').waitFor({ timeout: 20000 })
    await libraryPanel.getByRole('button', { name: 'Clear filters' }).click()
    await libraryPanel.getByText('Older chapter').waitFor({ timeout: 20000 })
    await desktop.page.getByRole('button', { name: 'Undo' }).click()
    await libraryPanel.getByText('Smoke library clip').waitFor({ timeout: 20000 })
    await libraryPanel.getByRole('button', { name: 'Clear library' }).click()
    await libraryPanel.getByText('No saved clips').waitFor({ timeout: 20000 })
    await desktop.page.getByRole('button', { name: 'Undo' }).click()
    await libraryPanel.getByText('Smoke library clip').waitFor({ timeout: 20000 })
    await desktop.page.getByRole('button', { name: /^Kokoro 82M/ }).click()
    await fileInput.setInputFiles(makeEpubUpload())
    const epubImportResult = await Promise.race([
      desktop.page.getByText(/Imported "worker-book" — 2 chapters/).waitFor({ timeout: 20000 }).then(() => 'ok'),
      desktop.page.locator('.toast.error').waitFor({ timeout: 20000 }).then(async () => desktop.page.locator('.toast.error').innerText()),
    ])
    if (epubImportResult !== 'ok') throw new Error(`EPUB worker import did not complete: ${epubImportResult}`)
    const epubMapping = desktop.page.getByRole('region', { name: 'Review EPUB chapters' })
    await epubMapping.waitFor({ timeout: 20000 })
    await epubMapping.getByRole('combobox', { name: 'Voice for Chapter 1' }).waitFor({ timeout: 20000 })
    await epubMapping.getByRole('checkbox', { name: 'Blend voices for Chapter 1' }).waitFor({ timeout: 20000 })
    await epubMapping.getByRole('button', { name: 'Split', exact: true }).first().click()
    await epubMapping.getByRole('textbox', { name: 'Title for Chapter 3' }).waitFor({ timeout: 20000 })
    await epubMapping.getByRole('button', { name: 'Queue with defaults' }).click()
    await desktop.page.getByRole('heading', { name: 'worker-book' }).waitFor({ timeout: 20000 })
    await desktop.page.getByRole('button', { name: 'Line focus' }).click()
    await desktop.page.getByRole('button', { name: 'Exit focus' }).waitFor({ timeout: 20000 })
    await desktop.page.getByRole('button', { name: 'Next chapter' }).click()
    await desktop.page.getByText('Second worker chapter.').waitFor({ timeout: 20000 })
    await desktop.page.getByText('Second worker chapter.').click()
    const readerResumeKeys = await desktop.page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('bettertts-reader-v1:')))
    if (readerResumeKeys.length !== 1) throw new Error(`Reader did not persist a per-document resume coordinate: ${JSON.stringify(readerResumeKeys)}`)
    await desktop.page.evaluate(() => localStorage.removeItem('bettertts-experimental-piper'))
    await desktop.page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await desktop.page.locator('button:visible').filter({ hasText: /^Generate audio$/ }).first().waitFor({ timeout: 20000 })
    if ((await desktop.page.evaluate(() => document.documentElement.dataset.theme)) === 'light') await desktop.page.getByRole('button', { name: /Switch to dark theme/ }).click()
    await desktop.page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      document.scrollingElement?.scrollTo(0, 0)
      document.querySelector('.settings-scroll')?.scrollTo(0, 0)
    })
    await desktop.page.waitForTimeout(200)
    await desktop.page.screenshot({ path: join(smokeDir, 'desktop.png'), fullPage: false })
    await desktop.page.getByRole('link', { name: 'Models', exact: true }).click()
    await desktop.page.waitForTimeout(200)
    await desktop.page.screenshot({ path: join(smokeDir, 'models-dark.png'), fullPage: false })
    await desktop.page.getByRole('link', { name: 'Docs', exact: true }).click()
    await desktop.page.waitForTimeout(200)
    await desktop.page.screenshot({ path: join(smokeDir, 'docs-dark.png'), fullPage: false })
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
    const mobileWorkspaceNav = mobile.page.getByRole('navigation', { name: 'Workspace' })
    for (const destination of ['Studio', 'Queue', 'Library', 'Models', 'Diagnostics', 'Docs']) {
      if (!(await mobileWorkspaceNav.getByRole('link', { name: new RegExp(`^${destination}`) }).isVisible())) {
        throw new Error(`Mobile workspace destination is not visible: ${destination}`)
      }
    }
    const mobileNavLayout = await mobileWorkspaceNav.evaluate((nav) => {
      const navRect = nav.getBoundingClientRect()
      const links = Array.from(nav.querySelectorAll('a')).map((link) => {
        const rect = link.getBoundingClientRect()
        const label = link.querySelector(':scope > span')
        return {
          text: link.textContent?.trim(),
          left: rect.left,
          right: rect.right,
          labelClipped: label ? label.scrollWidth > label.clientWidth + 1 : true,
        }
      })
      return { left: navRect.left, right: navRect.right, clientWidth: nav.clientWidth, scrollWidth: nav.scrollWidth, links }
    })
    if (
      mobileNavLayout.scrollWidth > mobileNavLayout.clientWidth + 1
      || mobileNavLayout.links.some((link) => link.left < mobileNavLayout.left - 1 || link.right > mobileNavLayout.right + 1 || link.labelClipped)
    ) {
      throw new Error(`Mobile workspace rail clips destinations: ${JSON.stringify(mobileNavLayout)}`)
    }
    if (!(await mobile.page.locator('.editor-actions').getByRole('button', { name: 'Generate audio' }).isVisible())) {
      throw new Error('Mobile editor-level Generate audio action is not visible')
    }
    await mobile.page.getByRole('tab', { name: /Queue/ }).click()
    await mobile.page.locator('.queue-panel .capability-strip').waitFor({ state: 'visible', timeout: 20000 })
    await mobile.page.getByRole('button', { name: 'ZIP fallback' }).waitFor({ timeout: 20000 })
    const m4bButton = mobile.page.getByRole('button', { name: 'M4B' })
    if (!(await m4bButton.isDisabled())) throw new Error('M4B button should be disabled in unsupported AAC smoke state')
    await mobile.page.getByRole('button', { name: 'System & diagnostics' }).click()
    await mobile.page.getByLabel('Diagnostics export').scrollIntoViewIfNeeded()
    await mobile.page.evaluate(() => localStorage.removeItem('bettertts-experimental-piper'))
    await mobile.page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await mobile.page.locator('button:visible').filter({ hasText: /^Generate audio$/ }).first().waitFor({ timeout: 20000 })
    if ((await mobile.page.evaluate(() => document.documentElement.dataset.theme)) === 'dark') await mobile.page.getByRole('button', { name: /Switch to light theme/ }).click()
    await mobile.page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      document.scrollingElement?.scrollTo(0, 0)
      document.querySelector('.settings-scroll')?.scrollTo(0, 0)
    })
    await mobile.page.waitForTimeout(200)
    await mobile.page.screenshot({ path: join(smokeDir, 'mobile.png'), fullPage: false })
    await mobileContext.close()
    const expectedScreenshots = [
      'desktop.png',
      'desktop-light.png',
      'mobile.png',
      'queue-dark.png',
      'library-dark.png',
      'diagnostics-light.png',
      'subtitle-revoice-dark.png',
      'models-dark.png',
      'docs-dark.png',
    ]
    for (const screenshot of expectedScreenshots) {
      const info = await stat(join(smokeDir, screenshot))
      if (!info.isFile() || info.size < 10_000) throw new Error(`Rendered smoke capture is missing or empty: ${screenshot}`)
    }
    const allMessages = [...desktop.messages, ...companionMessages, ...mobile.messages]
    const unexpected = allMessages.filter((msg) => !allowedConsole.some((allowed) => msg.includes(allowed)))
    if (unexpected.length > 0) throw new Error(`Unexpected console messages:\n${unexpected.join('\n')}`)

    const realEngine = runRealEngine ? await runRealEngineChecks(browser) : null
    const summary = {
      ok: true,
      url: baseUrl,
      screenshots: expectedScreenshots.map((name) => `dist/smoke/${name}`),
      allowedConsoleMessages: allMessages,
      performance: {
        timeToInteractiveMs: Math.round(desktop.timeToInteractiveMs),
        timeToInteractiveBudgetMs: performanceBudget.shell.maxTimeToInteractiveMs,
        initialAssets: desktop.initialAssets,
      },
      ...(realEngine ? { realEngine } : {}),
    }
    await writeFile(join(smokeDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    await browser?.close().catch(() => undefined)
    server.closeAllConnections()
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
    case '.mjs': return 'text/javascript; charset=utf-8'
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
