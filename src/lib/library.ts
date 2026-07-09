import type { Cue } from './subtitles.ts'

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
}

export async function listClips(): Promise<ClipRecord[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CLIPS_STORE, 'readonly')
    const req = tx.objectStore(CLIPS_STORE).getAll()
    req.onsuccess = () => {
      const records = req.result as ClipRecord[]
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
  return record ? { record, blob: blob ?? null } : null
}

export async function clearLibrary(): Promise<void> {
  const db = await openDB()
  const tx = db.transaction([CLIPS_STORE, BLOBS_STORE], 'readwrite')
  tx.objectStore(CLIPS_STORE).clear()
  tx.objectStore(BLOBS_STORE).clear()
  await txDone(tx)
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
