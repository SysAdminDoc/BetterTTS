import {
  extractInspectedZipEntries,
  inspectZipArchive,
  normalizeArchivePath,
  type ArchiveBudget,
} from './archive-budget.ts'

export type EpubChapter = {
  title: string
  text: string
}

const MAX_EPUB_ARCHIVE_BYTES = 25 * 1024 * 1024
const MAX_EPUB_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_EPUB_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_EPUB_ENTRIES = 10_000
const MAX_EPUB_SELECTED_ENTRIES = 2_010
const MAX_EPUB_COMPRESSION_RATIO = 200
export const MAX_EPUB_CHAPTERS = 2_000
export const MAX_EPUB_TEXT_CHARS = 10_000_000
export const MAX_EPUB_CHAPTER_CHARS = 1_000_000

const EPUB_ARCHIVE_BUDGET: ArchiveBudget = {
  maxArchiveBytes: MAX_EPUB_ARCHIVE_BYTES,
  maxEntries: MAX_EPUB_ENTRIES,
  maxEntryBytes: MAX_EPUB_ENTRY_BYTES,
  maxTotalBytes: MAX_EPUB_TOTAL_BYTES,
  maxCompressionRatio: MAX_EPUB_COMPRESSION_RATIO,
}
const EPUB_SELECTION_BUDGET: ArchiveBudget = {
  ...EPUB_ARCHIVE_BUDGET,
  maxEntries: MAX_EPUB_SELECTED_ENTRIES,
}

export async function parseEpub(file: File): Promise<EpubChapter[]> {
  return parseEpubFromArrayBuffer(await file.arrayBuffer())
}

export function parseEpubFromArrayBuffer(
  source: ArrayBuffer,
  onChapter?: (chapter: number, total: number) => void,
): EpubChapter[] {
  const buffer = new Uint8Array(source)
  const entries = inspectZipArchive(buffer, EPUB_ARCHIVE_BUDGET, 'EPUB')

  const decoder = new TextDecoder('utf-8')
  const entryNameFor = (path: string): string | null => {
    // Manifest/NCX/nav hrefs are URIs — an entry named "My Chapter.xhtml" is
    // referenced as "My%20Chapter.xhtml", so match the decoded form too.
    const raw = normalizeArchivePath(path)
    let decoded = raw
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      /* malformed escape — fall back to the raw href */
    }
    return entries.find((entry) => entry.normalizedName === raw || entry.normalizedName === decoded)?.normalizedName ?? null
  }
  const extractPaths = (paths: Iterable<string>, label: string): Record<string, Uint8Array> => {
    const names = new Set<string>()
    for (const path of paths) {
      const name = entryNameFor(path)
      if (name) names.add(name)
    }
    return extractInspectedZipEntries(buffer, entries, names, EPUB_SELECTION_BUDGET, label)
  }
  const read = (files: Record<string, Uint8Array>, path: string): string | null => {
    const key = entryNameFor(path)
    return key && files[key] ? decoder.decode(files[key]) : null
  }

  // 1. Find the rootfile from META-INF/container.xml
  const metadataFiles = extractPaths(['META-INF/container.xml'], 'EPUB container')
  const containerXml = read(metadataFiles, 'META-INF/container.xml')
  if (!containerXml) throw new Error('Not a valid EPUB. META-INF/container.xml is missing.')

  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml')
  const rootfilePath = containerDoc.querySelector('rootfile')?.getAttribute('full-path')
  if (!rootfilePath) throw new Error('EPUB container has no rootfile reference')

  // 2. Parse the OPF to get the spine order + manifest
  const packageFiles = extractPaths([rootfilePath], 'EPUB package')
  const opfXml = read(packageFiles, rootfilePath)
  if (!opfXml) throw new Error(`EPUB missing content file: ${rootfilePath}`)
  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml')
  const opfDir = rootfilePath.includes('/') ? rootfilePath.slice(0, rootfilePath.lastIndexOf('/') + 1) : ''

  const manifest = new Map<string, string>()
  for (const item of opfDoc.querySelectorAll('manifest > item')) {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')
    if (id && href) manifest.set(id, opfDir + href)
  }

  const spineOrder: string[] = []
  for (const itemref of opfDoc.querySelectorAll('spine > itemref')) {
    const idref = itemref.getAttribute('idref')
    if (idref) spineOrder.push(idref)
  }
  if (spineOrder.length > MAX_EPUB_CHAPTERS) {
    throw new Error(`EPUB exceeds the ${MAX_EPUB_CHAPTERS}-chapter limit.`)
  }

  // 3. Try to extract chapter titles from the NCX TOC or nav document
  const tocTitles = new Map<string, string>()
  const tocId = opfDoc.querySelector('spine')?.getAttribute('toc')
  const tocPath = tocId ? manifest.get(tocId) : null
  const navItem = opfDoc.querySelector('manifest > item[properties~="nav"]')
  const navHref = navItem?.getAttribute('href')
  const contentPaths = new Set<string>()
  for (const idref of spineOrder) {
    const href = manifest.get(idref)
    if (href) contentPaths.add(href)
  }
  if (tocPath) contentPaths.add(tocPath)
  if (navHref) contentPaths.add(opfDir + navHref)
  const contentFiles = extractPaths(contentPaths, 'EPUB reading order')

  if (tocPath) {
    const ncxXml = read(contentFiles, tocPath)
    if (ncxXml) {
      const ncxDoc = new DOMParser().parseFromString(ncxXml, 'application/xml')
      for (const navPoint of ncxDoc.querySelectorAll('navPoint')) {
        const label = navPoint.querySelector(':scope > navLabel > text')?.textContent?.trim()
        const src = navPoint.querySelector(':scope > content')?.getAttribute('src')
        if (label && src) {
          const resolved = opfDir + src.split('#')[0]
          tocTitles.set(resolved, label)
        }
      }
    }
  }

  // Also check for EPUB 3 nav document
  if (navItem) {
    if (navHref) {
      const navXml = read(contentFiles, opfDir + navHref)
      if (navXml) {
        const navDoc = new DOMParser().parseFromString(navXml, 'application/xhtml+xml')
        const tocNav = navDoc.querySelector('nav[*|type="toc"], nav.toc')
        if (tocNav) {
          for (const link of tocNav.querySelectorAll('a[href]')) {
            const href = link.getAttribute('href')
            const title = link.textContent?.trim()
            if (href && title) {
              const resolved = opfDir + href.split('#')[0]
              if (!tocTitles.has(resolved)) tocTitles.set(resolved, title)
            }
          }
        }
      }
    }
  }

  // 4. Extract text from each spine document
  const chapters: EpubChapter[] = []
  let chapterNum = 0
  let totalTextChars = 0
  for (const idref of spineOrder) {
    const href = manifest.get(idref)
    if (!href) continue
    const xhtml = read(contentFiles, href)
    if (!xhtml) continue

    let doc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml')
    // Converted EPUBs routinely contain non-well-formed XHTML; rather than
    // silently dropping the chapter on a parsererror, re-parse as HTML.
    if (doc.querySelector('parsererror')) {
      doc = new DOMParser().parseFromString(xhtml, 'text/html')
    }
    const body = doc.querySelector('body')
    if (!body) continue

    const text = extractText(body).replace(/\n{3,}/g, '\n\n').trim()
    if (!text) continue
    if (text.length > MAX_EPUB_CHAPTER_CHARS) {
      throw new Error(`EPUB chapter ${chapterNum + 1} exceeds the ${MAX_EPUB_CHAPTER_CHARS.toLocaleString()}-character limit.`)
    }
    totalTextChars += text.length
    if (totalTextChars > MAX_EPUB_TEXT_CHARS) {
      throw new Error(`EPUB exceeds the ${MAX_EPUB_TEXT_CHARS.toLocaleString()}-character text limit.`)
    }

    chapterNum++
    const title = tocTitles.get(href) ?? `Chapter ${chapterNum}`
    chapters.push({ title, text })
    onChapter?.(chapterNum, spineOrder.length)
  }

  if (chapters.length === 0) throw new Error('EPUB contains no readable text content')
  return chapters
}

function extractText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? ''
  if (node.nodeType !== 1) return ''

  const el = node as Element
  const tag = el.tagName.toLowerCase()

  // Skip non-content elements
  if (['script', 'style', 'svg', 'img', 'figure', 'table', 'nav', 'aside'].includes(tag)) return ''

  const parts: string[] = []
  for (const child of el.childNodes) {
    parts.push(extractText(child))
  }
  const inner = parts.join('')

  // Block elements get line breaks
  if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'br', 'hr', 'section', 'article'].includes(tag)) {
    return `\n${inner.trim()}\n`
  }

  return inner
}
