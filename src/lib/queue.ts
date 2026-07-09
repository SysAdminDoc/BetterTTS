import type { AudioFormat } from './encode.ts'
import type { Cue } from './subtitles.ts'
import type { KokoroLocale, VoiceId } from './voices.ts'

export type ChunkStatus = 'pending' | 'generating' | 'done' | 'failed'
export type QueueEngine = 'kokoro' | 'supertonic' | 'kitten'

export type QueueChunk = {
  index: number
  text: string
  status: ChunkStatus
  chapterTitle?: string
  chapterIndex?: number
  duration?: string
  cues?: Cue[]
  blobKey?: string
  error?: string
  /** Non-fatal completeness-check note (possible truncation / skipped text). */
  warning?: string
}

export type QueueJob = {
  schemaVersion: 2
  id: string
  title: string
  createdAt: number
  engine: QueueEngine
  voice: VoiceId | string
  language?: KokoroLocale
  speed: number
  format: AudioFormat
  bitrate: number
  supertonicSteps?: number
  kittenModel?: 'nano' | 'micro' | 'mini'
  chunks: QueueChunk[]
}

export type QueueJobSnapshot = {
  job: QueueJob
  blobs: Array<{ chunkIndex: number; blob: Blob }>
}

const DB_NAME = 'bettertts-queue'
const DB_VERSION = 2
const JOBS_STORE = 'jobs'
const CHUNKS_STORE = 'chunks'

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    let settled = false
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(JOBS_STORE)) db.createObjectStore(JOBS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) db.createObjectStore(CHUNKS_STORE)
    }
    req.onblocked = () => {
      settled = true
      dbPromise = null
      reject(new Error('Queue DB blocked'))
    }
    req.onsuccess = () => {
      const db = req.result
      // A blocked open can still succeed later, after the promise already
      // rejected — close the orphan instead of leaking the connection.
      if (settled) {
        db.close()
        return
      }
      settled = true
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => {
      settled = true
      dbPromise = null
      reject(req.error)
    }
  })
  return dbPromise
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    // Commit-time failures (e.g. quota checked lazily) fire only abort, with
    // no request-level error — without this the returned promise never settles.
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveJob(job: QueueJob): Promise<void> {
  const db = await openDB()
  const tx = db.transaction(JOBS_STORE, 'readwrite')
  tx.objectStore(JOBS_STORE).put(migrateQueueJob(job))
  await txDone(tx)
}

export async function listJobs(): Promise<QueueJob[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOBS_STORE, 'readonly')
    const req = tx.objectStore(JOBS_STORE).getAll()
    req.onsuccess = () => {
      const jobs = (req.result as unknown[]).map(migrateQueueJob)
      jobs.sort((a, b) => b.createdAt - a.createdAt)
      resolve(jobs)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function getJob(id: string): Promise<QueueJob | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOBS_STORE, 'readonly')
    const req = tx.objectStore(JOBS_STORE).get(id)
    req.onsuccess = () => resolve(req.result ? migrateQueueJob(req.result) : null)
    req.onerror = () => reject(req.error)
  })
}

export async function deleteJob(id: string): Promise<void> {
  const db = await openDB()
  const tx = db.transaction([JOBS_STORE, CHUNKS_STORE], 'readwrite')
  tx.objectStore(JOBS_STORE).delete(id)
  // Chunk blobs are keyed as "{jobId}:{chunkIndex}" — a bounded range delete
  // avoids materializing every stored audio blob just to prefix-match keys.
  tx.objectStore(CHUNKS_STORE).delete(IDBKeyRange.bound(`${id}:`, `${id}:￿`))
  await txDone(tx)
}

export async function deleteJobWithSnapshot(id: string): Promise<QueueJobSnapshot | null> {
  const db = await openDB()
  const tx = db.transaction([JOBS_STORE, CHUNKS_STORE], 'readwrite')
  const done = txDone(tx)
  const jobs = tx.objectStore(JOBS_STORE)
  const chunks = tx.objectStore(CHUNKS_STORE)
  const range = IDBKeyRange.bound(`${id}:`, `${id}:\uffff`)
  const [rawJob, keys, blobs] = await Promise.all([
    requestValue(jobs.get(id)),
    requestValue(chunks.getAllKeys(range)),
    requestValue(chunks.getAll(range)) as Promise<Blob[]>,
  ])
  jobs.delete(id)
  chunks.delete(range)
  await done

  if (!rawJob) return null
  return {
    job: migrateQueueJob(rawJob),
    blobs: keys.flatMap((key, index) => {
      const chunkIndex = Number(String(key).slice(id.length + 1))
      const blob = blobs[index]
      return Number.isInteger(chunkIndex) && blob ? [{ chunkIndex, blob }] : []
    }),
  }
}

export async function restoreQueueJob(snapshot: QueueJobSnapshot): Promise<void> {
  const db = await openDB()
  const tx = db.transaction([JOBS_STORE, CHUNKS_STORE], 'readwrite')
  tx.objectStore(JOBS_STORE).put(migrateQueueJob(snapshot.job))
  const chunks = tx.objectStore(CHUNKS_STORE)
  for (const entry of snapshot.blobs) {
    chunks.put(entry.blob, `${snapshot.job.id}:${entry.chunkIndex}`)
  }
  await txDone(tx)
}

export async function saveChunkBlob(jobId: string, chunkIndex: number, blob: Blob): Promise<void> {
  const db = await openDB()
  const tx = db.transaction(CHUNKS_STORE, 'readwrite')
  tx.objectStore(CHUNKS_STORE).put(blob, `${jobId}:${chunkIndex}`)
  await txDone(tx)
}

export async function getChunkBlob(jobId: string, chunkIndex: number): Promise<Blob | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNKS_STORE, 'readonly')
    const req = tx.objectStore(CHUNKS_STORE).get(`${jobId}:${chunkIndex}`)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  })
}

export function jobProgress(job: QueueJob): { done: number; total: number; pct: number } {
  const total = job.chunks.length
  const done = job.chunks.filter((c) => c.status === 'done').length
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 }
}

export function nextPendingChunk(job: QueueJob): QueueChunk | null {
  return job.chunks.find((c) => c.status === 'pending') ?? null
}

export function replaceQueueChunk(
  job: QueueJob,
  chunkIndex: number,
  patch: Pick<QueueChunk, 'text' | 'status'> & Partial<Pick<QueueChunk, 'chapterTitle' | 'chapterIndex' | 'duration' | 'cues'>>,
): QueueJob {
  return {
    ...job,
    chunks: job.chunks.map((chunk) => (
      chunk.index === chunkIndex
        ? {
            ...chunk,
            text: patch.text,
            status: patch.status,
            chapterTitle: patch.chapterTitle,
            chapterIndex: patch.chapterIndex ?? chunk.chapterIndex,
            duration: patch.duration,
            cues: patch.cues,
            error: undefined,
          }
        : chunk
    )),
  }
}

export function migrateQueueJob(raw: unknown): QueueJob {
  const job = raw as Partial<QueueJob> & { engine?: string; schemaVersion?: number }
  const engine: QueueEngine = job.engine === 'supertonic' || job.engine === 'kitten' ? job.engine : 'kokoro'
  return {
    schemaVersion: 2,
    id: String(job.id ?? crypto.randomUUID()),
    title: String(job.title ?? 'Untitled job'),
    createdAt: typeof job.createdAt === 'number' ? job.createdAt : Date.now(),
    engine,
    voice: job.voice ?? 'af_heart',
    language: engine === 'kokoro' ? job.language : undefined,
    speed: typeof job.speed === 'number' ? job.speed : 1,
    format: job.format ?? 'wav',
    bitrate: typeof job.bitrate === 'number' ? job.bitrate : 128,
    supertonicSteps: engine === 'supertonic' ? job.supertonicSteps : undefined,
    kittenModel: engine === 'kitten' ? job.kittenModel ?? 'nano' : undefined,
    chunks: Array.isArray(job.chunks) ? job.chunks.map((chunk, index) => migrateQueueChunk(chunk, index)) : [],
  }
}

function migrateQueueChunk(raw: unknown, index: number): QueueChunk {
  const chunk = raw as Partial<QueueChunk>
  // 'generating' is an in-memory state only: a persisted 'generating' chunk is
  // a zombie from a crashed session, so demote it to 'pending' for clean resume.
  const status = chunk.status === 'done' || chunk.status === 'failed' ? chunk.status : 'pending'
  return {
    index: typeof chunk.index === 'number' ? chunk.index : index,
    text: String(chunk.text ?? ''),
    status,
    chapterTitle: chunk.chapterTitle,
    chapterIndex: chunk.chapterIndex,
    duration: typeof chunk.duration === 'string' ? chunk.duration : undefined,
    cues: Array.isArray(chunk.cues) ? chunk.cues.filter(isCue) : undefined,
    blobKey: chunk.blobKey,
    error: chunk.error,
    warning: typeof chunk.warning === 'string' ? chunk.warning : undefined,
  }
}

function isCue(value: unknown): value is Cue {
  const cue = value as Partial<Cue>
  const startSec = Number(cue.startSec)
  const endSec = Number(cue.endSec)
  return (
    typeof cue.index === 'number'
    && Number.isFinite(startSec)
    && Number.isFinite(endSec)
    && endSec > startSec
    && typeof cue.text === 'string'
  )
}
