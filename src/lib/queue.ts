import type { AudioFormat } from './encode.ts'
import { publishStoreChange } from './coordination.ts'
import { ensurePortableBackupRecovery } from './restore-recovery.ts'
import type { Cue } from './subtitles.ts'
import type { NarratorRole } from './text.ts'
import type { KokoroLocale, VoiceId } from './voices.ts'
import type { PiperPlusLanguage } from './piper-plus.ts'
import { migrateGenerationProvenance, type GenerationProvenanceManifest } from './provenance-migration.ts'

export type ChunkStatus = 'pending' | 'generating' | 'done' | 'failed'
export type QueueEngine = 'kokoro' | 'supertonic' | 'kitten' | 'piper' | 'melo'
export type QueueVoiceMixEntry = {
  voiceId: string
  weight: number
}

export type QueueChunk = {
  index: number
  text: string
  status: ChunkStatus
  voice?: string
  role?: NarratorRole
  speaker?: string
  chapterTitle?: string
  chapterIndex?: number
  voiceMix?: QueueVoiceMixEntry[]
  duration?: string
  cues?: Cue[]
  blobKey?: string
  error?: string
  /** Non-fatal completeness or quality-check note. */
  warning?: string
}

export type QueueJob = {
  schemaVersion: 2
  id: string
  title: string
  sourceDocumentId?: string
  sourceKind?: 'epub'
  createdAt: number
  engine: QueueEngine
  voice: VoiceId | string
  language?: KokoroLocale | PiperPlusLanguage
  speed: number
  format: AudioFormat
  bitrate: number
  narratorMode?: boolean
  supertonicSteps?: number
  kittenModel?: 'nano' | 'micro' | 'mini'
  generationProvenance?: GenerationProvenanceManifest
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
  publishStoreChange('queue', 'write', job.id)
}

export async function listJobs(): Promise<QueueJob[]> {
  await ensurePortableBackupRecovery()
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
  publishStoreChange('queue', 'delete', id)
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
  if (rawJob) publishStoreChange('queue', 'delete', id)

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
  const done = txDone(tx)
  try {
    tx.objectStore(JOBS_STORE).put(migrateQueueJob(snapshot.job))
    const chunks = tx.objectStore(CHUNKS_STORE)
    for (const entry of snapshot.blobs) {
      chunks.put(entry.blob, `${snapshot.job.id}:${entry.chunkIndex}`)
    }
  } catch (error) {
    tx.abort()
    await done.catch(() => {})
    throw error
  }
  await done
  publishStoreChange('queue', 'restore', snapshot.job.id)
}

export async function saveChunkBlob(jobId: string, chunkIndex: number, blob: Blob): Promise<void> {
  const db = await openDB()
  const tx = db.transaction(CHUNKS_STORE, 'readwrite')
  tx.objectStore(CHUNKS_STORE).put(blob, `${jobId}:${chunkIndex}`)
  await txDone(tx)
}

export async function commitQueueChunk(job: QueueJob, chunkIndex: number, blob: Blob): Promise<void> {
  const chunk = job.chunks.find((entry) => entry.index === chunkIndex)
  if (!chunk || chunk.status !== 'done') {
    throw new Error('Queue audio can only be committed with a completed chunk record.')
  }
  const db = await openDB()
  const tx = db.transaction([JOBS_STORE, CHUNKS_STORE], 'readwrite')
  tx.objectStore(CHUNKS_STORE).put(blob, `${job.id}:${chunkIndex}`)
  tx.objectStore(JOBS_STORE).put(migrateQueueJob(job))
  await txDone(tx)
  publishStoreChange('queue', 'write', job.id)
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
  patch: Pick<QueueChunk, 'text' | 'status'> & Partial<Pick<QueueChunk, 'voice' | 'role' | 'speaker' | 'chapterTitle' | 'chapterIndex' | 'duration' | 'cues' | 'warning'>>,
): QueueJob {
  return {
    ...job,
    chunks: job.chunks.map((chunk) => (
      chunk.index === chunkIndex
        ? {
            ...chunk,
            text: patch.text,
            status: patch.status,
            voice: patch.voice ?? chunk.voice,
            role: patch.role ?? chunk.role,
            speaker: patch.speaker ?? chunk.speaker,
            chapterTitle: patch.chapterTitle,
            chapterIndex: patch.chapterIndex ?? chunk.chapterIndex,
            duration: patch.duration,
            cues: patch.cues,
            warning: 'warning' in patch ? patch.warning : chunk.warning,
            error: undefined,
          }
        : chunk
    )),
  }
}

export function migrateQueueJob(raw: unknown): QueueJob {
  const job = raw && typeof raw === 'object'
    ? raw as Partial<QueueJob> & { engine?: string; schemaVersion?: number }
    : {}
  const engine: QueueEngine = job.engine === 'supertonic' || job.engine === 'kitten' || job.engine === 'piper' || job.engine === 'melo' ? job.engine : 'kokoro'
  const speedBounds = engine === 'supertonic' ? [0.8, 1.2] : engine === 'kitten' ? [0.5, 2] : [0.5, 1.5]
  const requestedSpeed = Number(job.speed)
  const speed = Number.isFinite(requestedSpeed)
    ? Math.max(speedBounds[0], Math.min(speedBounds[1], requestedSpeed))
    : 1
  const format: AudioFormat = job.format === 'mp3' || job.format === 'opus' || job.format === 'flac' || job.format === 'm4b'
    ? job.format
    : 'wav'
  const requestedBitrate = Number(job.bitrate)
  const bitrate = Number.isFinite(requestedBitrate)
    ? Math.round(Math.max(32, Math.min(320, requestedBitrate)))
    : 128
  const id = typeof job.id === 'string' && job.id && job.id.length <= 200 ? job.id : crypto.randomUUID()
  const title = typeof job.title === 'string' && job.title ? job.title.slice(0, 500) : 'Untitled job'
  const voice = typeof job.voice === 'string' && job.voice && job.voice.length <= 200 ? job.voice : 'af_heart'
  const language = typeof job.language === 'string' && job.language.length <= 50 ? job.language : undefined
  const narratorMode = job.narratorMode === true
  const chunks = Array.isArray(job.chunks) ? job.chunks.map((chunk, index) => migrateQueueChunk(chunk, index)) : []
  const generationProvenance = migrateGenerationProvenance(job.generationProvenance)
  return {
    schemaVersion: 2,
    id,
    title,
    ...(typeof job.sourceDocumentId === 'string' && job.sourceDocumentId.trim() && job.sourceDocumentId.length <= 200
      ? { sourceDocumentId: job.sourceDocumentId.trim() }
      : {}),
    ...(job.sourceKind === 'epub' ? { sourceKind: 'epub' as const } : {}),
    createdAt: Number.isFinite(job.createdAt) && Number(job.createdAt) >= 0 ? Number(job.createdAt) : Date.now(),
    engine,
    voice,
    language: engine === 'kokoro' || engine === 'piper' ? language : undefined,
    speed,
    format,
    bitrate,
    narratorMode,
    supertonicSteps: engine === 'supertonic' && Number.isFinite(job.supertonicSteps)
      ? Math.round(Math.max(1, Math.min(10, Number(job.supertonicSteps))))
      : engine === 'supertonic' ? 5 : undefined,
    kittenModel: engine === 'kitten' && (job.kittenModel === 'micro' || job.kittenModel === 'mini')
      ? job.kittenModel
      : engine === 'kitten' ? 'nano' : undefined,
    ...(generationProvenance ? { generationProvenance } : {}),
    chunks,
  }
}

function migrateQueueChunk(raw: unknown, index: number): QueueChunk {
  const chunk = raw && typeof raw === 'object' ? raw as Partial<QueueChunk> : {}
  // 'generating' is an in-memory state only: a persisted 'generating' chunk is
  // a zombie from a crashed session, so demote it to 'pending' for clean resume.
  const status = chunk.status === 'done' || chunk.status === 'failed' ? chunk.status : 'pending'
  const voice = typeof chunk.voice === 'string' && chunk.voice.trim() && chunk.voice.length <= 200 ? chunk.voice.trim() : undefined
  const role: NarratorRole | undefined = chunk.role === 'narration' || chunk.role === 'dialogue' ? chunk.role : undefined
  const speaker = typeof chunk.speaker === 'string' && chunk.speaker.trim() && chunk.speaker.length <= 120 ? chunk.speaker.trim() : undefined
  const voiceMix = migrateQueueVoiceMix(chunk.voiceMix)
  return {
    index: Number.isSafeInteger(chunk.index) && Number(chunk.index) >= 0 ? Number(chunk.index) : index,
    text: typeof chunk.text === 'string' ? chunk.text.slice(0, 10_000) : '',
    status,
    ...(voice ? { voice } : {}),
    ...(role ? { role } : {}),
    ...(speaker ? { speaker } : {}),
    chapterTitle: typeof chunk.chapterTitle === 'string' ? chunk.chapterTitle.slice(0, 500) : undefined,
    chapterIndex: Number.isSafeInteger(chunk.chapterIndex) && Number(chunk.chapterIndex) >= 0 ? Number(chunk.chapterIndex) : undefined,
    ...(voiceMix ? { voiceMix } : {}),
    duration: typeof chunk.duration === 'string' ? chunk.duration.slice(0, 50) : undefined,
    cues: Array.isArray(chunk.cues) ? chunk.cues.filter(isCue) : undefined,
    blobKey: typeof chunk.blobKey === 'string' ? chunk.blobKey.slice(0, 500) : undefined,
    error: typeof chunk.error === 'string' ? chunk.error.slice(0, 1000) : undefined,
    warning: typeof chunk.warning === 'string' ? chunk.warning.slice(0, 1000) : undefined,
  }
}

function migrateQueueVoiceMix(raw: unknown): QueueVoiceMixEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const entries: QueueVoiceMixEntry[] = []
  for (const value of raw.slice(0, 4)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Partial<QueueVoiceMixEntry>
    const voiceId = typeof entry.voiceId === 'string' ? entry.voiceId.trim() : ''
    const weight = Number(entry.weight)
    if (!/^[a-z][a-z0-9_-]{0,63}$/iu.test(voiceId) || !Number.isFinite(weight) || weight <= 0) continue
    entries.push({ voiceId, weight: Math.min(100, weight) })
  }
  return entries.length >= 2 ? entries : undefined
}

function isCue(value: unknown): value is Cue {
  const cue = value as Partial<Cue>
  const startSec = Number(cue.startSec)
  const endSec = Number(cue.endSec)
  return (
    Number.isSafeInteger(cue.index)
    && Number(cue.index) > 0
    && Number.isFinite(startSec)
    && startSec >= 0
    && Number.isFinite(endSec)
    && endSec > startSec
    && typeof cue.text === 'string'
  )
}
