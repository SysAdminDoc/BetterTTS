import { describe, expect, it } from 'vitest'
import {
  buildPortableOfflineModelPackArchive,
  createPortableOfflinePackManifest,
  importPortableOfflineModelPack,
  inspectPortableOfflineModelPack,
  resolvePortableEngine,
  sha256Hex,
  validatePortableOfflinePackManifest,
  type PortableOfflinePackManifest,
} from './offline-model-pack.ts'

const CREATED_AT = '2026-08-09T12:00:00.000Z'

async function createGenericManifest(): Promise<{ manifest: PortableOfflinePackManifest; bytes: Uint8Array }> {
  const resolution = resolvePortableEngine('supertonic')
  if (!resolution.model) throw new Error('Supertonic capability fixture is unavailable.')
  const bytes = new TextEncoder().encode('hello')
  const sourceUrl = `https://huggingface.co/onnx-community/Supertonic-TTS-ONNX/resolve/${resolution.model.revision}/config.json`
  return {
    manifest: {
      format: 'bettertts.offline-model-pack',
      schemaVersion: 1,
      packId: 'portable-supertonic-test',
      engineId: 'supertonic',
      modelId: resolution.model.modelId,
      revision: resolution.model.revision,
      sourceUrl: resolution.model.sourceUrl,
      license: { spdx: resolution.model.license.spdx, tier: resolution.model.license.tier, acknowledgedAt: CREATED_AT },
      createdAt: CREATED_AT,
      assets: [{
        path: 'config.json',
        sizeBytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        sourceUrl,
        cacheTargets: [],
      }],
    },
    bytes,
  }
}

describe('portable offline model packs', () => {
  it('hashes only the represented bytes of a typed-array view', async () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4])
    await expect(sha256Hex(backing.subarray(1, 4))).resolves.toBe(await sha256Hex(new Uint8Array([1, 2, 3])))
  })

  it('resolves only reviewed browser engines and model identities', () => {
    expect(resolvePortableEngine('supertonic')).toMatchObject({ supported: true, engine: { id: 'supertonic' }, model: { modelId: 'onnx-community/Supertonic-TTS-ONNX' } })
    expect(resolvePortableEngine('browser')).toMatchObject({ supported: false, reason: expect.stringContaining('device-managed') })
    expect(resolvePortableEngine('kitten')).toMatchObject({ supported: false, reason: expect.stringContaining('reviewed model identity') })
  })

  it('enforces explicit license confirmation before pack creation or import', async () => {
    await expect(createPortableOfflinePackManifest({
      engineId: 'supertonic',
      licenseAcknowledged: false,
      assets: [],
    })).rejects.toMatchObject({ code: 'license-required' })
    await expect(importPortableOfflineModelPack(new Uint8Array(), { licenseConfirmed: false })).rejects.toMatchObject({ code: 'license-required' })
  })

  it('validates capability metadata and round-trips an adapter-neutral archive', async () => {
    const { manifest, bytes } = await createGenericManifest()
    expect(validatePortableOfflinePackManifest(manifest, { requireCacheTargets: false })).toEqual([])
    expect(validatePortableOfflinePackManifest(manifest, { requireCacheTargets: true }).some((issue) => issue.code === 'invalid-target')).toBe(true)

    const archive = await buildPortableOfflineModelPackArchive(manifest, [{ path: 'config.json', bytes }], { requireCacheTargets: false })
    await expect(inspectPortableOfflineModelPack(archive, { requireCacheTargets: false })).resolves.toMatchObject({
      manifest: { packId: manifest.packId, revision: manifest.revision },
      assets: [{ path: 'config.json', bytes }],
    })
    await expect(inspectPortableOfflineModelPack(new Blob([archive.slice().buffer as ArrayBuffer]), { requireCacheTargets: false })).resolves.toMatchObject({ totalBytes: expect.any(Number) })
  })

  it('rejects bytes that do not match the declared digest before export', async () => {
    const { manifest } = await createGenericManifest()
    await expect(buildPortableOfflineModelPackArchive(manifest, [{ path: 'config.json', bytes: new TextEncoder().encode('tampered') }], { requireCacheTargets: false })).rejects.toMatchObject({ code: 'integrity-failed' })
  })
})
