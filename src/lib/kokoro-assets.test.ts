import { describe, expect, it } from 'vitest'
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

  it('honors rate-limit retry headers with bounded delays', () => {
    const retryAfter = new Headers({ 'retry-after': '3' })
    const rateLimit = new Headers({ ratelimit: '"resolvers";r=0;t=7' })

    expect(rateLimitRetryDelayMs(retryAfter, 0)).toBe(3000)
    expect(rateLimitRetryDelayMs(rateLimit, 0)).toBe(7000)
  })
})
