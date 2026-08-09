import 'fake-indexeddb/auto'
import { unzipSync, zipSync } from 'fflate'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createPortableBackup,
  inspectPortableBackup,
  migrateRestoreJournal,
  recoverPortableBackupRestore,
  restorePortableBackup,
  RESTORE_JOURNAL_DB_NAME,
} from './backup.ts'
import { clearLibrary, getClipBlob, listClips, saveClip } from './library.ts'
import { deleteJob, getChunkBlob, listJobs, saveChunkBlob, saveJob, type QueueJob } from './queue.ts'

const storedSettings = new Map<string, string>()
const localStorageStub: Storage = {
  get length() {
    return storedSettings.size
  },
  clear() {
    storedSettings.clear()
  },
  getItem(key) {
    return storedSettings.get(key) ?? null
  },
  key(index) {
    return [...storedSettings.keys()][index] ?? null
  },
  removeItem(key) {
    storedSettings.delete(key)
  },
  setItem(key, value) {
    if (rejectLightTheme && key === 'bettertts-theme' && value === 'light') throw new DOMException('Quota exceeded', 'QuotaExceededError')
    storedSettings.set(key, value)
  },
}
let availableQuota = 1024 * 1024 * 1024
let rejectLightTheme = false

const job: QueueJob = {
  schemaVersion: 2,
  id: 'backup-job',
  title: 'Backup job',
  createdAt: 2,
  engine: 'kokoro',
  voice: 'af_heart',
  speed: 1,
  format: 'wav',
  bitrate: 128,
  chunks: [{ index: 0, text: 'Private queued text.', status: 'done' }],
}

function asBlob(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Blob([copy.buffer], { type: 'application/vnd.bettertts.backup+zip' })
}

async function rewriteBackup(
  blob: Blob,
  edit: (files: Record<string, Uint8Array>) => void,
): Promise<Blob> {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  edit(files)
  return asBlob(zipSync(files, { level: 0 }))
}

describe('portable backup', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: localStorageStub },
    })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        storage: {
          estimate: async () => ({ quota: availableQuota, usage: 0 }),
        },
      },
    })
  })

  beforeEach(async () => {
    await recoverPortableBackupRestore()
    await clearLibrary()
    for (const queued of await listJobs()) await deleteJob(queued.id)
    window.localStorage.clear()
    availableQuota = 1024 * 1024 * 1024
    rejectLightTheme = false
  })

  it('round-trips clips, queue audio, and settings', async () => {
    await saveClip({
      id: 'clip',
      filename: 'clip.wav',
      label: 'Saved clip',
      voice: 'af_heart',
      speed: 1,
      createdAt: 1,
      size: 5,
      duration: '1.0s',
    }, new Blob(['clip-audio'], { type: 'audio/wav' }))
    await saveJob(job)
    await saveChunkBlob(job.id, 0, new Blob(['queue-audio'], { type: 'audio/wav' }))
    window.localStorage.setItem('bettertts-theme', 'light')
    window.localStorage.setItem('bettertts-current-text', 'Stale editor text')

    const backup = await createPortableBackup({
      settings: { 'bettertts-current-text': 'Draft project text' },
    })
    const backupManifest = JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(await backup.blob.arrayBuffer()))['manifest.json'])) as {
      clips: Array<{ generationProvenance?: { schemaVersion?: number } }>
    }
    expect(backupManifest.clips[0]?.generationProvenance?.schemaVersion).toBe(2)
    expect(backup.preview).toMatchObject({ clips: 1, jobs: 1, settings: 2 })
    await clearLibrary()
    await deleteJob(job.id)
    window.localStorage.clear()

    const preview = await inspectPortableBackup(backup.blob)
    expect(preview.clips).toBe(1)
    await restorePortableBackup(backup.blob)
    expect((await listClips()).map((clip) => clip.id)).toEqual(['clip'])
    expect(await (await getClipBlob('clip'))!.text()).toBe('clip-audio')
    expect((await listJobs())[0].chunks[0].text).toBe('Private queued text.')
    expect(await (await getChunkBlob(job.id, 0))!.text()).toBe('queue-audio')
    expect(window.localStorage.getItem('bettertts-theme')).toBe('light')
    expect(window.localStorage.getItem('bettertts-current-text')).toBe('Draft project text')
  })

  it('rejects files without a manifest before changing local state', async () => {
    await saveJob(job)
    await expect(restorePortableBackup(new Blob(['not a backup']))).rejects.toThrow()
    expect((await listJobs()).map((entry) => entry.id)).toEqual([job.id])
  })

  it('rejects corrupt audio before changing local state', async () => {
    await saveClip({
      id: 'clip',
      filename: 'clip.wav',
      label: 'Saved clip',
      voice: 'af_heart',
      speed: 1,
      createdAt: 1,
      size: 5,
      duration: '1.0s',
    }, new Blob(['clip-audio'], { type: 'audio/wav' }))
    const backup = await createPortableBackup()
    const corrupt = await rewriteBackup(backup.blob, (files) => {
      files['library/clip.bin'][0] ^= 0xff
    })
    await saveJob(job)

    await expect(restorePortableBackup(corrupt)).rejects.toThrow('failed validation')
    expect((await listClips()).map((clip) => clip.id)).toEqual(['clip'])
    expect((await listJobs()).map((entry) => entry.id)).toEqual([job.id])
  })

  it('rejects archive files not declared by the manifest', async () => {
    const backup = await createPortableBackup()
    const withHiddenPayload = await rewriteBackup(backup.blob, (files) => {
      files['media/undeclared.bin'] = new Uint8Array(1024)
    })

    await expect(inspectPortableBackup(withHiddenPayload)).rejects.toThrow('do not match the manifest')
  })

  it('preflights browser quota before replacing local state', async () => {
    await saveClip({
      id: 'clip',
      filename: 'clip.wav',
      label: 'Saved clip',
      voice: 'af_heart',
      speed: 1,
      createdAt: 1,
      size: 5,
      duration: '1.0s',
    }, new Blob(['clip-audio'], { type: 'audio/wav' }))
    const backup = await createPortableBackup()
    availableQuota = 1

    await expect(inspectPortableBackup(backup.blob)).rejects.toThrow('storage quota')
    expect((await listClips()).map((clip) => clip.id)).toEqual(['clip'])
  })

  it('rolls back the staged replacement when a commit-time quota failure occurs', async () => {
    await saveClip({
      id: 'incoming',
      filename: 'incoming.wav',
      label: 'Incoming clip',
      voice: 'af_heart',
      speed: 1,
      createdAt: 1,
      size: 5,
      duration: '1.0s',
    }, new Blob(['inbox'], { type: 'audio/wav' }))
    const backup = await createPortableBackup({ settings: { 'bettertts-theme': 'light' } })

    await clearLibrary()
    await saveClip({
      id: 'current',
      filename: 'current.wav',
      label: 'Current clip',
      voice: 'af_heart',
      speed: 1,
      createdAt: 2,
      size: 6,
      duration: '1.2s',
    }, new Blob(['active'], { type: 'audio/wav' }))
    window.localStorage.setItem('bettertts-theme', 'dark')
    rejectLightTheme = true

    await expect(restorePortableBackup(backup.blob)).rejects.toThrow(/Could not restore 1 local setting|previous local state/)
    expect((await listClips()).map((clip) => clip.id)).toEqual(['current'])
    expect(await (await getClipBlob('current'))!.text()).toBe('active')
    expect(window.localStorage.getItem('bettertts-theme')).toBe('dark')
  })

  it('migrates a version-zero journal and demotes zombie queue chunks', () => {
    const migrated = migrateRestoreJournal({
      schemaVersion: 0,
      phase: 'committing',
      prepared: {
        manifest: {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          clips: [],
          jobs: [{ ...job, chunks: [{ ...job.chunks[0], status: 'generating' }] }],
          settings: {},
          assets: [],
        },
        files: { 'manifest.json': new Uint8Array([123, 125]) },
      },
      previous: { clips: [], jobs: [], settings: {} },
    })
    expect(migrated?.schemaVersion).toBe(1)
    expect(migrated?.phase).toBe('committing')
    expect(migrated?.prepared.manifest.jobs[0].chunks[0].status).toBe('pending')
  })

  it('recovers a journal left in the committing phase after a simulated crash', async () => {
    await saveClip({
      id: 'previous',
      filename: 'previous.wav',
      label: 'Previous clip',
      voice: 'af_heart',
      speed: 1,
      createdAt: 1,
      size: 8,
      duration: '1.0s',
    }, new Blob(['previous'], { type: 'audio/wav' }))
    window.localStorage.setItem('bettertts-theme', 'dark')
    const backup = await createPortableBackup()
    const previous = {
      clips: await Promise.all((await listClips()).map(async (record) => ({ record, blob: await getClipBlob(record.id) }))),
      jobs: await Promise.all((await listJobs()).map(async (queued) => ({
        job: queued,
        blobs: (await Promise.all(queued.chunks.map(async (chunk) => {
          const blob = await getChunkBlob(queued.id, chunk.index)
          return blob ? { chunkIndex: chunk.index, blob } : null
        }))).filter((entry): entry is { chunkIndex: number; blob: Blob } => entry !== null),
      }))),
      settings: { 'bettertts-theme': 'dark' },
    }
    await clearLibrary()
    await saveClip({
      id: 'partial',
      filename: 'partial.wav',
      label: 'Partial clip',
      voice: 'af_heart',
      speed: 1,
      createdAt: 2,
      size: 7,
      duration: '1.0s',
    }, new Blob(['partial'], { type: 'audio/wav' }))

    const archiveFiles = unzipSync(new Uint8Array(await backup.blob.arrayBuffer()))
    const manifest = JSON.parse(new TextDecoder().decode(archiveFiles['manifest.json']))
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(RESTORE_JOURNAL_DB_NAME, 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('restore', 'readwrite')
    transaction.objectStore('restore').put({
      schemaVersion: 1,
      restoreId: 'crashed-restore',
      createdAt: new Date().toISOString(),
      phase: 'committing',
      prepared: { manifest, files: archiveFiles },
      previous,
    }, 'active')
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()

    await recoverPortableBackupRestore()
    expect((await listClips()).map((clip) => clip.id)).toEqual(['previous'])
    expect(await (await getClipBlob('previous'))!.text()).toBe('previous')
    await recoverPortableBackupRestore()
  })

  it('rejects invalid records before changing local data', async () => {
    await saveClip({
      id: 'source',
      filename: 'source.wav',
      label: 'Source clip',
      voice: 'af_heart',
      speed: 1,
      createdAt: 1,
      size: 5,
      duration: '1.0s',
    }, new Blob(['source-audio'], { type: 'audio/wav' }))
    const backup = await createPortableBackup()
    const invalidRecord = await rewriteBackup(backup.blob, (files) => {
      const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
        clips: Array<{ filename: string }>
      }
      manifest.clips[0].filename = ''
      files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))
    })
    await clearLibrary()
    await saveJob(job)
    window.localStorage.setItem('bettertts-theme', 'dark')

    await expect(restorePortableBackup(invalidRecord)).rejects.toThrow('invalid or duplicate clip record')
    expect(await listClips()).toEqual([])
    expect((await listJobs()).map((entry) => entry.id)).toEqual([job.id])
    expect(window.localStorage.getItem('bettertts-theme')).toBe('dark')
  })

  it('rejects duplicate queue chunk indexes before changing local data', async () => {
    await saveJob(job)
    const backup = await createPortableBackup()
    const duplicateChunk = await rewriteBackup(backup.blob, (files) => {
      const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
        jobs: Array<{ chunks: Array<Record<string, unknown>> }>
      }
      manifest.jobs[0].chunks.push({ ...manifest.jobs[0].chunks[0] })
      files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))
    })

    await expect(restorePortableBackup(duplicateChunk)).rejects.toThrow('duplicate chunk index')
    expect((await listJobs()).map((entry) => entry.id)).toEqual([job.id])
  })

  it('rejects clip metadata that disagrees with the archived audio size', async () => {
    await saveClip({
      id: 'clip',
      filename: 'clip.wav',
      label: 'Saved clip',
      voice: 'af_heart',
      speed: 1,
      createdAt: 1,
      size: 10,
      duration: '1.0s',
    }, new Blob(['clip-audio'], { type: 'audio/wav' }))
    const backup = await createPortableBackup()
    const mismatched = await rewriteBackup(backup.blob, (files) => {
      const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
        clips: Array<{ size: number }>
      }
      manifest.clips[0].size += 1
      files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))
    })

    await expect(inspectPortableBackup(mismatched)).rejects.toThrow('size does not match')
  })
})
