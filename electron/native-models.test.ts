import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensurePack,
  licenseBlocksDefaultInstall,
  NativeModelPackError,
  packDownloadUrl,
  packInstallDir,
  packModelDir,
  readPackStatus,
  validateNativeModelPack,
  type NativeModelPack,
} from './native-models.ts'

const bodyA = new TextEncoder().encode('{"model":"test"}')
const bodyB = new TextEncoder().encode('binary-model-content-of-reasonable-length!!')

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function makePack(overrides: Partial<NativeModelPack> = {}): NativeModelPack {
  return {
    id: 'test-pack',
    modelId: 'acme/test-model',
    revision: 'abcdef0123456789abcdef0123456789abcdef01',
    version: 'Test v1',
    runtime: 'onnxruntime-node',
    license: { spdx: 'Apache-2.0', tier: 'permissive', url: 'https://example.com' },
    files: [
      { path: 'config.json', size: bodyA.length, sha256: sha256(bodyA) },
      { path: 'onnx/model.onnx', size: bodyB.length, sha256: sha256(bodyB) },
    ],
    ...overrides,
  }
}

// Range-aware fake fetch over an in-memory file map, with call recording.
function makeFakeFetch(files: Record<string, Uint8Array>, opts: { ignoreRange?: boolean } = {}) {
  const calls: Array<{ url: string; range?: string }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const name = url.split('/resolve/')[1]?.split('/').slice(1).join('/') ?? ''
    const bytes = files[name]
    if (!bytes) return new Response('not found', { status: 404 })
    const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range
    calls.push({ url, range: rangeHeader })
    if (rangeHeader && !opts.ignoreRange) {
      const start = Number(/bytes=(\d+)-/.exec(rangeHeader)?.[1] ?? 0)
      return new Response(bytes.slice(start), { status: 206 })
    }
    return new Response(bytes.slice(), { status: 200 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bettertts-pack-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('native model pack manifest', () => {
  it('builds pinned-revision download URLs and revisioned install dirs', () => {
    const pack = makePack()
    expect(packDownloadUrl(pack, pack.files[0])).toBe(
      'https://huggingface.co/acme/test-model/resolve/abcdef0123456789abcdef0123456789abcdef01/config.json',
    )
    expect(packInstallDir(root, pack)).toContain('test-pack@abcdef012345')
  })

  it('blocks non-permissive packs from default install', async () => {
    const pack = makePack({ license: { spdx: 'CC-BY-NC-4.0', tier: 'non-commercial', url: 'https://example.com' } })
    expect(licenseBlocksDefaultInstall(pack)).toMatch(/blocked from default install/)
    await expect(ensurePack(root, pack, makeFakeFetch({}))).rejects.toMatchObject({
      kind: 'license',
      message: expect.stringMatching(/blocked/),
    })
    // Explicit opt-in (BYO tier) is allowed through the same path.
    const { fetchImpl } = makeFakeFetch({ 'config.json': bodyA, 'onnx/model.onnx': bodyB })
    const ensured = await ensurePack(root, pack, { fetchImpl, allowNonPermissive: true })
    expect(ensured.status.installed).toBe(true)
  })

  it('rejects mutable revisions and unsafe file metadata before fetching', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const mutableRevision = makePack({ revision: 'main' })
    expect(() => validateNativeModelPack(mutableRevision)).toThrow(/immutable 40-character commit SHA/)
    await expect(ensurePack(root, mutableRevision, { fetchImpl })).rejects.toMatchObject({ kind: 'integrity' })

    const unsafePath = makePack({
      files: [{ path: '../model.onnx', size: bodyB.length, sha256: sha256(bodyB) }],
    })
    await expect(ensurePack(root, unsafePath, { fetchImpl })).rejects.toMatchObject({ kind: 'integrity' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('ensurePack', () => {
  it('downloads, hash-verifies, installs atomically, and records verification', async () => {
    const pack = makePack()
    const { fetchImpl } = makeFakeFetch({ 'config.json': bodyA, 'onnx/model.onnx': bodyB })
    const progress: string[] = []

    const { localModelRoot, status } = await ensurePack(root, pack, {
      fetchImpl,
      onProgress: (info) => progress.push(`${info.status}:${info.file}`),
    })

    expect(localModelRoot).toBe(packInstallDir(root, pack))
    expect(status.installed).toBe(true)
    expect(status.verified).toBe(true)
    expect(readFileSync(join(packModelDir(root, pack), 'config.json'), 'utf8')).toBe('{"model":"test"}')
    expect(progress).toContain('done:onnx/model.onnx')

    // Cheap status read trusts the marker without rehashing.
    const reread = await readPackStatus(root, pack)
    expect(reread.verified).toBe(true)
    // Deep verify re-hashes from disk and agrees.
    const deep = await readPackStatus(root, pack, { deep: true })
    expect(deep.verified).toBe(true)
  })

  it('resumes a partial download with a Range request and hashes the whole file', async () => {
    const pack = makePack()
    const filesDir = packModelDir(root, pack)
    mkdirSync(join(filesDir, 'onnx'), { recursive: true })
    // Simulate an interrupted download: first half of the model already on disk.
    writeFileSync(join(filesDir, 'onnx/model.onnx.part'), bodyB.slice(0, 20))
    const { fetchImpl, calls } = makeFakeFetch({ 'config.json': bodyA, 'onnx/model.onnx': bodyB })

    const { status } = await ensurePack(root, pack, { fetchImpl })

    expect(status.verified).toBe(true)
    const modelCall = calls.find((call) => call.url.endsWith('model.onnx'))
    expect(modelCall?.range).toBe('bytes=20-')
    expect(existsSync(join(filesDir, 'onnx/model.onnx.part'))).toBe(false)
  })

  it('restarts cleanly when the server ignores the Range request', async () => {
    const pack = makePack()
    const filesDir = packModelDir(root, pack)
    mkdirSync(join(filesDir, 'onnx'), { recursive: true })
    writeFileSync(join(filesDir, 'onnx/model.onnx.part'), bodyB.slice(0, 20))
    const { fetchImpl } = makeFakeFetch({ 'config.json': bodyA, 'onnx/model.onnx': bodyB }, { ignoreRange: true })

    const { status } = await ensurePack(root, pack, { fetchImpl })
    expect(status.verified).toBe(true)
  })

  it('rejects corrupt content, never installs it, and preserves verified files', async () => {
    const pack = makePack()
    // First install the small file legitimately.
    const good = makeFakeFetch({ 'config.json': bodyA, 'onnx/model.onnx': bodyB })
    await ensurePack(root, pack, { fetchImpl: good.fetchImpl })

    // Now corrupt the model on the "server" and force a redownload by removing
    // the local copy.
    const filesDir = packModelDir(root, pack)
    rmSync(join(filesDir, 'onnx/model.onnx'))
    const tampered = new Uint8Array(bodyB)
    tampered[0] ^= 0xff
    const bad = makeFakeFetch({ 'config.json': bodyA, 'onnx/model.onnx': tampered })

    await expect(ensurePack(root, pack, { fetchImpl: bad.fetchImpl })).rejects.toThrow(/Checksum mismatch/)
    expect(existsSync(join(filesDir, 'onnx/model.onnx'))).toBe(false)
    expect(existsSync(join(filesDir, 'onnx/model.onnx.part'))).toBe(false)
    // The untouched verified file is still there.
    expect(readFileSync(join(filesDir, 'config.json'), 'utf8')).toBe('{"model":"test"}')
  })

  it('rehashes installed bytes instead of trusting a stale verification marker', async () => {
    const pack = makePack()
    const good = makeFakeFetch({ 'config.json': bodyA, 'onnx/model.onnx': bodyB })
    await ensurePack(root, pack, { fetchImpl: good.fetchImpl })

    const filesDir = packModelDir(root, pack)
    const tampered = new Uint8Array(bodyB)
    tampered[2] ^= 0x7f
    writeFileSync(join(filesDir, 'onnx/model.onnx'), tampered)

    const poisonedOrigin = makeFakeFetch({ 'config.json': bodyA, 'onnx/model.onnx': tampered })
    const failure = ensurePack(root, pack, { fetchImpl: poisonedOrigin.fetchImpl })
    await expect(failure).rejects.toBeInstanceOf(NativeModelPackError)
    await expect(failure).rejects.toMatchObject({ kind: 'integrity' })
    expect(existsSync(join(filesDir, 'onnx/model.onnx'))).toBe(false)
  })

  it('replaces a right-sized file whose content does not match the manifest', async () => {
    const pack = makePack()
    const filesDir = packModelDir(root, pack)
    mkdirSync(join(filesDir, 'onnx'), { recursive: true })
    const wrong = new Uint8Array(bodyB)
    wrong[3] ^= 0x55
    writeFileSync(join(filesDir, 'onnx/model.onnx'), wrong)
    writeFileSync(join(filesDir, 'config.json'), bodyA)
    const { fetchImpl, calls } = makeFakeFetch({ 'config.json': bodyA, 'onnx/model.onnx': bodyB })

    const { status } = await ensurePack(root, pack, { fetchImpl })
    expect(status.verified).toBe(true)
    // Only the corrupt file was re-fetched; the good one was hash-accepted.
    expect(calls.map((call) => call.url.split('/').pop())).toEqual(['model.onnx'])
  })
})

describe('readPackStatus', () => {
  it('reports missing and partial states with byte counts', async () => {
    const pack = makePack()
    const filesDir = packModelDir(root, pack)
    mkdirSync(join(filesDir, 'onnx'), { recursive: true })
    writeFileSync(join(filesDir, 'onnx/model.onnx.part'), bodyB.slice(0, 10))

    const status = await readPackStatus(root, pack)
    expect(status.installed).toBe(false)
    expect(status.verified).toBe(false)
    expect(status.files.find((file) => file.path === 'config.json')?.state).toBe('missing')
    const partial = status.files.find((file) => file.path === 'onnx/model.onnx')
    expect(partial?.state).toBe('partial')
    expect(partial?.bytes).toBe(10)
    expect(status.blockedReason).toBeNull()
  })
})
