import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertAssetMetadata } from './model-integrity.mjs'
import { KOKORO_REMOTE_ASSETS, KOKORO_VOICE_ASSETS, KOKORO_MODEL_REVISION } from './sync-kokoro-assets.mjs'
import { PIPER_MODEL_REVISION, PIPER_REMOTE_ASSETS } from './sync-piper-assets.mjs'

const manifest = JSON.parse(readFileSync('src/lib/model-assets.json', 'utf8'))

describe('model asset integrity manifest', () => {
  it('pins every sync asset to an immutable revision and SHA-256', () => {
    const assets = [...KOKORO_REMOTE_ASSETS, ...KOKORO_VOICE_ASSETS, ...PIPER_REMOTE_ASSETS]

    expect(KOKORO_MODEL_REVISION).toMatch(/^[a-f0-9]{40}$/)
    expect(PIPER_MODEL_REVISION).toMatch(/^[a-f0-9]{40}$/)
    expect(new Set(KOKORO_REMOTE_ASSETS.map((asset) => asset.path)).size).toBe(KOKORO_REMOTE_ASSETS.length)
    expect(new Set(KOKORO_VOICE_ASSETS.map((asset) => asset.path)).size).toBe(KOKORO_VOICE_ASSETS.length)
    expect(new Set(PIPER_REMOTE_ASSETS.map((asset) => asset.path)).size).toBe(PIPER_REMOTE_ASSETS.length)
    for (const asset of assets) {
      expect(() => assertAssetMetadata(asset)).not.toThrow()
    }
  })

  it('keeps the manifest source-of-truth aligned with both sync adapters', () => {
    expect(KOKORO_REMOTE_ASSETS).toEqual(manifest.kokoro.remoteAssets)
    expect(KOKORO_VOICE_ASSETS).toEqual(manifest.kokoro.voiceAssets)
    expect(PIPER_REMOTE_ASSETS).toEqual([manifest.piper.onnx, manifest.piper.config])
  })

  it('rejects mutable revisions and malformed digests', () => {
    expect(() => assertAssetMetadata({ path: 'model.onnx', size: 1, sha256: 'a'.repeat(64) })).not.toThrow()
    expect(() => assertAssetMetadata({ path: 'model.onnx', size: 1, sha256: 'a'.repeat(63) })).toThrow('Invalid SHA-256')
    expect(() => assertAssetMetadata({ path: '../model.onnx', size: 1, sha256: 'a'.repeat(64) })).toThrow('Invalid model asset path')
  })
})
