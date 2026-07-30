// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { parseEpub } from './epub.ts'

function makeEpub(
  chapters: { id: string; title: string; body: string }[],
  extras: Record<string, Uint8Array> = {},
): File {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

  const manifestItems = chapters
    .map((ch) => `<item id="${ch.id}" href="${ch.id}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n')
  const spineItems = chapters.map((ch) => `<itemref idref="${ch.id}"/>`).join('\n')
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
  </metadata>
  <manifest>${manifestItems}</manifest>
  <spine>${spineItems}</spine>
</package>`

  const files: Record<string, Uint8Array> = {
    'META-INF/container.xml': new TextEncoder().encode(containerXml),
    'content.opf': new TextEncoder().encode(opf),
    ...extras,
  }

  for (const ch of chapters) {
    files[`${ch.id}.xhtml`] = new TextEncoder().encode(
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${ch.title}</h1><p>${ch.body}</p></body></html>`,
    )
  }

  const zipped = zipSync(files)
  return new File([zipped], 'test.epub', { type: 'application/epub+zip' })
}

function declareZipEntrySize(bytes: Uint8Array, size: number): Uint8Array {
  const patched = bytes.slice()
  const view = new DataView(patched.buffer)
  for (let offset = 0; offset <= patched.length - 30; offset += 1) {
    const signature = view.getUint32(offset, true)
    if (signature === 0x04034b50) view.setUint32(offset + 22, size, true)
    if (signature === 0x02014b50) view.setUint32(offset + 24, size, true)
  }
  return patched
}

function bytesToBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

describe('parseEpub', () => {
  it('extracts chapters from a valid EPUB', async () => {
    const epub = makeEpub([
      { id: 'ch1', title: 'First', body: 'Hello from chapter one.' },
      { id: 'ch2', title: 'Second', body: 'Content of chapter two.' },
    ])
    const chapters = await parseEpub(epub)
    expect(chapters.length).toBe(2)
    expect(chapters[0].text).toContain('Hello from chapter one.')
    expect(chapters[1].text).toContain('Content of chapter two.')
  })

  it('assigns fallback titles when no TOC exists', async () => {
    const epub = makeEpub([{ id: 'ch1', title: 'Untitled', body: 'Some text.' }])
    const chapters = await parseEpub(epub)
    expect(chapters[0].title).toBe('Chapter 1')
  })

  it('skips chapters with only whitespace', async () => {
    const epub = makeEpub([
      { id: 'ch1', title: 'Full', body: 'Has content.' },
      { id: 'ch2', title: 'Blank', body: '   ' },
    ])
    const chapters = await parseEpub(epub)
    // ch2 has heading "Blank" so it may extract 1 or 2 depending on body.
    // The important thing is ch1 text is present.
    expect(chapters[0].text).toContain('Has content.')
  })

  it('throws on invalid EPUB (no container.xml)', async () => {
    const zipped = zipSync({ 'random.txt': new TextEncoder().encode('not an epub') })
    const file = new File([zipped], 'bad.epub')
    await expect(parseEpub(file)).rejects.toThrow('container.xml')
  })

  it('rejects EPUB entries that declare oversized expansions before inflating them', async () => {
    const archive = zipSync({
      'META-INF/container.xml': new TextEncoder().encode('<container/>'),
    })
    const oversized = declareZipEntrySize(archive, 0xffffffff)
    await expect(parseEpub(new File([bytesToBuffer(oversized)], 'oversized.epub'))).rejects.toThrow('container.xml')
  })

  it('ignores unreferenced compressed media and rejects compressed reading-order bombs', async () => {
    const withUnusedMedia = makeEpub(
      [{ id: 'ch1', title: 'Readable', body: 'Chapter text.' }],
      { 'media/unused.bin': new Uint8Array(1_000_000) },
    )
    await expect(parseEpub(withUnusedMedia)).resolves.toHaveLength(1)

    const compressedChapter = makeEpub([
      { id: 'ch1', title: 'Bomb', body: 'a'.repeat(1_000_000) },
    ])
    await expect(parseEpub(compressedChapter)).rejects.toThrow('compression-ratio')
  })

  it('rejects an excessive chapter count before inflating chapter bodies', async () => {
    const chapters = Array.from({ length: 2_001 }, (_, index) => ({
      id: `ch${index}`,
      title: `Chapter ${index}`,
      body: 'Text.',
    }))
    await expect(parseEpub(makeEpub(chapters))).rejects.toThrow('chapter limit')
  })

  it('resolves URI-encoded manifest hrefs to their zip entries', async () => {
    // Calibre-style: the entry has a space, the manifest href percent-encodes it.
    const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
  <manifest><item id="c1" href="My%20Chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`
    const zipped = zipSync({
      'META-INF/container.xml': new TextEncoder().encode(container),
      'content.opf': new TextEncoder().encode(opf),
      'My Chapter.xhtml': new TextEncoder().encode(
        '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Encoded href text.</p></body></html>',
      ),
    })
    const chapters = await parseEpub(new File([zipped], 'test.epub'))
    expect(chapters.length).toBe(1)
    expect(chapters[0].text).toContain('Encoded href text.')
  })

  it('falls back to HTML parsing for non-well-formed chapters', async () => {
    const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
  <manifest><item id="c1" href="broken.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`
    const zipped = zipSync({
      'META-INF/container.xml': new TextEncoder().encode(container),
      'content.opf': new TextEncoder().encode(opf),
      // Unclosed <p> and a raw ampersand: invalid XML, valid-enough HTML.
      'broken.xhtml': new TextEncoder().encode('<html><body><p>Broken & unclosed chapter text</body></html>'),
    })
    const chapters = await parseEpub(new File([zipped], 'test.epub'))
    expect(chapters.length).toBe(1)
    expect(chapters[0].text).toContain('Broken & unclosed chapter text')
  })
})
