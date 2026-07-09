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

const DB_NAME = 'bettertts-queue'
const DB_VERSION = 2
const JOBS_STORE = 'jobs'
const CHUNKS_STORE = 'chunks'

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(JOBS_STORE)) db.createObjectStore(JOBS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) db.createObjectStore(CHUNKS_STORE)
    }
    req.onblocked = () => {
      dbPromise = null
      reject(new Error('Queue DB blocked'))
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => {
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
  // Chunk blobs are keyed as "{jobId}:{chunkIndex}"
  const cursorReq = tx.objectStore(CHUNKS_STORE).openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (cursor) {
      if (typeof cursor.key === 'string' && cursor.key.startsWith(`${id}:`)) cursor.delete()
      cursor.continue()
    }
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
  const status = chunk.status === 'generating' || chunk.status === 'done' || chunk.status === 'failed' ? chunk.status : 'pending'
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
