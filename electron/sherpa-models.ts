// Verified Sherpa-ONNX model archives (TF-115).
//
// The upstream Node addon ships the native runtime, not model weights.  The
// two desktop packs below are pinned to immutable Hugging Face revisions and
// immutable GitHub release-asset SHA-256 values.  Archives are downloaded to
// a resumable partial file, checked before extraction, listed for traversal
// safety, and extracted into a private staging directory.  The extracted file
// hashes are recorded so a later mutation cannot silently reach the addon.
import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import {
  NativeModelPackError,
  type PackFileStatus,
  type PackStatus,
  type PackProgress,
} from './native-models.ts'

const execFile = promisify(execFileCallback)
const SHERPA_RELEASE_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models'
const MAX_ARCHIVE_LIST_BYTES = 8 * 1024 * 1024
const MAX_ARCHIVE_ENTRY_BYTES = 4096
const MAX_ARCHIVE_ENTRIES = 20_000

export type SherpaEngineId = 'kokoro' | 'piper' | 'melo'

export type SherpaModelLayout = {
  rootDir: string
  model: string
  voices?: string
  tokens: string
  dataDir?: string
  lexicon?: string
}

export type SherpaModelPack = {
  id: string
  modelId: string
  revision: string
  version: string
  engine: SherpaEngineId
  license: { spdx: string; tier: 'permissive'; url: string }
  archive: {
    fileName: string
    url: string
    size: number
    sha256: string
  }
  layout: SherpaModelLayout
}

export const SHERPA_KOKORO_PACK: SherpaModelPack = {
  id: 'sherpa-kokoro-int8-v1.0',
  modelId: 'csukuangfj/kokoro-int8-multi-lang-v1_0',
  revision: '5d6cbe65546edb3ebae8bde976c8ad3438b3f34b',
  version: 'Kokoro v1.0 int8 via sherpa-onnx',
  engine: 'kokoro',
  license: {
    spdx: 'Apache-2.0',
    tier: 'permissive',
    url: 'https://huggingface.co/csukuangfj/kokoro-int8-multi-lang-v1_0',
  },
  archive: {
    fileName: 'kokoro-int8-multi-lang-v1_0.tar.bz2',
    url: `${SHERPA_RELEASE_BASE}/kokoro-int8-multi-lang-v1_0.tar.bz2`,
    size: 131_839_838,
    sha256: '75654a84864be26f345f020f4070c2c019e96dd1b7f9bf6e2ffd59efac6aa5a3',
  },
  layout: {
    rootDir: 'kokoro-int8-multi-lang-v1_0',
    model: 'model.int8.onnx',
    voices: 'voices.bin',
    tokens: 'tokens.txt',
    dataDir: 'espeak-ng-data',
    // The native desktop route is currently English-only, so loading the
    // US lexicon avoids duplicate-entry noise from the overlapping GB file.
    lexicon: 'lexicon-us-en.txt',
  },
}

export const SHERPA_PIPER_PACK: SherpaModelPack = {
  id: 'sherpa-piper-en-gb-cori-medium',
  modelId: 'csukuangfj/vits-piper-en_GB-cori-medium',
  revision: 'e304c95c578725ba9cab0cff451c4e5d9aaf889e',
  version: 'Piper en-GB Cori medium via sherpa-onnx',
  engine: 'piper',
  // The source model card identifies the LibriVox training data as public
  // domain.  Keep the provenance visible instead of labelling it MIT/Apache.
  license: {
    spdx: 'Public-Domain',
    tier: 'permissive',
    url: 'https://huggingface.co/csukuangfj/vits-piper-en_GB-cori-medium',
  },
  archive: {
    fileName: 'vits-piper-en_GB-cori-medium.tar.bz2',
    url: `${SHERPA_RELEASE_BASE}/vits-piper-en_GB-cori-medium.tar.bz2`,
    size: 67_257_412,
    sha256: '49c9a5361bbdd95d7ca9687c4de11e5908481f65e7c7c368960df79949fdac2b',
  },
  layout: {
    rootDir: 'vits-piper-en_GB-cori-medium',
    model: 'en_GB-cori-medium.onnx',
    tokens: 'tokens.txt',
    dataDir: 'espeak-ng-data',
  },
}

export const SHERPA_MELO_PACK: SherpaModelPack = {
  id: 'sherpa-melo-tts-zh-en',
  modelId: 'myshell-ai/MeloTTS-Chinese',
  revision: 'af5d207a364ea4208c6f589c89f57f88414bdd16',
  version: 'MeloTTS Chinese + English via sherpa-onnx',
  engine: 'melo',
  license: {
    spdx: 'MIT',
    tier: 'permissive',
    url: 'https://huggingface.co/myshell-ai/MeloTTS-Chinese',
  },
  archive: {
    fileName: 'vits-melo-tts-zh_en.tar.bz2',
    url: `${SHERPA_RELEASE_BASE}/vits-melo-tts-zh_en.tar.bz2`,
    size: 167_006_755,
    sha256: 'e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514',
  },
  // The official Sherpa example uses the fp32 graph for this VITS export. The
  // archive also carries an int8 graph, but the native addon currently exits
  // during session creation with that graph, so keep the known-good entry
  // explicit in the immutable layout.
  layout: {
    rootDir: 'vits-melo-tts-zh_en',
    model: 'model.onnx',
    tokens: 'tokens.txt',
    lexicon: 'lexicon.txt',
  },
}

export type SherpaModelPaths = {
  root: string
  model: string
  voices?: string
  tokens: string
  dataDir?: string
  lexicon?: string
}

export type SherpaEnsureOptions = {
  onProgress?: (info: PackProgress) => void
  fetchImpl?: typeof fetch
}

type ExtractionMarker = {
  revision: string
  archiveSha256: string
  verifiedAt: string
  files: Record<string, string>
}

function validateRelativePath(value: string, label: string): void {
  const parts = value.replaceAll('\\', '/').split('/')
  if (
    !value
    || isAbsolute(value)
    || value.includes('\\')
    || parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new NativeModelPackError('integrity', `Unsafe ${label}: ${value}`)
  }
}

export function validateSherpaModelPack(pack: SherpaModelPack): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pack.id)) {
    throw new NativeModelPackError('integrity', `Invalid Sherpa model pack id: ${pack.id}`)
  }
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(pack.modelId)) {
    throw new NativeModelPackError('integrity', `Invalid Sherpa model repository id: ${pack.modelId}`)
  }
  if (!/^[a-f0-9]{40}$/i.test(pack.revision)) {
    throw new NativeModelPackError('integrity', `Sherpa model revision must be an immutable 40-character SHA: ${pack.revision}`)
  }
  if (!/^https:\/\//i.test(pack.archive.url)) {
    throw new NativeModelPackError('integrity', 'Sherpa model archive URL must use HTTPS.')
  }
  if (!Number.isSafeInteger(pack.archive.size) || pack.archive.size <= 0) {
    throw new NativeModelPackError('integrity', `Invalid Sherpa archive size: ${pack.archive.size}`)
  }
  if (!/^[a-f0-9]{64}$/i.test(pack.archive.sha256)) {
    throw new NativeModelPackError('integrity', 'Invalid Sherpa archive SHA-256.')
  }
  validateRelativePath(pack.archive.fileName, 'Sherpa archive file name')
  validateRelativePath(pack.layout.rootDir, 'Sherpa archive root')
  validateRelativePath(pack.layout.model, 'Sherpa model path')
  validateRelativePath(pack.layout.tokens, 'Sherpa token path')
  if (pack.layout.dataDir) validateRelativePath(pack.layout.dataDir, 'Sherpa data directory')
  if (pack.layout.voices) validateRelativePath(pack.layout.voices, 'Sherpa voices path')
  if (pack.layout.lexicon) {
    for (const path of pack.layout.lexicon.split(',')) validateRelativePath(path, 'Sherpa lexicon path')
  }
}

function packInstallDir(rootDir: string, pack: SherpaModelPack): string {
  return join(rootDir, 'sherpa-packs', `${pack.id}@${pack.revision.slice(0, 12)}`)
}

function archivePath(rootDir: string, pack: SherpaModelPack): string {
  return join(packInstallDir(rootDir, pack), pack.archive.fileName)
}

function extractionRoot(rootDir: string, pack: SherpaModelPack): string {
  return join(packInstallDir(rootDir, pack), 'model')
}

function markerPath(rootDir: string, pack: SherpaModelPack): string {
  return join(packInstallDir(rootDir, pack), '.verified.json')
}

export function sherpaModelPaths(rootDir: string, pack: SherpaModelPack): SherpaModelPaths {
  validateSherpaModelPack(pack)
  const root = extractionRoot(rootDir, pack)
  return {
    root,
    model: join(root, pack.layout.model),
    ...(pack.layout.voices ? { voices: join(root, pack.layout.voices) } : {}),
    tokens: join(root, pack.layout.tokens),
    ...(pack.layout.dataDir ? { dataDir: join(root, pack.layout.dataDir) } : {}),
    ...(pack.layout.lexicon ? { lexicon: pack.layout.lexicon.split(',').map((path) => join(root, path)).join(',') } : {}),
  }
}

function readMarker(rootDir: string, pack: SherpaModelPack): ExtractionMarker | null {
  try {
    const marker = JSON.parse(readFileSync(markerPath(rootDir, pack), 'utf8')) as ExtractionMarker
    return marker.revision === pack.revision && marker.archiveSha256 === pack.archive.sha256 ? marker : null
  } catch {
    return null
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function collectFiles(root: string, current = root): string[] {
  const files: string[] = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name)
    if (entry.isSymbolicLink()) {
      throw new NativeModelPackError('integrity', `Sherpa model archive contains a symbolic link: ${relative(root, absolute)}`)
    }
    if (entry.isDirectory()) files.push(...collectFiles(root, absolute))
    else if (entry.isFile()) files.push(absolute)
    else throw new NativeModelPackError('integrity', `Unsupported Sherpa model entry: ${relative(root, absolute)}`)
  }
  return files
}

function requiredModelPaths(pack: SherpaModelPack): string[] {
  return [
    pack.layout.model,
    pack.layout.tokens,
    ...(pack.layout.dataDir ? [pack.layout.dataDir] : []),
    ...(pack.layout.voices ? [pack.layout.voices] : []),
    ...(pack.layout.lexicon ? pack.layout.lexicon.split(',') : []),
  ]
}

function assertRequiredPathsAtRoot(root: string, pack: SherpaModelPack): void {
  for (const required of requiredModelPaths(pack)) {
    const absolute = join(root, required)
    if (!existsSync(absolute)) throw new NativeModelPackError('integrity', `Sherpa model archive is missing ${required}.`)
    const stat = lstatSync(absolute)
    if (required === pack.layout.dataDir ? !stat.isDirectory() : !stat.isFile()) {
      throw new NativeModelPackError('integrity', `Sherpa model entry has the wrong type: ${required}`)
    }
  }
}

function assertRequiredPaths(rootDir: string, pack: SherpaModelPack): void {
  assertRequiredPathsAtRoot(extractionRoot(rootDir, pack), pack)
}

async function readExtractionFiles(rootDir: string, pack: SherpaModelPack): Promise<Record<string, string>> {
  assertRequiredPaths(rootDir, pack)
  const root = extractionRoot(rootDir, pack)
  const files = collectFiles(root)
  const entries: Record<string, string> = {}
  for (const absolute of files) {
    const key = relative(root, absolute).replaceAll('\\', '/')
    entries[key] = await hashFile(absolute)
  }
  return entries
}

type ExtractionVerificationDepth = 'structural' | 'required' | 'all'

function isRuntimeModelFile(pack: SherpaModelPack, key: string): boolean {
  const dataPrefix = pack.layout.dataDir ? `${pack.layout.dataDir}/` : null
  return key === pack.layout.model
    || key === pack.layout.tokens
    || key === pack.layout.voices
    || key === pack.layout.dataDir
    || (dataPrefix !== null && key.startsWith(dataPrefix))
    || Boolean(pack.layout.lexicon?.split(',').includes(key))
}

async function extractionIsVerified(
  rootDir: string,
  pack: SherpaModelPack,
  marker: ExtractionMarker | null,
  depth: ExtractionVerificationDepth = 'all',
): Promise<boolean> {
  if (!marker || !existsSync(extractionRoot(rootDir, pack))) return false
  try {
    assertRequiredPaths(rootDir, pack)
    for (const [key, digest] of Object.entries(marker.files)) {
      const absolute = join(extractionRoot(rootDir, pack), key)
      if (!existsSync(absolute) || !lstatSync(absolute).isFile()) return false
      if (depth === 'all' || (depth === 'required' && isRuntimeModelFile(pack, key))) {
        if (await hashFile(absolute) !== digest) return false
      }
    }
    const currentFiles = collectFiles(extractionRoot(rootDir, pack))
    return currentFiles.length === Object.keys(marker.files).length
      && currentFiles.every((absolute) => Object.hasOwn(marker.files, relative(extractionRoot(rootDir, pack), absolute).replaceAll('\\', '/')))
  } catch {
    return false
  }
}

function archiveStatus(rootDir: string, pack: SherpaModelPack, verified: boolean): PackFileStatus {
  const path = archivePath(rootDir, pack)
  const bytes = existsSync(path) ? statSync(path).size : 0
  return {
    path: pack.archive.fileName,
    state: verified ? 'verified' : bytes > 0 ? 'present' : 'missing',
    bytes,
    expectedBytes: pack.archive.size,
  }
}

export async function readSherpaPackStatus(rootDir: string, pack: SherpaModelPack, opts: { deep?: boolean } = {}): Promise<PackStatus> {
  validateSherpaModelPack(pack)
  const marker = readMarker(rootDir, pack)
  const archive = archiveStatus(rootDir, pack, false)
  const archiveVerified = archive.bytes === pack.archive.size && marker !== null
  const verified = archiveVerified && (opts.deep ? await extractionIsVerified(rootDir, pack, marker, 'all') : existsSync(extractionRoot(rootDir, pack)))
  return {
    id: pack.id,
    modelId: pack.modelId,
    revision: pack.revision,
    version: pack.version,
    license: { spdx: pack.license.spdx, tier: pack.license.tier },
    installed: archive.bytes === pack.archive.size && existsSync(extractionRoot(rootDir, pack)),
    verified,
    totalBytes: archive.bytes,
    expectedBytes: pack.archive.size,
    files: [{ ...archive, state: verified ? 'verified' : archive.state }],
    blockedReason: null,
    sourceSha256: pack.archive.sha256,
  }
}

async function downloadArchive(
  pack: SherpaModelPack,
  finalPath: string,
  onProgress: ((info: PackProgress) => void) | undefined,
  fetchImpl: typeof fetch,
): Promise<void> {
  const partPath = `${finalPath}.part`
  mkdirSync(dirname(finalPath), { recursive: true })
  let start = existsSync(partPath) ? statSync(partPath).size : 0
  if (start >= pack.archive.size) {
    rmSync(partPath, { force: true })
    start = 0
  }

  onProgress?.({ status: 'initiate', file: pack.archive.fileName, loaded: start, total: pack.archive.size })
  const response = await fetchImpl(pack.archive.url, { headers: start > 0 ? { Range: `bytes=${start}-` } : {} })
  if (start > 0 && response.status !== 206) {
    rmSync(partPath, { force: true })
    start = 0
  }
  if (!response.ok && response.status !== 206) {
    throw new NativeModelPackError('unavailable', `Download failed for ${pack.archive.fileName}: HTTP ${response.status}`)
  }
  if (!response.body) throw new NativeModelPackError('unavailable', `Download failed for ${pack.archive.fileName}: empty response body`)

  const hash = createHash('sha256')
  if (start > 0) {
    const existing = createReadStream(partPath)
    for await (const chunk of existing) hash.update(chunk as Buffer)
  }
  const out = createWriteStream(partPath, { flags: start > 0 ? 'a' : 'w' })
  let loaded = start
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      loaded += chunk.byteLength
      if (loaded > pack.archive.size) throw new NativeModelPackError('integrity', `Download overran expected size for ${pack.archive.fileName}`)
      hash.update(chunk)
      await new Promise<void>((resolve, reject) => out.write(chunk, (error) => error ? reject(error) : resolve()))
      onProgress?.({ status: 'progress', file: pack.archive.fileName, loaded, total: pack.archive.size, progress: (loaded / pack.archive.size) * 100 })
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()))
  }
  if (loaded !== pack.archive.size) {
    throw new NativeModelPackError('unavailable', `Download incomplete for ${pack.archive.fileName}: got ${loaded} of ${pack.archive.size} bytes (will resume on retry)`)
  }
  const digest = hash.digest('hex')
  if (digest !== pack.archive.sha256) {
    rmSync(partPath, { force: true })
    throw new NativeModelPackError('integrity', `Checksum mismatch for ${pack.archive.fileName}: expected ${pack.archive.sha256}, got ${digest}`)
  }
  renameSync(partPath, finalPath)
  onProgress?.({ status: 'done', file: pack.archive.fileName, loaded, total: pack.archive.size, progress: 100 })
}

export function validateArchiveEntry(entry: string): string {
  const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const parts = normalized.split('/')
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
  if (
    !normalized
    || Buffer.byteLength(normalized, 'utf8') > MAX_ARCHIVE_ENTRY_BYTES
    || hasControlCharacter
    || isAbsolute(normalized)
    || normalized.startsWith('/')
    || /^[a-z]:\//i.test(normalized)
    || parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new NativeModelPackError('integrity', `Unsafe Sherpa archive entry: ${entry}`)
  }
  return normalized
}

export function validateArchiveEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>()
  return entries.map((entry) => {
    const normalized = validateArchiveEntry(entry)
    const key = normalized.toLocaleLowerCase('en-US')
    if (seen.has(key)) throw new NativeModelPackError('integrity', `Duplicate Sherpa archive entry: ${entry}`)
    seen.add(key)
    return normalized
  })
}

export function validateArchiveEntryType(line: string): 'file' | 'directory' {
  const type = line.trimStart()[0]
  if (type === '-') return 'file'
  if (type === 'd') return 'directory'
  throw new NativeModelPackError('integrity', `Unsupported Sherpa archive entry type: ${line.trim() || '(empty)'}`)
}

export function validateArchiveListingTypes(verboseListing: string, expectedEntries: number): void {
  if (Buffer.byteLength(verboseListing, 'utf8') > MAX_ARCHIVE_LIST_BYTES) {
    throw new NativeModelPackError('integrity', 'Sherpa archive metadata listing is too large.')
  }
  const lines = verboseListing.split(/\r?\n/).filter(Boolean)
  if (lines.length !== expectedEntries) {
    throw new NativeModelPackError('integrity', `Sherpa archive entry listing mismatch: expected ${expectedEntries}, got ${lines.length}`)
  }
  for (const line of lines) validateArchiveEntryType(line)
}

function modelStagingPath(packDir: string): string {
  return join(packDir, 'model.staged')
}

function modelPreviousPath(packDir: string): string {
  return join(packDir, 'model.previous')
}

function cleanupStagingDirectories(packDir: string): void {
  for (const entry of readdirSync(packDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.extract-')) rmSync(join(packDir, entry.name), { recursive: true, force: true })
  }
}

export function recoverInterruptedSherpaExtraction(rootDir: string, pack: SherpaModelPack): void {
  const packDir = packInstallDir(rootDir, pack)
  const currentRoot = extractionRoot(rootDir, pack)
  const stagedRoot = modelStagingPath(packDir)
  const previousRoot = modelPreviousPath(packDir)
  cleanupStagingDirectories(packDir)

  if (!existsSync(currentRoot) && existsSync(previousRoot)) {
    renameSync(previousRoot, currentRoot)
  } else if (existsSync(currentRoot) && existsSync(previousRoot)) {
    rmSync(previousRoot, { recursive: true, force: true })
  }
  rmSync(stagedRoot, { recursive: true, force: true })
}

async function extractArchive(rootDir: string, pack: SherpaModelPack, archive: string): Promise<void> {
  const listed = validateArchiveEntries((await execFile('tar', ['-tjf', archive], { windowsHide: true, maxBuffer: MAX_ARCHIVE_LIST_BYTES })).stdout
    .split(/\r?\n/)
    .filter(Boolean))
  if (listed.length === 0 || listed.length > MAX_ARCHIVE_ENTRIES) {
    throw new NativeModelPackError('integrity', `Unexpected Sherpa archive entry count: ${listed.length}`)
  }
  const requiredPrefix = `${pack.layout.rootDir}/`
  if (!listed.some((entry) => entry === `${requiredPrefix}${pack.layout.model}`)) {
    throw new NativeModelPackError('integrity', `Sherpa archive does not contain the expected ${pack.layout.rootDir} layout.`)
  }
  const verbose = (await execFile('tar', ['-tvjf', archive], { windowsHide: true, maxBuffer: MAX_ARCHIVE_LIST_BYTES })).stdout
  validateArchiveListingTypes(verbose, listed.length)

  const packDir = packInstallDir(rootDir, pack)
  recoverInterruptedSherpaExtraction(rootDir, pack)
  const staging = mkdtempSync(join(packDir, '.extract-'))
  try {
    await execFile('tar', ['-xjf', archive, '-C', staging], { windowsHide: true, maxBuffer: MAX_ARCHIVE_LIST_BYTES })
    const stagedRoot = join(staging, pack.layout.rootDir)
    if (!existsSync(stagedRoot)) throw new NativeModelPackError('integrity', `Sherpa archive root is missing: ${pack.layout.rootDir}`)
    const stagedRootStat = lstatSync(stagedRoot)
    if (!stagedRootStat.isDirectory()) throw new NativeModelPackError('integrity', `Sherpa archive root has the wrong type: ${pack.layout.rootDir}`)
    assertRequiredPathsAtRoot(stagedRoot, pack)
    collectFiles(stagedRoot)
    const stagedModelRoot = modelStagingPath(packDir)
    rmSync(stagedModelRoot, { recursive: true, force: true })
    renameSync(stagedRoot, stagedModelRoot)
    const currentRoot = extractionRoot(rootDir, pack)
    const previousRoot = modelPreviousPath(packDir)
    let previousRootMoved = false
    try {
      rmSync(previousRoot, { recursive: true, force: true })
      if (existsSync(currentRoot)) {
        renameSync(currentRoot, previousRoot)
        previousRootMoved = true
      }
      renameSync(stagedModelRoot, currentRoot)
      rmSync(previousRoot, { recursive: true, force: true })
      previousRootMoved = false
    } catch (error) {
      if (previousRootMoved && !existsSync(currentRoot) && existsSync(previousRoot)) {
        renameSync(previousRoot, currentRoot)
      }
      throw error
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(join(packDir, 'model.staged'), { recursive: true, force: true })
  }
}

export async function ensureSherpaModelPack(
  rootDir: string,
  pack: SherpaModelPack,
  opts: SherpaEnsureOptions = {},
): Promise<{ modelRoot: string; status: PackStatus }> {
  validateSherpaModelPack(pack)
  const fetchImpl = opts.fetchImpl ?? fetch
  const packDir = packInstallDir(rootDir, pack)
  const archive = archivePath(rootDir, pack)
  mkdirSync(packDir, { recursive: true })

  const marker = readMarker(rootDir, pack)
  // The archive is authenticated before extraction and the marker records the
  // exact extracted file digests.  Required runtime inputs are re-hashed on
  // startup; callers that need every archive byte revalidated can use deep
  // status.  This avoids re-reading unrelated language dictionaries while
  // keeping the model graph, lexicon, tokens, voices, and eSpeak data guarded.
  const extractionVerified = await extractionIsVerified(rootDir, pack, marker, 'required')
  const archiveMatches = existsSync(archive)
    && statSync(archive).size === pack.archive.size
    && (extractionVerified || await hashFile(archive) === pack.archive.sha256)
  if (!archiveMatches) {
    rmSync(archive, { force: true })
    await downloadArchive(pack, archive, opts.onProgress, fetchImpl)
  }

  if (!extractionVerified) {
    await extractArchive(rootDir, pack, archive)
    const files = await readExtractionFiles(rootDir, pack)
    writeFileSync(markerPath(rootDir, pack), JSON.stringify({
      revision: pack.revision,
      archiveSha256: pack.archive.sha256,
      verifiedAt: new Date().toISOString(),
      files,
    } satisfies ExtractionMarker, null, 2))
  }

  const status = await readSherpaPackStatus(rootDir, pack, { deep: false })
  return { modelRoot: extractionRoot(rootDir, pack), status }
}

export const SHERPA_KOKORO_SPEAKER_IDS: Readonly<Record<string, number>> = {
  af_alloy: 0,
  af_aoede: 1,
  af_bella: 2,
  af_heart: 3,
  af_jessica: 4,
  af_kore: 5,
  af_nicole: 6,
  af_nova: 7,
  af_river: 8,
  af_sarah: 9,
  af_sky: 10,
  am_adam: 11,
  am_echo: 12,
  am_eric: 13,
  am_fenrir: 14,
  am_liam: 15,
  am_michael: 16,
  am_onyx: 17,
  am_puck: 18,
  am_santa: 19,
  bf_alice: 20,
  bf_emma: 21,
  bf_isabella: 22,
  bf_lily: 23,
  bm_daniel: 24,
  bm_fable: 25,
  bm_george: 26,
  bm_lewis: 27,
  ef_dora: 28,
  em_alex: 29,
  ff_siwis: 30,
  hf_alpha: 31,
  hf_beta: 32,
  hm_omega: 33,
  hm_psi: 34,
  if_sara: 35,
  im_nicola: 36,
  jf_alpha: 37,
  jf_gongitsune: 38,
  jf_nezumi: 39,
  jf_tebukuro: 40,
  jm_kumo: 41,
  pf_dora: 42,
  pm_alex: 43,
  pm_santa: 44,
  zf_xiaobei: 45,
  zf_xiaoni: 46,
  zf_xiaoxiao: 47,
  zf_xiaoyi: 48,
  zm_yunjian: 49,
  zm_yunxi: 50,
  zm_yunxia: 51,
  zm_yunyang: 52,
}

export function sherpaKokoroSpeakerId(voice: string): number {
  return SHERPA_KOKORO_SPEAKER_IDS[voice] ?? SHERPA_KOKORO_SPEAKER_IDS.af_heart
}
