import { DOMParser as LinkedomDOMParser } from 'linkedom'
import { extractDocxTextFromArrayBuffer, extractPdfTextFromArrayBuffer } from '../lib/document-import.ts'
import { parseEpubFromArrayBuffer } from '../lib/epub.ts'

type ImportKind = 'pdf' | 'docx' | 'epub'

export type DocumentWorkerRequest = {
  type: 'import'
  id: number
  kind: ImportKind
  name: string
  buffer: ArrayBuffer
}

export type DocumentWorkerResponse =
  | { type: 'progress'; id: number; phase: 'parse'; done: number; total: number }
  | { type: 'result'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string }

;(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser = LinkedomDOMParser as unknown as typeof DOMParser

function titleWithoutExtension(name: string): string {
  return name.replace(/\.(pdf|docx|epub)$/i, '').trim() || 'Imported document'
}

function safeImportError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/^(PDF|DOCX|EPUB|Not a valid EPUB|No selectable text|Password-protected)/i.test(message)) {
    return message.slice(0, 300)
  }
  return 'Document import failed. The file may be damaged or unsupported.'
}

self.addEventListener('message', async (event: MessageEvent<DocumentWorkerRequest>) => {
  const request = event.data
  if (!request || request.type !== 'import') return
  const progress = (done: number, total: number) => {
    self.postMessage({ type: 'progress', id: request.id, phase: 'parse', done, total } satisfies DocumentWorkerResponse)
  }
  try {
    let result: unknown
    if (request.kind === 'pdf') {
      result = {
        kind: 'pdf',
        title: titleWithoutExtension(request.name),
        text: await extractPdfTextFromArrayBuffer(request.buffer, progress),
      }
    } else if (request.kind === 'docx') {
      progress(0, 1)
      result = {
        kind: 'docx',
        title: titleWithoutExtension(request.name),
        text: extractDocxTextFromArrayBuffer(request.buffer),
      }
      progress(1, 1)
    } else {
      result = {
        kind: 'epub',
        title: titleWithoutExtension(request.name),
        chapters: parseEpubFromArrayBuffer(request.buffer, progress),
      }
    }
    self.postMessage({ type: 'result', id: request.id, result } satisfies DocumentWorkerResponse)
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: request.id,
      message: safeImportError(error),
    } satisfies DocumentWorkerResponse)
  }
})
