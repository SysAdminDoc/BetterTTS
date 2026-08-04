import { describe, expect, it } from 'vitest'
import modelAssets from './model-assets.json'
import { kokoroAssetIntegrity, verifyKokoroAssetBytes, verifyKokoro } from './kokoro-integrity.ts'
import {
  isSelfHostedKokoroAsset,
  kokoroLocalAssetUrl,
  kokoroRemoteAssetPath,
  kokoroRemoteAssetUrl,
  rateLimitRetryDelayMs,
} from './kokoro-assets.ts'

describe('kokoro asset routing', () => {
  it('maps supported Hugging Face assets to same-origin Pages URLs', () => {
    const remote = kokoroRemoteAssetUrl('onnx/model_quantized.onnx')

    expect(kokoroRemoteAssetPath(remote)).toBe('onnx/model_quantized.onnx')
    expect(isSelfHostedKokoroAsset('onnx/model_quantized.onnx')).toBe(true)
    expect(kokoroLocalAssetUrl('onnx/model_quantized.onnx', '/BetterTTS/')).toBe(
      'https://sysadmindoc.github.io/BetterTTS/models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx',
    )
  })

  it('keeps fp32 WebGPU assets remote-only', () => {
    expect(isSelfHostedKokoroAsset('onnx/model.onnx')).toBe(false)
  })

  it('self-hosts the wired English voice bins', () => {
    expect(isSelfHostedKokoroAsset('voices/af_heart.bin')).toBe(true)
    expect(isSelfHostedKokoroAsset('voices/ff_siwis.bin')).toBe(false)
  })

  it('ships immutable size and SHA-256 metadata for every self-hosted asset', () => {
    expect(modelAssets.kokoro.remoteAssets).toHaveLength(4)
    expect(modelAssets.kokoro.remoteAssets.every((asset) => asset.size > 0 && /^[a-f0-9]{64}$/.test(asset.sha256))).toBe(true)
  })

  it('loads voice-bin digests lazily with the integrity manifest', async () => {
    await expect(kokoroAssetIntegrity('voices/af_heart.bin')).resolves.toMatchObject({ size: 522240, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
  })

  it('verifies response bytes and rejects poisoned payloads', async () => {
    const bytes = new TextEncoder().encode('known test payload')
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
    const expected = { size: bytes.byteLength, sha256 }

    await expect(verifyKokoroAssetBytes('test.bin', bytes, expected)).resolves.toBeUndefined()
    await expect(verifyKokoroAssetBytes('test.bin', new Uint8Array(bytes.length).fill(0), expected)).rejects.toThrow('checksum mismatch')
    await expect(verifyKokoro('config.json', new Response('<html>'))).rejects.toThrow('size mismatch')
  })

  it('honors rate-limit retry headers with bounded delays', () => {
    const retryAfter = new Headers({ 'retry-after': '3' })
    const rateLimit = new Headers({ ratelimit: '"resolvers";r=0;t=7' })

    expect(rateLimitRetryDelayMs(retryAfter, 0)).toBe(3000)
    expect(rateLimitRetryDelayMs(rateLimit, 0)).toBe(7000)
  })
})
