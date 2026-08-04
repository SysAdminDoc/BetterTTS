import { describe, expect, it } from 'vitest'
import { encodeWav } from './wav.ts'
import { piper } from './kokoro-assets.ts'
import {
  PIPER_PLUS_MODEL_ID,
  PIPER_PLUS_PACKAGE_VERSION,
  piperAudioResultToSamples,
  piperLengthScaleFromSpeed,
  piperLocalModelUrl,
  piperPlusRuntimeSupport,
} from './piper-plus.ts'

describe('Piper-plus metadata and controls', () => {
  it('reports the experimental runtime as lazy-loaded', () => {
    const support = piperPlusRuntimeSupport()

    expect(support.packageVersion).toBe(PIPER_PLUS_PACKAGE_VERSION)
    expect(support.model).toBe(PIPER_PLUS_MODEL_ID)
    expect(support.defaultFirstLoad).toBe(false)
    expect(support.notes.join(' ')).toContain('lazy-loaded')
  })

  it('maps BetterTTS speed to Piper lengthScale', () => {
    expect(piperLengthScaleFromSpeed(0.25)).toBe(2)
    expect(piperLengthScaleFromSpeed(1)).toBe(1)
    expect(piperLengthScaleFromSpeed(1.5)).toBe(0.667)
    expect(piperLengthScaleFromSpeed(2)).toBe(0.667)
  })

  it('builds the same-origin Pages model URL used by deploy sync', () => {
    expect(piperLocalModelUrl()).toBe(
      'https://sysadmindoc.github.io/BetterTTS/models/ayousanz/piper-plus-tsukuyomi-chan/tsukuyomi-chan-6lang-fp16.onnx',
    )
  })

  it('uses an immutable Hugging Face revision for the runtime fallback', async () => {
    const remoteUrl = await piper()
    expect(remoteUrl).toBe(
      'https://huggingface.co/ayousanz/piper-plus-tsukuyomi-chan/resolve/36b59c825c36bd386b8960cf3f604382f52f2a87/tsukuyomi-chan-6lang-fp16.onnx',
    )
    expect(remoteUrl).toMatch(/resolve\/[a-f0-9]{40}\//)
  })
})

describe('Piper-plus audio result conversion', () => {
  it('uses direct Float32 samples when the package exposes them', async () => {
    const samples = new Float32Array([0, 0.5, -0.5])

    await expect(piperAudioResultToSamples({ samples, sampleRate: 22050 })).resolves.toEqual({
      samples,
      sampleRate: 22050,
    })
  })

  it('falls back to parsing a WAV Blob result', async () => {
    const source = new Float32Array([-1, 0, 1])
    const result = await piperAudioResultToSamples({
      toBlob: () => new Blob([encodeWav(source, 22050)], { type: 'audio/wav' }),
    })

    expect(result?.sampleRate).toBe(22050)
    expect(Array.from(result?.samples ?? []).map((sample) => Number(sample.toFixed(2)))).toEqual([-1, 0, 1])
  })
})
