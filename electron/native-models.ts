// Native model pack manifest + verified download manager (TF-98).
//
// Desktop model packs are pinned to an immutable Hugging Face revision and
// every file carries an expected size + SHA-256. Downloads resume from partial
// files, stream-hash while writing, install atomically (verified content never
// replaces a good copy until the replacement passes), and record a verification
// marker so status checks stay cheap. Packs with non-permissive licenses are
// blocked from default install — that gate is a correctness feature for an MIT
// product, not a nicety.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type LicenseTier = 'permissive' | 'restricted' | 'non-commercial'

export type NativeModelPackErrorKind = 'integrity' | 'license' | 'unavailable'

export class NativeModelPackError extends Error {
  readonly kind: NativeModelPackErrorKind

  constructor(kind: NativeModelPackErrorKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'NativeModelPackError'
    this.kind = kind
  }
}

export type NativeModelFile = {
  /** Repo-relative path, forward slashes (e.g. "onnx/model_quantized.onnx"). */
  path: string
  size: number
  sha256: string
}

export type NativeModelPack = {
  /** Stable pack id used for the install directory. */
  id: string
  /** Hugging Face repo id — also the on-disk layout transformers expects. */
  modelId: string
  /** Immutable commit SHA the files are pinned to (never a branch name). */
  revision: string
  version: string
  runtime: 'onnxruntime-node'
  license: { spdx: string; tier: LicenseTier; url: string }
  files: NativeModelFile[]
  /** Runtime fetches this pack does NOT cover (disclosed in diagnostics). */
  notCovered?: string
}

// Pinned 2026-07-09 from the HF API (tree?recursive lfs.oid for the LFS model
// blob; small git blobs hashed from the pinned-revision content).
export const KOKORO_Q8_PACK: NativeModelPack = {
  id: 'kokoro-q8',
  modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
  version: 'Kokoro-82M v1.0 q8',
  runtime: 'onnxruntime-node',
  license: { spdx: 'Apache-2.0', tier: 'permissive', url: 'https://huggingface.co/hexgrad/Kokoro-82M' },
  files: [
    { path: 'config.json', size: 44, sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f' },
    { path: 'tokenizer.json', size: 3497, sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34' },
    { path: 'tokenizer_config.json', size: 113, sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20' },
    { path: 'onnx/model_quantized.onnx', size: 92361116, sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478' },
  ],
  notCovered: 'Voice style bins download per-voice at generation time (kokoro-js runtime fetch).',
}

export type PackFileState = 'missing' | 'partial' | 'present' | 'verified'

export type PackFileStatus = {
  path: string
  state: PackFileState
  bytes: number
  expectedBytes: number
}

export type PackStatus = {
  id: string
  modelId: string
  revision: string
  version: string
  license: { spdx: string; tier: LicenseTier }
  installed: boolean
  verified: boolean
  totalBytes: number
  expectedBytes: number
  files: PackFileStatus[]
  blockedReason: string | null
  notCovered?: string
  /** Archive/content digest when a runtime uses a verified bundle source. */
  sourceSha256?: string
}

export type PackProgress = {
  status: 'initiate' | 'progress' | 'done'
  file: string
  loaded?: number
  total?: number
  progress?: number
}

export type EnsurePackOptions = {
  onProgress?: (info: PackProgress) => void
  /** Explicit opt-in for restricted/non-commercial packs (BYO tier, TF-125). */
  allowNonPermissive?: boolean
  fetchImpl?: typeof fetch
  baseUrl?: string
}

const nativePackFlights = new Map<string, Promise<unknown>>()

/**
 * Share one install operation per absolute root, pack id, and revision within
 * this process. The first caller owns the fetch/progress options; all other
 * callers observe the same result or failure and can retry after it settles.
 */
export function withNativePackSingleFlight<T>(rootDir: string, packKey: string, operation: () => Promise<T>): Promise<T> {
  const key = `${resolve(rootDir)}\u0000${packKey}`
  const existing = nativePackFlights.get(key) as Promise<T> | undefined
  if (existing) return existing

  const flight = operation()
  nativePackFlights.set(key, flight)
  const clear = () => {
    if (nativePackFlights.get(key) === flight) nativePackFlights.delete(key)
  }
  flight.then(clear, clear)
  return flight
}

export function validateNativeModelPack(pack: NativeModelPack): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pack.id)) {
    throw new NativeModelPackError('integrity', `Invalid model pack id: ${pack.id}`)
  }
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(pack.modelId)) {
    throw new NativeModelPackError('integrity', `Invalid model repository id: ${pack.modelId}`)
  }
  if (!/^[a-f0-9]{40}$/i.test(pack.revision)) {
    throw new NativeModelPackError('integrity', `Model pack revision must be an immutable 40-character commit SHA: ${pack.revision}`)
  }
  if (pack.files.length === 0) {
    throw new NativeModelPackError('integrity', 'Model pack manifest contains no files.')
  }
  const paths = new Set<string>()
  for (const file of pack.files) {
    const pathParts = file.path.split('/')
    if (
      file.path.startsWith('/')
      || file.path.includes('\\')
      || pathParts.some((part) => !part || part === '.' || part === '..')
    ) {
      throw new NativeModelPackError('integrity', `Unsafe model pack path: ${file.path}`)
    }
    if (paths.has(file.path)) {
      throw new NativeModelPackError('integrity', `Duplicate model pack path: ${file.path}`)
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new NativeModelPackError('integrity', `Invalid expected size for ${file.path}: ${file.size}`)
    }
    if (!/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw new NativeModelPackError('integrity', `Invalid SHA-256 for ${file.path}.`)
    }
    paths.add(file.path)
  }
}

export function packDownloadUrl(pack: NativeModelPack, file: NativeModelFile, baseUrl = 'https://huggingface.co'): string {
  return `${baseUrl}/${pack.modelId}/resolve/${pack.revision}/${file.path}`
}

/** Install root for a pack; the revision is part of the path so a re-pin never
 * mixes files from two revisions. */
export function packInstallDir(rootDir: string, pack: NativeModelPack): string {
  return join(rootDir, 'packs', `${pack.id}@${pack.revision.slice(0, 12)}`)
}

/** transformers' env.localModelPath expects `<dir>/<modelId>/<file>`. */
export function packModelDir(rootDir: string, pack: NativeModelPack): string {
  return join(packInstallDir(rootDir, pack), pack.modelId)
}

export function licenseBlocksDefaultInstall(pack: NativeModelPack): string | null {
  if (pack.license.tier === 'permissive') return null
  return `License ${pack.license.spdx} (${pack.license.tier}) is blocked from default install. Supply your own weights to opt in.`
}

function markerPath(rootDir: string, pack: NativeModelPack): string {
  return join(packInstallDir(rootDir, pack), '.verified.json')
}

type VerificationMarker = {
  revision: string
  verifiedAt: string
  files: Record<string, string>
}

function readMarker(rootDir: string, pack: NativeModelPack): VerificationMarker | null {
  try {
    const marker = JSON.parse(readFileSync(markerPath(rootDir, pack), 'utf8')) as VerificationMarker
    return marker.revision === pack.revision ? marker : null
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

/** Cheap status read: sizes + the verification marker. Pass `deep: true` to
 * re-hash every file from disk instead of trusting the marker. */
export async function readPackStatus(rootDir: string, pack: NativeModelPack, opts: { deep?: boolean } = {}): Promise<PackStatus> {
  validateNativeModelPack(pack)
  const modelDir = packModelDir(rootDir, pack)
  const marker = readMarker(rootDir, pack)
  const files: PackFileStatus[] = []
  let totalBytes = 0

  for (const file of pack.files) {
    const finalPath = join(modelDir, file.path)
    const partPath = `${finalPath}.part`
    let state: PackFileState = 'missing'
    let bytes = 0
    if (existsSync(finalPath)) {
      bytes = statSync(finalPath).size
      if (bytes === file.size) {
        if (opts.deep) {
          state = (await hashFile(finalPath)) === file.sha256 ? 'verified' : 'present'
        } else {
          state = marker?.files[file.path] === file.sha256 ? 'verified' : 'present'
        }
      } else {
        state = 'present'
      }
    } else if (existsSync(partPath)) {
      state = 'partial'
      bytes = statSync(partPath).size
    }
    totalBytes += state === 'missing' ? 0 : bytes
    files.push({ path: file.path, state, bytes, expectedBytes: file.size })
  }

  const installed = files.every((file) => file.state === 'present' || file.state === 'verified')
  return {
    id: pack.id,
    modelId: pack.modelId,
    revision: pack.revision,
    version: pack.version,
    license: { spdx: pack.license.spdx, tier: pack.license.tier },
    installed,
    verified: installed && files.every((file) => file.state === 'verified'),
    totalBytes,
    expectedBytes: pack.files.reduce((sum, file) => sum + file.size, 0),
    files,
    blockedReason: licenseBlocksDefaultInstall(pack),
    notCovered: pack.notCovered,
  }
}

async function downloadFile(
  url: string,
  finalPath: string,
  file: NativeModelFile,
  onProgress: ((info: PackProgress) => void) | undefined,
  fetchImpl: typeof fetch,
): Promise<void> {
  const partPath = `${finalPath}.part`
  mkdirSync(dirname(finalPath), { recursive: true })

  let start = 0
  if (existsSync(partPath)) {
    start = statSync(partPath).size
    if (start >= file.size) {
      // A stale part at/above the expected size can't be trusted — restart.
      rmSync(partPath)
      start = 0
    }
  }

  onProgress?.({ status: 'initiate', file: file.path, loaded: start, total: file.size })

  const headers: Record<string, string> = start > 0 ? { Range: `bytes=${start}-` } : {}
  const response = await fetchImpl(url, { headers })
  if (start > 0 && response.status !== 206) {
    // Server ignored the range request — restart from zero.
    rmSync(partPath, { force: true })
    start = 0
  }
  if (!response.ok && response.status !== 206) {
    throw new NativeModelPackError('unavailable', `Download failed for ${file.path}: HTTP ${response.status}`)
  }
  if (!response.body) throw new NativeModelPackError('unavailable', `Download failed for ${file.path}: empty response body`)

  // The hash must cover resumed bytes too — feed the existing partial first.
  const hash = createHash('sha256')
  if (start > 0) {
    const existing = createReadStream(partPath)
    for await (const chunk of existing) hash.update(chunk as Buffer)
  }

  let loaded = start
  const out = createWriteStream(partPath, { flags: start > 0 ? 'a' : 'w' })
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      loaded += chunk.byteLength
      if (loaded > file.size) {
        throw new NativeModelPackError('integrity', `Download overran expected size for ${file.path}`)
      }
      await new Promise<void>((resolve, reject) => {
        out.write(chunk, (err) => (err ? reject(err) : resolve()))
      })
      onProgress?.({
        status: 'progress',
        file: file.path,
        loaded,
        total: file.size,
        progress: (loaded / file.size) * 100,
      })
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()))
  }

  if (loaded !== file.size) {
    throw new NativeModelPackError(
      'unavailable',
      `Download incomplete for ${file.path}: got ${loaded} of ${file.size} bytes (will resume on retry)`,
    )
  }
  const digest = hash.digest('hex')
  if (digest !== file.sha256) {
    // Corrupt or tampered content is never installed; the partial is discarded
    // so the next attempt starts clean.
    rmSync(partPath, { force: true })
    throw new NativeModelPackError('integrity', `Checksum mismatch for ${file.path}: expected ${file.sha256}, got ${digest}`)
  }

  renameSync(partPath, finalPath)
  onProgress?.({ status: 'done', file: file.path, loaded, total: file.size, progress: 100 })
}

/** Ensure every manifest file is present and hash-verified; returns the root
 * to hand to transformers' env.localModelPath (it appends the modelId itself).
 * Already-verified files are never re-downloaded or touched. */
export async function ensurePack(rootDir: string, pack: NativeModelPack, opts: EnsurePackOptions = {}): Promise<{ localModelRoot: string; status: PackStatus }> {
  validateNativeModelPack(pack)
  const blocked = licenseBlocksDefaultInstall(pack)
  if (blocked && !opts.allowNonPermissive) throw new NativeModelPackError('license', blocked)

  return withNativePackSingleFlight(rootDir, `${pack.id}@${pack.revision}`, async () => {
    const fetchImpl = opts.fetchImpl ?? fetch
    const filesDir = packModelDir(rootDir, pack)
    const verifiedFiles: Record<string, string> = {}

    for (const file of pack.files) {
      const finalPath = join(filesDir, file.path)
      if (existsSync(finalPath) && statSync(finalPath).size === file.size) {
        // The marker accelerates status display only. Native runtime startup
        // always hashes the actual bytes so a same-sized post-install mutation
        // cannot inherit trust from stale marker metadata.
        const known = (await hashFile(finalPath)) === file.sha256
        if (known) {
          verifiedFiles[file.path] = file.sha256
          continue
        }
        // Wrong content at the right size — quarantine to .part-free restart.
        rmSync(finalPath, { force: true })
      } else if (existsSync(finalPath)) {
        rmSync(finalPath, { force: true })
      }
      await downloadFile(packDownloadUrl(pack, file, opts.baseUrl), finalPath, file, opts.onProgress, fetchImpl)
      verifiedFiles[file.path] = file.sha256
    }

    const markerBody: VerificationMarker = {
      revision: pack.revision,
      verifiedAt: new Date().toISOString(),
      files: verifiedFiles,
    }
    mkdirSync(packInstallDir(rootDir, pack), { recursive: true })
    writeFileSync(markerPath(rootDir, pack), JSON.stringify(markerBody, null, 2))

    return { localModelRoot: packInstallDir(rootDir, pack), status: await readPackStatus(rootDir, pack) }
  })
}
