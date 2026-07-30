import type { ImportedDocument } from './document-import.ts'
import type { EpubChapter } from './epub.ts'
import type { DocumentWorkerRequest, DocumentWorkerResponse } from '../worker/document.worker.ts'

export type DocumentImportProgress = {
  phase: 'read' | 'parse'
  done: number
  total: number
}

export type WorkerImportedDocument =
  | ImportedDocument
  | { kind: 'epub'; title: string; chapters: EpubChapter[] }

export const MAX_PDF_IMPORT_BYTES = 100 * 1024 * 1024
export const MAX_ZIP_DOCUMENT_IMPORT_BYTES = 25 * 1024 * 1024

function importKind(file: File): WorkerImportedDocument['kind'] {
  const name = file.name.toLowerCase()
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (file.type === 'application/epub+zip' || name.endsWith('.epub')) return 'epub'
  if (name.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  throw new Error('Import supports TXT, EPUB, PDF, and DOCX files.')
}

function validateImportSize(file: File, kind: WorkerImportedDocument['kind']): void {
  const maxBytes = kind === 'pdf' ? MAX_PDF_IMPORT_BYTES : MAX_ZIP_DOCUMENT_IMPORT_BYTES
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error('The selected document is empty or has an invalid size.')
  }
  if (file.size > maxBytes) {
    const limitMb = Math.round(maxBytes / (1024 * 1024))
    throw new Error(`${kind.toUpperCase()} import is limited to ${limitMb} MB.`)
  }
}

function cancellationError(): DOMException {
  return new DOMException('Document import cancelled.', 'AbortError')
}

async function importWithoutWorker(
  file: File,
  kind: WorkerImportedDocument['kind'],
): Promise<WorkerImportedDocument> {
  if (kind === 'epub') {
    const { parseEpub } = await import('./epub.ts')
    return { kind, title: file.name.replace(/\.epub$/i, ''), chapters: await parseEpub(file) }
  }
  const { importDocumentFile } = await import('./document-import.ts')
  return importDocumentFile(file)
}

export async function importDocumentInWorker(
  file: File,
  onProgress: (progress: DocumentImportProgress) => void,
  signal?: AbortSignal,
): Promise<WorkerImportedDocument> {
  const kind = importKind(file)
  validateImportSize(file, kind)
  if (signal?.aborted) throw cancellationError()
  onProgress({ phase: 'read', done: 0, total: file.size })
  const buffer = await file.arrayBuffer()
  if (signal?.aborted) throw cancellationError()
  onProgress({ phase: 'read', done: file.size, total: file.size })

  if (typeof Worker === 'undefined') return importWithoutWorker(file, kind)
  const worker = new Worker(new URL('../worker/document.worker.ts', import.meta.url), { type: 'module' })
  const id = 0
  return new Promise<WorkerImportedDocument>((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
    }
    const onAbort = () => {
      cleanup()
      reject(cancellationError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.addEventListener('message', (event: MessageEvent<DocumentWorkerResponse>) => {
      const message = event.data
      if (message.id !== id) return
      if (message.type === 'progress') {
        onProgress({ phase: message.phase, done: message.done, total: message.total })
      } else if (message.type === 'result') {
        cleanup()
        resolve(message.result as WorkerImportedDocument)
      } else if (message.type === 'error') {
        cleanup()
        reject(new Error(message.message))
      }
    })
    worker.addEventListener('error', () => {
      cleanup()
      reject(new Error('Document parser stopped unexpectedly. The previous script was kept.'))
    })
    worker.addEventListener('messageerror', () => {
      cleanup()
      reject(new Error('Document parser returned unreadable data. The previous script was kept.'))
    })
    const request: DocumentWorkerRequest = { type: 'import', id, kind, name: file.name, buffer }
    try {
      worker.postMessage(request, [buffer])
    } catch (error) {
      cleanup()
      reject(error instanceof Error ? error : new Error('Could not start the document parser.'))
    }
  })
}
