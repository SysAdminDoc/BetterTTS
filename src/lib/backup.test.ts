import 'fake-indexeddb/auto'
import { unzipSync, zipSync } from 'fflate'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPortableBackup, inspectPortableBackup, restorePortableBackup } from './backup.ts'
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
    storedSettings.set(key, value)
  },
}
let availableQuota = 1024 * 1024 * 1024

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
    await clearLibrary()
    for (const queued of await listJobs()) await deleteJob(queued.id)
    window.localStorage.clear()
    availableQuota = 1024 * 1024 * 1024
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
    window.localStorage.setItem('bettertts-current-text', 'Draft project text')

    const backup = await createPortableBackup()
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

  it('rolls back local data when applying a validated archive fails', async () => {
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

    await expect(restorePortableBackup(invalidRecord)).rejects.toThrow('invalid clip record')
    expect(await listClips()).toEqual([])
    expect((await listJobs()).map((entry) => entry.id)).toEqual([job.id])
    expect(window.localStorage.getItem('bettertts-theme')).toBe('dark')
  })
})
