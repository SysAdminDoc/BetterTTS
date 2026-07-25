import { zip, unzip } from 'fflate'
import { clearLibrary, getClipBlob, listClips, restoreClipSnapshots, saveClip, type ClipRecord, type ClipSnapshot } from './library.ts'
import { deleteJob, getChunkBlob, listJobs, migrateQueueJob, restoreQueueJob, saveChunkBlob, saveJob, type QueueJob, type QueueJobSnapshot } from './queue.ts'

const BACKUP_SCHEMA_VERSION = 1
const MAX_BACKUP_BYTES = 512 * 1024 * 1024
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024
const SETTINGS_KEYS = [
  'bettertts-theme',
  'bettertts-pronunciations',
  'bettertts-cleanup',
  'bettertts-backend',
  'bettertts-playback-v1',
  'bettertts-experimental-piper',
  'bettertts-current-text',
] as const

type BackupAsset = {
  path: string
  size: number
  sha256: string
  type: string
}

type BackupManifest = {
  schemaVersion: 1
  createdAt: string
  clips: ClipRecord[]
  jobs: QueueJob[]
  settings: Record<string, string>
  assets: BackupAsset[]
}

export type BackupPreview = {
  clips: number
  jobs: number
  audioBytes: number
  settings: number
  createdAt: string
}

type PreparedBackup = {
  manifest: BackupManifest
  files: Record<string, Uint8Array>
  preview: BackupPreview
}

function archive(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 0 }, (error, data) => error ? reject(error) : resolve(data))
  })
}

function unarchive(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, {
      filter: (entry) => entry.originalSize <= MAX_BACKUP_BYTES,
    }, (error, files) => error ? reject(error) : resolve(files))
  })
}

async function sha256(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bytesToBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

function safePath(path: string): boolean {
  return !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..')
}

function collectSettings(): Record<string, string> {
  const settings: Record<string, string> = {}
  for (const key of SETTINGS_KEYS) {
    const value = window.localStorage.getItem(key)
    if (value !== null) settings[key] = value
  }
  return settings
}

function restoreSettings(settings: Record<string, string>) {
  for (const key of SETTINGS_KEYS) {
    const value = settings[key]
    if (typeof value === 'string') window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  }
}

async function addAsset(
  files: Record<string, Uint8Array>,
  assets: BackupAsset[],
  path: string,
  blob: Blob,
) {
  const bytes = new Uint8Array(await readBlob(blob))
  files[path] = bytes
  assets.push({ path, size: bytes.byteLength, sha256: await sha256(bytes), type: blob.type })
}

export async function createPortableBackup(): Promise<{ blob: Blob; preview: BackupPreview }> {
  const files: Record<string, Uint8Array> = {}
  const assets: BackupAsset[] = []
  const clips: ClipRecord[] = []

  for (const record of await listClips()) {
    const blob = await getClipBlob(record.id)
    if (!blob) continue
    clips.push(record)
    await addAsset(files, assets, `library/${encodeURIComponent(record.id)}.bin`, blob)
  }

  const jobs = await listJobs()
  for (const job of jobs) {
    for (const chunk of job.chunks) {
      const blob = await getChunkBlob(job.id, chunk.index)
      if (blob) await addAsset(files, assets, `queue/${encodeURIComponent(job.id)}/${chunk.index}.bin`, blob)
    }
  }

  const manifest: BackupManifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    clips,
    jobs,
    settings: collectSettings(),
    assets,
  }
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))
  const packed = await archive(files)
  return {
    blob: new Blob([bytesToBuffer(packed)], { type: 'application/vnd.bettertts.backup+zip' }),
    preview: previewFor(manifest),
  }
}

function previewFor(manifest: BackupManifest): BackupPreview {
  return {
    clips: manifest.clips.length,
    jobs: manifest.jobs.length,
    audioBytes: manifest.assets.reduce((total, asset) => total + asset.size, 0),
    settings: Object.keys(manifest.settings).length,
    createdAt: manifest.createdAt,
  }
}

async function prepareBackup(file: Blob): Promise<PreparedBackup> {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup is larger than 512 MB.')
  const files = await unarchive(new Uint8Array(await readBlob(file)))
  const manifestBytes = files['manifest.json']
  if (!manifestBytes || manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error('Backup manifest is missing or too large.')
  }

  let manifest: BackupManifest
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BackupManifest
  } catch {
    throw new Error('Backup manifest is not valid JSON.')
  }
  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION || !Array.isArray(manifest.clips) || !Array.isArray(manifest.jobs) || !Array.isArray(manifest.assets) || !manifest.settings) {
    throw new Error('Backup schema is unsupported or incomplete.')
  }

  const paths = new Set<string>()
  for (const asset of manifest.assets) {
    if (!safePath(asset.path) || paths.has(asset.path)) throw new Error('Backup contains an invalid or duplicate asset path.')
    paths.add(asset.path)
    const bytes = files[asset.path]
    if (!bytes || bytes.byteLength !== asset.size || await sha256(bytes) !== asset.sha256) {
      throw new Error(`Backup asset failed validation: ${asset.path}`)
    }
  }

  const preview = previewFor(manifest)
  const estimate = await navigator.storage?.estimate?.()
  if (estimate?.quota && preview.audioBytes > estimate.quota * 0.9) {
    throw new Error('Backup audio exceeds 90% of this browser storage quota.')
  }
  return { manifest, files, preview }
}

export async function inspectPortableBackup(file: Blob): Promise<BackupPreview> {
  return (await prepareBackup(file)).preview
}

async function snapshotCurrentState(): Promise<{
  clips: ClipSnapshot[]
  jobs: QueueJobSnapshot[]
  settings: Record<string, string>
}> {
  const clips = await Promise.all((await listClips()).map(async (record) => ({
    record,
    blob: await getClipBlob(record.id),
  })))
  const jobs = await Promise.all((await listJobs()).map(async (job) => ({
    job,
    blobs: (await Promise.all(job.chunks.map(async (chunk) => {
      const blob = await getChunkBlob(job.id, chunk.index)
      return blob ? { chunkIndex: chunk.index, blob } : null
    }))).filter((entry): entry is { chunkIndex: number; blob: Blob } => entry !== null),
  })))
  return { clips, jobs, settings: collectSettings() }
}

async function clearQueue() {
  for (const job of await listJobs()) await deleteJob(job.id)
}

async function applyPreparedBackup(prepared: PreparedBackup) {
  await clearLibrary()
  await clearQueue()
  restoreSettings(prepared.manifest.settings)

  for (const record of prepared.manifest.clips) {
    if (!record?.id || !record.filename || !Number.isFinite(record.createdAt) || !Number.isFinite(record.size)) {
      throw new Error('Backup contains an invalid clip record.')
    }
    const path = `library/${encodeURIComponent(record.id)}.bin`
    const asset = prepared.manifest.assets.find((entry) => entry.path === path)
    const bytes = prepared.files[path]
    if (!asset || !bytes) throw new Error(`Backup audio is missing for ${record.label || record.id}.`)
    await saveClip(record, new Blob([bytesToBuffer(bytes)], { type: asset.type }))
  }

  for (const rawJob of prepared.manifest.jobs) {
    const job = migrateQueueJob(rawJob)
    for (const chunk of job.chunks) {
      const path = `queue/${encodeURIComponent(job.id)}/${chunk.index}.bin`
      const asset = prepared.manifest.assets.find((entry) => entry.path === path)
      const bytes = prepared.files[path]
      if (asset && bytes) {
        await saveChunkBlob(job.id, chunk.index, new Blob([bytesToBuffer(bytes)], { type: asset.type }))
      } else if (chunk.status === 'done') {
        chunk.status = 'pending'
        chunk.duration = undefined
        chunk.cues = undefined
        chunk.warning = 'Restored without audio; regenerate this segment.'
      }
    }
    await saveJob(job)
  }
}

export async function restorePortableBackup(file: Blob): Promise<BackupPreview> {
  const prepared = await prepareBackup(file)
  const previous = await snapshotCurrentState()
  try {
    await applyPreparedBackup(prepared)
  } catch (error) {
    try {
      await clearLibrary()
      await clearQueue()
      restoreSettings(previous.settings)
      await restoreClipSnapshots(previous.clips)
      for (const job of previous.jobs) await restoreQueueJob(job)
    } catch {
      throw new Error('Backup restore failed and the previous local state could not be fully restored.')
    }
    throw error
  }
  return prepared.preview
}
