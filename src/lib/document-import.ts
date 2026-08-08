import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'
import {
  extractInspectedZipEntries,
  inspectZipArchive,
  type ArchiveBudget,
} from './archive-budget.ts'

export type ImportedDocument = {
  kind: 'pdf' | 'docx'
  title: string
  text: string
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export function isDocumentImportFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return file.type === 'application/pdf'
    || file.type === DOCX_MIME
    || name.endsWith('.pdf')
    || name.endsWith('.docx')
}

export async function importDocumentFile(file: File): Promise<ImportedDocument> {
  const name = file.name.toLowerCase()
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) {
    return { kind: 'pdf', title: trimExtension(file.name), text: await extractPdfText(file) }
  }
  if (file.type === DOCX_MIME || name.endsWith('.docx')) {
    return { kind: 'docx', title: trimExtension(file.name), text: await extractDocxText(file) }
  }
  throw new Error('Import supports TXT, EPUB, PDF, and DOCX files.')
}

export async function extractPdfText(file: File): Promise<string> {
  try {
    return await extractPdfTextFromArrayBuffer(await file.arrayBuffer())
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (/password|encrypted|drm/i.test(message)) {
      throw new Error('Password-protected or encrypted PDFs cannot be imported locally.')
    }
    if (/No selectable text/i.test(message)) throw err
    throw new Error('PDF import failed. The file may be damaged, encrypted, or unsupported.')
  }
}

export async function extractPdfTextFromArrayBuffer(
  buffer: ArrayBuffer,
  onPage?: (page: number, total: number) => void,
): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const nestedWorkerAvailable = typeof Worker !== 'undefined'
  if (nestedWorkerAvailable) pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    ...(!nestedWorkerAvailable ? { disableWorker: true } : {}),
    disableFontFace: false,
    isEvalSupported: false,
    useSystemFonts: true,
  } as Parameters<typeof pdfjs.getDocument>[0] & { disableWorker?: boolean; isEvalSupported: boolean })
  const pdf = await loadingTask.promise
  try {
    if (await pdf.getJSActions()) {
      throw new Error('PDF contains JavaScript actions and cannot be imported locally.')
    }
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const lines = textContentToLines(content.items as PdfTextItem[])
      if (lines) pages.push(lines)
      onPage?.(pageNumber, pdf.numPages)
    }
    const text = normalizeTextBlocks(pages.join('\n\n'))
      .replace(/\b(?:[A-Z]\s+){2,}[A-Z]\b/g, (acronym) => acronym.replace(/\s+/g, ''))
    if (!text) throw new Error('No selectable text found in this PDF. Scanned PDFs need OCR before importing.')
    return text
  } finally {
    await loadingTask.destroy()
  }
}

export async function extractDocxText(file: File): Promise<string> {
  return extractDocxTextFromArrayBuffer(await file.arrayBuffer())
}

const MAX_DOCX_ARCHIVE_BYTES = 25 * 1024 * 1024
const MAX_DOCUMENT_XML_BYTES = 32 * 1024 * 1024
const DOCX_ARCHIVE_BUDGET: ArchiveBudget = {
  maxArchiveBytes: MAX_DOCX_ARCHIVE_BYTES,
  maxEntries: 2_000,
  maxEntryBytes: MAX_DOCUMENT_XML_BYTES,
  maxTotalBytes: MAX_DOCUMENT_XML_BYTES,
  maxCompressionRatio: 200,
}
const DOCX_DOCUMENT_BUDGET: ArchiveBudget = {
  ...DOCX_ARCHIVE_BUDGET,
  maxEntries: 1,
}

export function extractDocxTextFromArrayBuffer(buffer: ArrayBuffer): string {
  const source = new Uint8Array(buffer)
  const entries = inspectZipArchive(source, DOCX_ARCHIVE_BUDGET, 'DOCX')
  const files = extractInspectedZipEntries(
    source,
    entries,
    new Set(['word/document.xml']),
    DOCX_DOCUMENT_BUDGET,
    'DOCX word/document.xml',
  )
  const documentKey = 'word/document.xml'
  if (!files[documentKey]) throw new Error('DOCX import failed. The file is missing word/document.xml.')

  const xml = new TextDecoder('utf-8').decode(files[documentKey])
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('DOCX import failed. The document XML is damaged.')

  const body = Array.from(doc.querySelectorAll('*')).find((element) => localName(element) === 'body')
  if (!body) throw new Error('DOCX import failed. The document body is missing.')

  const text = normalizeTextBlocks(extractDocxNodeText(body))
  if (!text) throw new Error('DOCX contains no readable text content.')
  return text
}

type PdfTextItem = {
  str?: string
  hasEOL?: boolean
  transform?: number[]
  width?: number
  height?: number
}

function textContentToLines(items: PdfTextItem[]): string {
  const readableItems = items.filter((item) => typeof item.str === 'string' && item.str.trim())
  const positionedItems = readableItems.map((item, index) => {
    const transform = item.transform
    if (!transform || transform.length < 6) return null
    const x = Number(transform[4])
    const y = Number(transform[5])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const height = Math.abs(Number(item.height ?? transform[3])) || 12
    const width = Math.abs(Number(item.width)) || 0
    return { text: item.str!.trim(), x, y, width, height, index }
  })

  if (readableItems.length > 0 && positionedItems.every((item): item is NonNullable<typeof item> => item !== null)) {
    const columnBoundary = detectPdfColumnBoundary(positionedItems)
    const columnizedItems = positionedItems.map((item) => ({
      ...item,
      column: columnBoundary !== null && item.x >= columnBoundary ? 1 : 0,
    }))
    const lines: PdfTextLine[] = []
    for (const item of columnizedItems) {
      const tolerance = Math.max(2, Math.min(item.height, 16) * 0.45)
      const existing = lines.find((line) => line.column === item.column && Math.abs(line.y - item.y) <= Math.max(tolerance, line.height * 0.45))
      if (existing) {
        existing.fragments.push(item)
        existing.x = Math.min(existing.x, item.x)
        existing.height = Math.max(existing.height, item.height)
      } else {
        lines.push({
          fragments: [item],
          x: item.x,
          y: item.y,
          height: item.height,
          column: item.column,
        })
      }
    }
    return serializePdfLines(orderPdfLines(lines))
  }

  const lines: string[] = []
  let current = ''
  for (const item of items) {
    if (typeof item.str !== 'string') continue
    current += item.str
    if (item.hasEOL) {
      lines.push(current)
      current = ''
    } else if (item.str.trim()) {
      current += ' '
    }
  }
  if (current.trim()) lines.push(current)
  return normalizeTextBlocks(lines.join('\n'))
}

type PdfTextFragment = {
  text: string
  x: number
  y: number
  width: number
  height: number
  index: number
  column: number
}

type PdfTextLine = {
  fragments: PdfTextFragment[]
  x: number
  y: number
  height: number
  column: number
}

function orderPdfLines(lines: PdfTextLine[]): PdfTextLine[] {
  const byReadingOrder = (left: PdfTextLine, right: PdfTextLine) => right.y - left.y || left.x - right.x || left.fragments[0].index - right.fragments[0].index
  const sorted = lines.slice().sort(byReadingOrder)
  if (sorted.length < 4) return sorted

  const starts = [...new Set(lines.map((line) => line.x))].sort((left, right) => left - right)
  let splitIndex = -1
  let largestGap = 0
  for (let index = 1; index < starts.length; index += 1) {
    const gap = starts[index] - starts[index - 1]
    if (gap > largestGap) {
      largestGap = gap
      splitIndex = index
    }
  }
  const span = (starts.at(-1) ?? 0) - (starts[0] ?? 0)
  if (splitIndex < 0 || largestGap <= Math.max(96, span * 0.18)) return sorted

  const boundary = (starts[splitIndex - 1] + starts[splitIndex]) / 2
  const leftColumn = sorted.filter((line) => line.x < boundary)
  const rightColumn = sorted.filter((line) => line.x >= boundary)
  if (leftColumn.length < 2 || rightColumn.length < 2) return sorted

  return [
    ...leftColumn.map((line) => ({ ...line, column: 0 })).sort(byReadingOrder),
    ...rightColumn.map((line) => ({ ...line, column: 1 })).sort(byReadingOrder),
  ]
}

function detectPdfColumnBoundary(fragments: Array<Omit<PdfTextFragment, 'column'>>): number | null {
  if (fragments.length < 4) return null
  const starts = [...new Set(fragments.map((fragment) => fragment.x))].sort((left, right) => left - right)
  let splitIndex = -1
  let largestGap = 0
  for (let index = 1; index < starts.length; index += 1) {
    const gap = starts[index] - starts[index - 1]
    if (gap > largestGap) {
      largestGap = gap
      splitIndex = index
    }
  }
  const span = (starts.at(-1) ?? 0) - (starts[0] ?? 0)
  if (splitIndex < 0 || largestGap <= Math.max(96, span * 0.18)) return null

  const boundary = (starts[splitIndex - 1] + starts[splitIndex]) / 2
  const left = fragments.filter((fragment) => fragment.x < boundary)
  const right = fragments.filter((fragment) => fragment.x >= boundary)
  const rowCount = (items: typeof fragments) => new Set(items.map((item) => Math.round(item.y * 10) / 10)).size
  if (left.length < 2 || right.length < 2 || rowCount(left) < 2 || rowCount(right) < 2) return null
  return boundary
}

function serializePdfLines(lines: PdfTextLine[]): string {
  let output = ''
  let previous: PdfTextLine | null = null
  for (const line of lines) {
    const text = joinPdfFragments(line.fragments)
    if (!text) continue
    if (output && previous) {
      const verticalGap = previous.column === line.column ? previous.y - line.y : 0
      const paragraphBreak = previous.column === line.column && verticalGap > Math.max(previous.height, line.height) * 1.8
      output += paragraphBreak ? '\n\n' : '\n'
    }
    output += text
    previous = line
  }
  return normalizeTextBlocks(output)
}

function joinPdfFragments(fragments: PdfTextFragment[]): string {
  let output = ''
  for (const fragment of fragments.slice().sort((left, right) => left.x - right.x || left.index - right.index)) {
    if (!fragment.text) continue
    if (!output) {
      output = fragment.text
      continue
    }
    const noSpaceBefore = /^[,.;:!?%…)}\]]/u.test(fragment.text) || /^[\u0027’”»]/u.test(fragment.text)
    const noSpaceAfter = /[([{«“‘‐‑]$/u.test(output) || output.endsWith('-')
    output += noSpaceBefore || noSpaceAfter ? fragment.text : ` ${fragment.text}`
  }
  return output
}

function extractDocxNodeText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? ''
  if (node.nodeType !== 1) return ''

  const element = node as Element
  const tag = localName(element)
  if (['delText', 'footnoteReference', 'endnoteReference', 'annotationRef', 'drawing', 'pict', 'object'].includes(tag)) return ''
  if (tag === 't') return element.textContent ?? ''
  if (tag === 'tab') return '\t'
  if (tag === 'br' || tag === 'cr') return '\n'

  const inner = Array.from(element.childNodes).map(extractDocxNodeText).join('')
  if (tag === 'p') return `${inner.trim()}\n`
  if (tag === 'tr') return `${inner.trim()}\n`
  if (tag === 'tc') return `${inner.trim()}\t`
  return inner
}

function localName(element: Element): string {
  return (element.localName || element.tagName).replace(/^.*:/, '')
}

function normalizeTextBlocks(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\t+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function trimExtension(name: string): string {
  return name.replace(/\.(pdf|docx)$/i, '').trim() || 'Imported document'
}
