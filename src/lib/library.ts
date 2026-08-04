import type { Cue } from './subtitles.ts'
import { publishStoreChange } from './coordination.ts'
import type { RvcClipProvenance } from './rvc.ts'
import type { VoiceProvenance } from './voice-lab.ts'

export type ClipRecord = {
  id: string
  filename: string
  label: string
  voice: string
  speed: number
  createdAt: number
  size: number
  duration: string
  cues?: Cue[]
  rvc?: RvcClipProvenance
  provenance?: VoiceProvenance
}

export type ClipSnapshot = {
  record: ClipRecord
  blob: Blob | null
}

const DB_NAME = 'bettertts-library'
const DB_VERSION = 1
const CLIPS_STORE = 'clips'
const BLOBS_STORE = 'blobs'

let dbPromise: Promise<IDBDatabase> | null = null

export function migrateClipRecord(raw: unknown): ClipRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Partial<ClipRecord>
  if (
    typeof record.id !== 'string'
    || !record.id
    || record.id.length > 200
    || typeof record.filename !== 'string'
    || !record.filename
    || record.filename.length > 300
    || typeof record.label !== 'string'
    || record.label.length > 500
    || typeof record.voice !== 'string'
    || record.voice.length > 200
    || !Number.isFinite(record.createdAt)
    || !Number.isFinite(record.speed)
    || !Number.isSafeInteger(record.size)
    || Number(record.size) < 0
    || typeof record.duration !== 'string'
    || record.duration.length > 50
  ) return null
  const cues = Array.isArray(record.cues)
    ? record.cues.filter((value): value is Cue => {
        const cue = value as Partial<Cue>
        return (
          Number.isSafeInteger(cue.index)
          && Number(cue.index) > 0
          && Number.isFinite(cue.startSec)
          && Number(cue.startSec) >= 0
          && Number.isFinite(cue.endSec)
          && Number(cue.endSec) > Number(cue.startSec)
          && typeof cue.text === 'string'
        )
      })
    : undefined
  const rvc = migrateRvcProvenance(record.rvc)
  return {
    id: record.id,
    filename: record.filename,
    label: record.label,
    voice: record.voice,
    speed: Math.max(0.5, Math.min(2, Number(record.speed))),
    createdAt: Number(record.createdAt),
    size: Number(record.size),
    duration: record.duration,
    cues,
    ...(rvc ? { rvc } : {}),
    provenance: record.provenance,
  }
}

function migrateRvcProvenance(value: unknown): RvcClipProvenance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<RvcClipProvenance>
  if (candidate.stage !== 'rvc' || !Number.isFinite(candidate.pitchSemitones) || !Number.isFinite(candidate.indexRate)) return null
  if (!Array.isArray(candidate.models) || candidate.models.length < 1 || candidate.models.length > 2) return null
  const models = candidate.models.flatMap((model) => {
    if (!model || typeof model !== 'object') return []
    const item = model as Partial<RvcClipProvenance['models'][number]>
    if (
      typeof item.id !== 'string' || !item.id || item.id.length > 120
      || typeof item.name !== 'string' || !item.name || item.name.length > 120
      || typeof item.license !== 'string' || !item.license || item.license.length > 200
      || typeof item.provenance !== 'string' || !item.provenance || item.provenance.length > 600
    ) return []
    return [{ id: item.id, name: item.name, license: item.license, provenance: item.provenance }]
  })
  if (models.length !== candidate.models.length || typeof candidate.appliedAt !== 'string' || !Number.isFinite(Date.parse(candidate.appliedAt))) return null
  if (candidate.blendRatio !== undefined && (!Number.isFinite(candidate.blendRatio) || candidate.blendRatio < 0 || candidate.blendRatio > 1)) return null
  return {
    stage: 'rvc',
    appliedAt: candidate.appliedAt,
    models,
    ...(candidate.blendRatio === undefined ? {} : { blendRatio: candidate.blendRatio }),
    pitchSemitones: Math.max(-24, Math.min(24, Number(candidate.pitchSemitones))),
    indexRate: Math.max(0, Math.min(1, Number(candidate.indexRate))),
  }
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(CLIPS_STORE)) db.createObjectStore(CLIPS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(BLOBS_STORE)) db.createObjectStore(BLOBS_STORE)
    }
    let settled = false
    req.onblocked = () => {
      settled = true
      dbPromise = null
      reject(new Error('Clip library is blocked by another open tab.'))
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
      // If another tab upgrades the schema, release this connection so the
      // upgrade is never blocked by a zombie handle.
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

export async function saveClip(record: ClipRecord, blob: Blob): Promise<void> {
  const db = await openDB()
  const tx = db.transaction([CLIPS_STORE, BLOBS_STORE], 'readwrite')
  tx.objectStore(CLIPS_STORE).put(record)
  tx.objectStore(BLOBS_STORE).put(blob, record.id)
  await txDone(tx)
  publishStoreChange('library', 'write', record.id)
}

export async function listClips(): Promise<ClipRecord[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CLIPS_STORE, 'readonly')
    const req = tx.objectStore(CLIPS_STORE).getAll()
    req.onsuccess = () => {
      const records = (req.result as unknown[])
        .map(migrateClipRecord)
        .filter((record): record is ClipRecord => record !== null)
      records.sort((a, b) => b.createdAt - a.createdAt)
      resolve(records)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function getClipBlob(id: string): Promise<Blob | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOBS_STORE, 'readonly')
    const req = tx.objectStore(BLOBS_STORE).get(id)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  })
}

export async function deleteClip(id: string): Promise<void> {
  const db = await openDB()
  const tx = db.transaction([CLIPS_STORE, BLOBS_STORE], 'readwrite')
  tx.objectStore(CLIPS_STORE).delete(id)
  tx.objectStore(BLOBS_STORE).delete(id)
  await txDone(tx)
  publishStoreChange('library', 'delete', id)
}

export async function deleteClipWithSnapshot(id: string): Promise<ClipSnapshot | null> {
  const db = await openDB()
  const tx = db.transaction([CLIPS_STORE, BLOBS_STORE], 'readwrite')
  const done = txDone(tx)
  const clips = tx.objectStore(CLIPS_STORE)
  const blobs = tx.objectStore(BLOBS_STORE)
  const [record, blob] = await Promise.all([
    requestValue(clips.get(id)) as Promise<ClipRecord | undefined>,
    requestValue(blobs.get(id)) as Promise<Blob | undefined>,
  ])
  if (record) {
    clips.delete(id)
    blobs.delete(id)
  }
  await done
  if (record) publishStoreChange('library', 'delete', id)
  return record ? { record, blob: blob ?? null } : null
}

export async function clearLibrary(): Promise<void> {
  const db = await openDB()
  const tx = db.transaction([CLIPS_STORE, BLOBS_STORE], 'readwrite')
  tx.objectStore(CLIPS_STORE).clear()
  tx.objectStore(BLOBS_STORE).clear()
  await txDone(tx)
  publishStoreChange('library', 'clear')
}

export async function clearLibraryWithSnapshot(): Promise<ClipSnapshot[]> {
  const db = await openDB()
  const tx = db.transaction([CLIPS_STORE, BLOBS_STORE], 'readwrite')
  const done = txDone(tx)
  const clips = tx.objectStore(CLIPS_STORE)
  const blobs = tx.objectStore(BLOBS_STORE)
  const [records, blobKeys, blobValues] = await Promise.all([
    requestValue(clips.getAll()) as Promise<ClipRecord[]>,
    requestValue(blobs.getAllKeys()),
    requestValue(blobs.getAll()) as Promise<Blob[]>,
  ])
  clips.clear()
  blobs.clear()
  await done
  publishStoreChange('library', 'clear')

  const recordsById = new Map(records.map((record) => [record.id, record]))
  return blobKeys.flatMap((key, index) => {
    const record = recordsById.get(String(key))
    const blob = blobValues[index]
    return record && blob ? [{ record, blob }] : []
  })
}

export async function restoreClipSnapshots(snapshots: ClipSnapshot[]): Promise<void> {
  if (snapshots.length === 0) return
  const db = await openDB()
  const tx = db.transaction([CLIPS_STORE, BLOBS_STORE], 'readwrite')
  const clips = tx.objectStore(CLIPS_STORE)
  const blobs = tx.objectStore(BLOBS_STORE)
  for (const snapshot of snapshots) {
    clips.put(snapshot.record)
    if (snapshot.blob) blobs.put(snapshot.blob, snapshot.record.id)
  }
  await txDone(tx)
  publishStoreChange('library', 'restore')
}

export const LIBRARY_MAX_BYTES = 200 * 1024 * 1024

// Evict oldest clips until at least targetBytes have been freed (or nothing is
// left to evict). Returns what was actually evicted so the caller can decide
// whether retrying a failed save is worthwhile.
export async function freeLibrarySpace(targetBytes: number): Promise<{ evicted: number; freedBytes: number }> {
  const clips = await listClips()
  let freedBytes = 0
  let evicted = 0
  for (let i = clips.length - 1; i >= 0 && freedBytes < targetBytes; i--) {
    await deleteClip(clips[i].id)
    freedBytes += clips[i].size
    evicted++
  }
  return { evicted, freedBytes }
}

// Evict oldest clips once the library exceeds the byte cap, so auto-saving
// every generation can never silently fill the origin's storage quota.
export async function enforceLibraryCap(maxBytes = LIBRARY_MAX_BYTES): Promise<number> {
  const clips = await listClips()
  let total = 0
  const evict: string[] = []
  for (const clip of clips) {
    total += clip.size
    if (total > maxBytes) evict.push(clip.id)
  }
  for (const id of evict) {
    await deleteClip(id)
  }
  return evict.length
}
