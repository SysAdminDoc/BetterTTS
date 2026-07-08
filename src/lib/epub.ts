import { unzipSync } from 'fflate'

export type EpubChapter = {
  title: string
  text: string
}

export async function parseEpub(file: File): Promise<EpubChapter[]> {
  const buffer = new Uint8Array(await file.arrayBuffer())
  const files = unzipSync(buffer)

  const decoder = new TextDecoder('utf-8')
  const read = (path: string): string | null => {
    const key = Object.keys(files).find((k) => k === path || k.replace(/^\//, '') === path)
    return key ? decoder.decode(files[key]) : null
  }

  // 1. Find the rootfile from META-INF/container.xml
  const containerXml = read('META-INF/container.xml')
  if (!containerXml) throw new Error('Not a valid EPUB — missing META-INF/container.xml')

  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml')
  const rootfilePath = containerDoc.querySelector('rootfile')?.getAttribute('full-path')
  if (!rootfilePath) throw new Error('EPUB container has no rootfile reference')

  // 2. Parse the OPF to get the spine order + manifest
  const opfXml = read(rootfilePath)
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

  // 3. Try to extract chapter titles from the NCX TOC or nav document
  const tocTitles = new Map<string, string>()
  const tocId = opfDoc.querySelector('spine')?.getAttribute('toc')
  const tocPath = tocId ? manifest.get(tocId) : null
  if (tocPath) {
    const ncxXml = read(tocPath)
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
  const navItem = opfDoc.querySelector('manifest > item[properties~="nav"]')
  if (navItem) {
    const navHref = navItem.getAttribute('href')
    if (navHref) {
      const navXml = read(opfDir + navHref)
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
  for (const idref of spineOrder) {
    const href = manifest.get(idref)
    if (!href) continue
    const xhtml = read(href)
    if (!xhtml) continue

    const doc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml')
    const body = doc.querySelector('body')
    if (!body) continue

    const text = extractText(body).replace(/\n{3,}/g, '\n\n').trim()
    if (!text) continue

    chapterNum++
    const title = tocTitles.get(href) ?? `Chapter ${chapterNum}`
    chapters.push({ title, text })
  }

  if (chapters.length === 0) throw new Error('EPUB contains no readable text content')
  return chapters
}

function extractText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

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
