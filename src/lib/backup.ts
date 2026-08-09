import { zip } from 'fflate'
import { clearLibrary, getClipBlob, listClips, migrateClipRecord, restoreClipSnapshots, saveClip, type ClipRecord, type ClipSnapshot } from './library.ts'
import { deleteJob, getChunkBlob, listJobs, migrateQueueJob, restoreQueueJob, type QueueJob, type QueueJobSnapshot } from './queue.ts'
import {
  assertArchivePayloadSizes,
  extractInspectedZipEntries,
  inspectZipArchive,
  type ArchiveBudget,
} from './archive-budget.ts'
import { createLegacyProvenanceManifest } from './provenance.ts'

const BACKUP_SCHEMA_VERSION = 1
const MAX_BACKUP_BYTES = 512 * 1024 * 1024
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024
const MAX_BACKUP_ENTRIES = 20_000
const MAX_BACKUP_ASSET_BYTES = 256 * 1024 * 1024
const MAX_BACKUP_COMPRESSION_RATIO = 200
const BACKUP_ARCHIVE_BUDGET: ArchiveBudget = {
  maxArchiveBytes: MAX_BACKUP_BYTES,
  maxEntries: MAX_BACKUP_ENTRIES,
  maxEntryBytes: MAX_BACKUP_BYTES,
  maxTotalBytes: MAX_BACKUP_BYTES,
  maxCompressionRatio: MAX_BACKUP_COMPRESSION_RATIO,
}
const BACKUP_MANIFEST_BUDGET: ArchiveBudget = {
  ...BACKUP_ARCHIVE_BUDGET,
  maxEntries: 1,
  maxEntryBytes: MAX_MANIFEST_BYTES,
  maxTotalBytes: MAX_MANIFEST_BYTES,
}
const BACKUP_ASSET_BUDGET: ArchiveBudget = {
  ...BACKUP_ARCHIVE_BUDGET,
  maxEntries: MAX_BACKUP_ENTRIES - 1,
  maxEntryBytes: MAX_BACKUP_ASSET_BYTES,
}
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

export type BackupManifest = {
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

export const RESTORE_JOURNAL_SCHEMA_VERSION = 1
export const RESTORE_JOURNAL_DB_NAME = 'bettertts-backup-restore'

type RestoreJournalPhase = 'staged' | 'committing' | 'committed' | 'rollback'

export type RestoreJournal = {
  schemaVersion: 1
  restoreId: string
  createdAt: string
  phase: RestoreJournalPhase
  prepared: {
    manifest: BackupManifest
    files: Record<string, Uint8Array>
  }
  previous: {
    clips: ClipSnapshot[]
    jobs: QueueJobSnapshot[]
    settings: Record<string, string>
  }
}

const RESTORE_JOURNAL_STORE = 'restore'
const RESTORE_JOURNAL_KEY = 'active'
let restoreJournalDbPromise: Promise<IDBDatabase> | null = null

function archive(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 0 }, (error, data) => error ? reject(error) : resolve(data))
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function migrateJournalFiles(raw: unknown): Record<string, Uint8Array> | null {
  const source = asRecord(raw)
  if (!source) return null
  const files: Record<string, Uint8Array> = {}
  for (const [path, value] of Object.entries(source)) {
    if (value instanceof Uint8Array) files[path] = value
    else if (value instanceof ArrayBuffer) files[path] = new Uint8Array(value)
    else return null
  }
  return files
}

function migrateJournalSnapshots(raw: unknown): RestoreJournal['previous'] | null {
  const source = asRecord(raw)
  const sourceSettings = asRecord(source?.settings)
  if (!source || !Array.isArray(source.clips) || !Array.isArray(source.jobs) || !sourceSettings) return null
  const clips: ClipSnapshot[] = []
  for (const value of source.clips) {
    const snapshot = asRecord(value)
    const record = migrateClipRecord(snapshot?.record)
    const blob = snapshot?.blob
    if (!record || (blob !== null && !(typeof Blob !== 'undefined' && blob instanceof Blob))) return null
    clips.push({ record, blob: blob as Blob | null })
  }
  const jobs: QueueJobSnapshot[] = []
  for (const value of source.jobs) {
    const snapshot = asRecord(value)
    const job = migrateQueueJob(snapshot?.job)
    if (!snapshot || !Array.isArray(snapshot.blobs)) return null
    const blobs: QueueJobSnapshot['blobs'] = []
    for (const rawBlob of snapshot.blobs) {
      const entry = asRecord(rawBlob)
      const chunkIndex = Number(entry?.chunkIndex)
      if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !(typeof Blob !== 'undefined' && entry?.blob instanceof Blob)) return null
      blobs.push({ chunkIndex, blob: entry.blob as Blob })
    }
    jobs.push({ job, blobs })
  }
  const settings: Record<string, string> = {}
  for (const [key, value] of Object.entries(sourceSettings)) {
    if (typeof value !== 'string') return null
    settings[key] = value
  }
  return { clips, jobs, settings }
}

/** Migrate the restore journal independently from the backup manifest. */
export function migrateRestoreJournal(raw: unknown): RestoreJournal | null {
  const source = asRecord(raw)
  if (!source || (source.schemaVersion !== 0 && source.schemaVersion !== RESTORE_JOURNAL_SCHEMA_VERSION)) return null
  const preparedSource = asRecord(source.prepared) ?? source
  const manifestSource = asRecord(preparedSource.manifest)
  if (
    !manifestSource
    || manifestSource.schemaVersion !== BACKUP_SCHEMA_VERSION
    || typeof manifestSource.createdAt !== 'string'
    || !Array.isArray(manifestSource.clips)
    || !Array.isArray(manifestSource.jobs)
    || !Array.isArray(manifestSource.assets)
    || !asRecord(manifestSource.settings)
  ) return null
  const clips = manifestSource.clips.map(migrateClipRecord).filter((record): record is ClipRecord => record !== null)
  if (clips.length !== manifestSource.clips.length) return null
  const jobs = manifestSource.jobs.map(migrateQueueJob)
  const assets = manifestSource.assets.flatMap((value) => {
    const asset = asRecord(value)
    return asset
      && typeof asset.path === 'string'
      && Number.isSafeInteger(asset.size)
      && Number(asset.size) >= 0
      && typeof asset.sha256 === 'string'
      && typeof asset.type === 'string'
      ? [{ path: asset.path, size: Number(asset.size), sha256: asset.sha256, type: asset.type }]
      : []
  })
  if (assets.length !== manifestSource.assets.length) return null
  const manifestSettings = asRecord(manifestSource.settings)
  if (!manifestSettings) return null
  const settings: Record<string, string> = {}
  for (const [key, value] of Object.entries(manifestSettings)) {
    if (typeof value !== 'string') return null
    settings[key] = value
  }
  const files = migrateJournalFiles(preparedSource.files)
  const previous = migrateJournalSnapshots(source.previous)
  if (!files || !previous) return null
  const phase = source.phase === 'committing' || source.phase === 'committed' || source.phase === 'rollback'
    ? source.phase
    : 'staged'
  return {
    schemaVersion: RESTORE_JOURNAL_SCHEMA_VERSION,
    restoreId: typeof source.restoreId === 'string' && source.restoreId ? source.restoreId : 'legacy-restore',
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date(0).toISOString(),
    phase,
    prepared: {
      manifest: {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        createdAt: manifestSource.createdAt,
        clips,
        jobs,
        settings,
        assets,
      },
      files,
    },
    previous,
  }
}

function openRestoreJournalDb(): Promise<IDBDatabase> {
  if (restoreJournalDbPromise) return restoreJournalDbPromise
  restoreJournalDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(RESTORE_JOURNAL_DB_NAME, 1)
    let settled = false
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RESTORE_JOURNAL_STORE)) request.result.createObjectStore(RESTORE_JOURNAL_STORE)
    }
    request.onblocked = () => {
      settled = true
      restoreJournalDbPromise = null
      reject(new Error('Backup restore journal is blocked by another tab.'))
    }
    request.onsuccess = () => {
      const db = request.result
      if (settled) {
        db.close()
        return
      }
      settled = true
      db.onversionchange = () => {
        db.close()
        restoreJournalDbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => {
      settled = true
      restoreJournalDbPromise = null
      reject(request.error)
    }
  })
  return restoreJournalDbPromise
}

function journalTransactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new DOMException('Restore journal transaction aborted', 'AbortError'))
  })
}

async function readRestoreJournal(): Promise<RestoreJournal | null> {
  const db = await openRestoreJournalDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RESTORE_JOURNAL_STORE, 'readonly')
    const request = transaction.objectStore(RESTORE_JOURNAL_STORE).get(RESTORE_JOURNAL_KEY)
    request.onsuccess = () => {
      const journal = request.result === undefined ? null : migrateRestoreJournal(request.result)
      if (request.result !== undefined && !journal) reject(new Error('Backup restore journal schema is unsupported or corrupt.'))
      else resolve(journal)
    }
    request.onerror = () => reject(request.error)
  })
}

async function writeRestoreJournal(journal: RestoreJournal): Promise<void> {
  const db = await openRestoreJournalDb()
  const transaction = db.transaction(RESTORE_JOURNAL_STORE, 'readwrite')
  transaction.objectStore(RESTORE_JOURNAL_STORE).put(journal, RESTORE_JOURNAL_KEY)
  await journalTransactionDone(transaction)
}

async function clearRestoreJournal(): Promise<void> {
  const db = await openRestoreJournalDb()
  const transaction = db.transaction(RESTORE_JOURNAL_STORE, 'readwrite')
  transaction.objectStore(RESTORE_JOURNAL_STORE).delete(RESTORE_JOURNAL_KEY)
  await journalTransactionDone(transaction)
}

function safePath(path: string): boolean {
  return !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..')
}

function collectSettings(overrides: Record<string, string> = {}): Record<string, string> {
  const settings: Record<string, string> = {}
  for (const key of SETTINGS_KEYS) {
    let value: string | undefined = overrides[key]
    if (value === undefined) {
      try {
        value = window.localStorage.getItem(key) ?? undefined
      } catch {
        continue
      }
    }
    if (typeof value === 'string') settings[key] = value
  }
  return settings
}

function restoreSettings(settings: Record<string, string>) {
  const failures: string[] = []
  for (const key of SETTINGS_KEYS) {
    const value = settings[key]
    try {
      if (typeof value === 'string') window.localStorage.setItem(key, value)
      else window.localStorage.removeItem(key)
    } catch {
      failures.push(key)
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not restore ${failures.length} local setting${failures.length === 1 ? '' : 's'}; browser storage rejected the write.`)
  }
}

async function addAsset(
  files: Record<string, Uint8Array>,
  assets: BackupAsset[],
  path: string,
  blob: Blob,
  budget: { entries: number; bytes: number },
) {
  const nextEntries = budget.entries + 1
  const nextBytes = budget.bytes + blob.size
  if (
    nextEntries > BACKUP_ASSET_BUDGET.maxEntries
    || blob.size > BACKUP_ASSET_BUDGET.maxEntryBytes
    || !Number.isSafeInteger(nextBytes)
    || nextBytes > BACKUP_ASSET_BUDGET.maxTotalBytes
  ) {
    throw new Error('Portable backup audio exceeds the archive payload limits.')
  }
  budget.entries = nextEntries
  budget.bytes = nextBytes
  const bytes = new Uint8Array(await readBlob(blob))
  files[path] = bytes
  assets.push({ path, size: bytes.byteLength, sha256: await sha256(bytes), type: blob.type })
}

export async function createPortableBackup(
  options: { settings?: Record<string, string> } = {},
): Promise<{ blob: Blob; preview: BackupPreview }> {
  const files: Record<string, Uint8Array> = {}
  const assets: BackupAsset[] = []
  const clips: ClipRecord[] = []
  const assetBudget = { entries: 0, bytes: 0 }

  for (const record of await listClips()) {
    const blob = await getClipBlob(record.id)
    if (!blob) continue
    clips.push({
      ...record,
      size: blob.size,
      generationProvenance: record.generationProvenance ?? createLegacyProvenanceManifest({
        createdAt: record.createdAt,
        voice: record.voice,
        speed: record.speed,
        cueCount: record.cues?.length ?? 0,
      }),
    })
    await addAsset(files, assets, `library/${encodeURIComponent(record.id)}.bin`, blob, assetBudget)
  }

  const jobs = (await listJobs()).map((job) => job.generationProvenance
    ? job
    : {
      ...job,
      generationProvenance: createLegacyProvenanceManifest({
        createdAt: job.createdAt,
        voice: job.voice,
        speed: job.speed,
        format: job.format,
        cueCount: job.chunks.reduce((total, chunk) => total + (chunk.cues?.length ?? 0), 0),
      }),
    })
  for (const job of jobs) {
    for (const chunk of job.chunks) {
      const blob = await getChunkBlob(job.id, chunk.index)
      if (blob) await addAsset(files, assets, `queue/${encodeURIComponent(job.id)}/${chunk.index}.bin`, blob, assetBudget)
    }
  }

  assertArchivePayloadSizes(
    assets.map((asset) => asset.size),
    BACKUP_ASSET_BUDGET,
    'Portable backup',
  )

  const manifest: BackupManifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    clips,
    jobs,
    settings: collectSettings(options.settings),
    assets,
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  assertArchivePayloadSizes([manifestBytes.byteLength], BACKUP_MANIFEST_BUDGET, 'Portable backup manifest')
  files['manifest.json'] = manifestBytes
  const packed = await archive(files)
  if (packed.byteLength > MAX_BACKUP_BYTES) {
    throw new Error('Portable backup exceeds the 512 MB archive limit.')
  }
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

function validateManifestRecords(manifest: BackupManifest): void {
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error('Backup creation date is invalid.')
  }
  const settingKeys = Object.keys(manifest.settings)
  if (settingKeys.some((key) => !SETTINGS_KEYS.includes(key as typeof SETTINGS_KEYS[number]) || typeof manifest.settings[key] !== 'string')) {
    throw new Error('Backup contains unsupported settings.')
  }

  const assetsByPath = new Map(manifest.assets.map((asset) => [asset.path, asset]))
  const usedAssets = new Set<string>()
  const clipIds = new Set<string>()
  for (const record of manifest.clips) {
    if (
      !record
      || typeof record.id !== 'string'
      || !record.id
      || record.id.length > 200
      || clipIds.has(record.id)
      || typeof record.filename !== 'string'
      || !record.filename
      || typeof record.label !== 'string'
      || typeof record.voice !== 'string'
      || !Number.isFinite(record.createdAt)
      || !Number.isSafeInteger(record.size)
      || record.size < 0
    ) {
      throw new Error('Backup contains an invalid or duplicate clip record.')
    }
    clipIds.add(record.id)
    const path = `library/${encodeURIComponent(record.id)}.bin`
    const asset = assetsByPath.get(path)
    if (!asset || asset.size !== record.size) {
      throw new Error(`Backup clip size does not match its audio asset: ${record.label || record.id}.`)
    }
    usedAssets.add(path)
  }

  const jobIds = new Set<string>()
  let totalChunks = 0
  for (const rawJob of manifest.jobs) {
    if (!rawJob || typeof rawJob.id !== 'string' || !rawJob.id || rawJob.id.length > 200 || jobIds.has(rawJob.id) || !Array.isArray(rawJob.chunks)) {
      throw new Error('Backup contains an invalid or duplicate queue job.')
    }
    jobIds.add(rawJob.id)
    totalChunks += rawJob.chunks.length
    if (totalChunks > MAX_BACKUP_ENTRIES) throw new Error('Backup contains too many queue chunks.')
    const chunkIndexes = new Set<number>()
    for (const rawChunk of rawJob.chunks) {
      const index = Number(rawChunk?.index)
      if (!Number.isSafeInteger(index) || index < 0 || chunkIndexes.has(index)) {
        throw new Error(`Backup queue job ${rawJob.title || rawJob.id} contains an invalid or duplicate chunk index.`)
      }
      chunkIndexes.add(index)
      const path = `queue/${encodeURIComponent(rawJob.id)}/${index}.bin`
      if (assetsByPath.has(path)) usedAssets.add(path)
    }
  }

  if (usedAssets.size !== manifest.assets.length) {
    throw new Error('Backup contains audio assets that are not linked to a clip or queue chunk.')
  }
}

async function validateRestoreJournalPayload(journal: RestoreJournal): Promise<void> {
  if (!Number.isFinite(Date.parse(journal.createdAt))) throw new Error('Backup restore journal creation date is invalid.')
  validateManifestRecords(journal.prepared.manifest)
  const expectedPaths = new Set(['manifest.json', ...journal.prepared.manifest.assets.map((asset) => asset.path)])
  const actualPaths = Object.keys(journal.prepared.files)
  if (actualPaths.length !== expectedPaths.size || actualPaths.some((path) => !expectedPaths.has(path))) {
    throw new Error('Backup restore journal staging files do not match its manifest.')
  }
  const manifestBytes = journal.prepared.files['manifest.json']
  if (!manifestBytes) throw new Error('Backup restore journal is missing its staged manifest.')
  let stagedManifest: unknown
  try {
    stagedManifest = JSON.parse(new TextDecoder().decode(manifestBytes))
  } catch {
    throw new Error('Backup restore journal manifest is not valid JSON.')
  }
  if (!migrateRestoreJournal({
    schemaVersion: RESTORE_JOURNAL_SCHEMA_VERSION,
    restoreId: journal.restoreId,
    createdAt: journal.createdAt,
    phase: journal.phase,
    prepared: { manifest: stagedManifest, files: journal.prepared.files },
    previous: journal.previous,
  })) {
    throw new Error('Backup restore journal manifest is unsupported.')
  }
  for (const asset of journal.prepared.manifest.assets) {
    const bytes = journal.prepared.files[asset.path]
    if (!bytes || bytes.byteLength !== asset.size || await sha256(bytes) !== asset.sha256) {
      throw new Error(`Backup restore journal asset failed validation: ${asset.path}`)
    }
  }
}

async function prepareBackup(file: Blob): Promise<PreparedBackup> {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup is larger than 512 MB.')
  const source = new Uint8Array(await readBlob(file))
  const entries = inspectZipArchive(source, BACKUP_ARCHIVE_BUDGET, 'Portable backup')
  const manifestFiles = extractInspectedZipEntries(
    source,
    entries,
    new Set(['manifest.json']),
    BACKUP_MANIFEST_BUDGET,
    'Portable backup manifest',
  )
  const manifestBytes = manifestFiles['manifest.json']
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
  if (
    manifest.clips.length > MAX_BACKUP_ENTRIES
    || manifest.jobs.length > MAX_BACKUP_ENTRIES
    || manifest.assets.length > MAX_BACKUP_ENTRIES - 1
    || Object.keys(manifest.settings).length > SETTINGS_KEYS.length
  ) {
    throw new Error('Backup manifest exceeds record-count limits.')
  }

  const paths = new Set<string>()
  const assetSizes: number[] = []
  for (const asset of manifest.assets) {
    if (
      !asset
      || !safePath(asset.path)
      || paths.has(asset.path)
      || !Number.isSafeInteger(asset.size)
      || asset.size < 0
      || !/^[a-f0-9]{64}$/i.test(asset.sha256)
      || typeof asset.type !== 'string'
      || asset.type.length > 200
    ) {
      throw new Error('Backup contains invalid or duplicate asset metadata.')
    }
    paths.add(asset.path)
    assetSizes.push(asset.size)
  }
  assertArchivePayloadSizes(assetSizes, BACKUP_ASSET_BUDGET, 'Portable backup')
  validateManifestRecords(manifest)

  const archivePaths = new Set(entries.map((entry) => entry.normalizedName))
  if (
    archivePaths.size !== paths.size + 1
    || !archivePaths.has('manifest.json')
    || [...paths].some((path) => !archivePaths.has(path))
  ) {
    throw new Error('Backup archive files do not match the manifest.')
  }
  const assetFiles = extractInspectedZipEntries(source, entries, paths, BACKUP_ASSET_BUDGET, 'Portable backup assets')
  const files = { ...manifestFiles, ...assetFiles }
  for (const asset of manifest.assets) {
    const bytes = assetFiles[asset.path]
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

function snapshotAudioBytes(snapshot: RestoreJournal['previous']): number {
  return snapshot.clips.reduce((total, entry) => total + (entry.blob?.size ?? 0), 0)
    + snapshot.jobs.reduce((total, job) => total + job.blobs.reduce((sum, entry) => sum + entry.blob.size, 0), 0)
}

async function assertRestoreStagingQuota(prepared: PreparedBackup, previous: RestoreJournal['previous']): Promise<void> {
  const estimate = await navigator.storage?.estimate?.()
  if (!estimate?.quota) return
  const manifestBytes = prepared.files['manifest.json']?.byteLength ?? 0
  const previousMetadataBytes = new TextEncoder().encode(JSON.stringify({
    clips: previous.clips.map((entry) => entry.record),
    jobs: previous.jobs.map((entry) => entry.job),
    settings: previous.settings,
  })).byteLength
  const stagedBytes = prepared.preview.audioBytes + snapshotAudioBytes(previous) + manifestBytes + previousMetadataBytes
  const usage = estimate.usage ?? 0
  if (!Number.isFinite(stagedBytes) || usage + stagedBytes > estimate.quota * 0.9) {
    throw new Error('Backup restore staging exceeds 90% of this browser storage quota.')
  }
}

async function restorePreviousState(previous: RestoreJournal['previous']): Promise<void> {
  await clearLibrary()
  await clearQueue()
  await restoreClipSnapshots(previous.clips)
  for (const job of previous.jobs) await restoreQueueJob(job)
  restoreSettings(previous.settings)
}

async function applyPreparedBackup(prepared: PreparedBackup) {
  await clearLibrary()
  await clearQueue()

  for (const record of prepared.manifest.clips) {
    if (!record?.id || !record.filename || !Number.isFinite(record.createdAt) || !Number.isFinite(record.size)) {
      throw new Error('Backup contains an invalid clip record.')
    }
    const path = `library/${encodeURIComponent(record.id)}.bin`
    const asset = prepared.manifest.assets.find((entry) => entry.path === path)
    const bytes = prepared.files[path]
    if (!asset || !bytes) throw new Error(`Backup audio is missing for ${record.label || record.id}.`)
    const migrated = migrateClipRecord(record)
    if (!migrated) throw new Error('Backup contains an invalid clip record.')
    await saveClip(migrated, new Blob([bytesToBuffer(bytes)], { type: asset.type }))
  }

  for (const rawJob of prepared.manifest.jobs) {
    const job = migrateQueueJob(rawJob)
    const blobs: QueueJobSnapshot['blobs'] = []
    for (const chunk of job.chunks) {
      const path = `queue/${encodeURIComponent(job.id)}/${chunk.index}.bin`
      const asset = prepared.manifest.assets.find((entry) => entry.path === path)
      const bytes = prepared.files[path]
      if (asset && bytes) {
        blobs.push({
          chunkIndex: chunk.index,
          blob: new Blob([bytesToBuffer(bytes)], { type: asset.type }),
        })
      } else if (chunk.status === 'done') {
        chunk.status = 'pending'
        chunk.duration = undefined
        chunk.cues = undefined
        chunk.warning = 'Restored without audio; regenerate this segment.'
      }
    }
    await restoreQueueJob({ job, blobs })
  }
  restoreSettings(prepared.manifest.settings)
}

async function stagePortableBackup(file: Blob): Promise<RestoreJournal> {
  await recoverPortableBackupRestore()
  const prepared = await prepareBackup(file)
  const previous = await snapshotCurrentState()
  await assertRestoreStagingQuota(prepared, previous)
  const journal: RestoreJournal = {
    schemaVersion: RESTORE_JOURNAL_SCHEMA_VERSION,
    restoreId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    phase: 'staged',
    prepared: { manifest: prepared.manifest, files: prepared.files },
    previous,
  }
  await validateRestoreJournalPayload(journal)
  try {
    await writeRestoreJournal(journal)
  } catch (error) {
    throw new Error(`Could not stage portable backup before replacing local state: ${error instanceof Error ? error.message : String(error)}`)
  }
  return journal
}

async function commitStagedRestore(): Promise<BackupPreview> {
  const staged = await readRestoreJournal()
  if (!staged) throw new Error('Portable backup restore journal is missing.')
  if (staged.phase !== 'staged') throw new Error('Portable backup restore journal is not ready to commit.')
  await validateRestoreJournalPayload(staged)
  const committing: RestoreJournal = { ...staged, phase: 'committing' }
  await writeRestoreJournal(committing)
  try {
    await applyPreparedBackup({ manifest: committing.prepared.manifest, files: committing.prepared.files, preview: previewFor(committing.prepared.manifest) })
    await writeRestoreJournal({ ...committing, phase: 'committed' })
    // A committed marker is authoritative. If cleanup is interrupted, startup
    // recovery only removes this journal and never rolls back a successful restore.
    await clearRestoreJournal().catch(() => {})
  } catch (error) {
    try {
      await writeRestoreJournal({ ...committing, phase: 'rollback' }).catch(() => {})
      await restorePreviousState(committing.previous)
      await clearRestoreJournal()
    } catch {
      throw new Error('Backup restore failed and the previous local state could not be fully restored.')
    }
    throw error
  }
  return previewFor(committing.prepared.manifest)
}

/** Recover a restore interrupted after its commit marker was written. */
export async function recoverPortableBackupRestore(): Promise<void> {
  const journal = await readRestoreJournal()
  if (!journal) return
  if (journal.phase === 'staged' || journal.phase === 'committed') {
    await clearRestoreJournal()
    return
  }
  await validateRestoreJournalPayload(journal)
  try {
    await restorePreviousState(journal.previous)
    await clearRestoreJournal()
  } catch {
    throw new Error('Interrupted backup restore could not be rolled back; the journal was retained for another startup recovery attempt.')
  }
}

export async function restorePortableBackup(file: Blob): Promise<BackupPreview> {
  await stagePortableBackup(file)
  return commitStagedRestore()
}
