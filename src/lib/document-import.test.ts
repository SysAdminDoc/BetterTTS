// @vitest-environment jsdom
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extractDocxTextFromArrayBuffer, extractPdfTextFromArrayBuffer, importDocumentFile, isDocumentImportFile } from './document-import.ts'

function bytesToBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function makeDocx(documentXml: string): ArrayBuffer {
  return bytesToBuffer(zipSync({
    '[Content_Types].xml': new TextEncoder().encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'word/document.xml': new TextEncoder().encode(documentXml),
    'word/header1.xml': new TextEncoder().encode('<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Repeated Header</w:t></w:r></w:p></w:hdr>'),
    'word/footer1.xml': new TextEncoder().encode('<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Page 1</w:t></w:r></w:p></w:ftr>'),
  }))
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

function makePdf(text: string): ArrayBuffer {
  const parts = ['%PDF-1.4\n']
  const offsets: number[] = [0]
  const addObject = (id: number, body: string) => {
    offsets[id] = parts.join('').length
    parts.push(`${id} 0 obj\n${body}\nendobj\n`)
  }

  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>')
  addObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  addObject(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>')
  addObject(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const escaped = text.replace(/[()\\]/g, '\\$&')
  const stream = text ? `BT /F1 24 Tf 100 700 Td (${escaped}) Tj ET` : ''
  addObject(5, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)

  const xref = parts.join('').length
  parts.push('xref\n0 6\n0000000000 65535 f \n')
  for (let id = 1; id <= 5; id += 1) {
    parts.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)
  }
  parts.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return bytesToBuffer(new TextEncoder().encode(parts.join('')))
}

describe('document import adapters', () => {
  it('extracts selectable text from a PDF', async () => {
    await expect(extractPdfTextFromArrayBuffer(makePdf('Hello PDF import.'))).resolves.toContain('Hello PDF import.')
  })

  it('reports scanned or textless PDFs clearly', async () => {
    await expect(extractPdfTextFromArrayBuffer(makePdf(''))).rejects.toThrow('No selectable text')
  })

  it('extracts DOCX paragraphs and ignores header/footer parts', () => {
    const xml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Chapter One</w:t></w:r></w:p>
    <w:p><w:r><w:t>The body text</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>continues.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Claim</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:t> remains readable.</w:t></w:r></w:p>
  </w:body>
</w:document>`

    const text = extractDocxTextFromArrayBuffer(makeDocx(xml))
    expect(text).toContain('Chapter One')
    expect(text).toContain('The body text continues.')
    expect(text).toContain('Claim remains readable.')
    expect(text).not.toContain('Repeated Header')
    expect(text).not.toContain('Page 1')
  })

  it('throws on DOCX files without readable body text', () => {
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>'
    expect(() => extractDocxTextFromArrayBuffer(makeDocx(xml))).toThrow('no readable text')
  })

  it('throws on invalid DOCX packages', () => {
    const invalid = bytesToBuffer(zipSync({ 'word/styles.xml': new TextEncoder().encode('<xml/>') }))
    expect(() => extractDocxTextFromArrayBuffer(invalid)).toThrow('word/document.xml')
  })

  it('rejects a DOCX body that declares an oversized expansion before inflating it', () => {
    const archive = zipSync({
      'word/document.xml': new TextEncoder().encode('<w:document><w:body><w:p>tiny</w:p></w:body></w:document>'),
    })
    const oversized = declareZipEntrySize(archive, 0xffffffff)
    expect(() => extractDocxTextFromArrayBuffer(bytesToBuffer(oversized))).toThrow('word/document.xml')
  })

  it('rejects a highly compressed DOCX body before inflating it', () => {
    const repeated = 'a'.repeat(1_000_000)
    const archive = makeDocx(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${repeated}</w:t></w:r></w:p></w:body></w:document>`,
    )
    expect(() => extractDocxTextFromArrayBuffer(archive)).toThrow('compression-ratio')
  })

  it('routes document files by extension or MIME type', async () => {
    const pdf = new File([makePdf('Router PDF.')], 'router.pdf', { type: 'application/octet-stream' })
    const docx = new File([makeDocx('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Router DOCX.</w:t></w:r></w:p></w:body></w:document>')], 'router.bin', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })

    expect(isDocumentImportFile(pdf)).toBe(true)
    expect(isDocumentImportFile(docx)).toBe(true)
    await expect(importDocumentFile(pdf)).resolves.toMatchObject({ kind: 'pdf', title: 'router' })
    await expect(importDocumentFile(docx)).resolves.toMatchObject({ kind: 'docx', title: 'router.bin' })
  })
})
