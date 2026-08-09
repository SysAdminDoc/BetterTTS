import { describe, expect, it } from 'vitest'
import { SUPERTONIC_VOICES, clampSupertonicSpeed, clampSupertonicSteps, supertonicVoiceUrl } from './supertonic.ts'

describe('supertonic metadata', () => {
  it('lists the ten hosted English voices', () => {
    expect(SUPERTONIC_VOICES.map((voice) => voice.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'])
  })

  it('builds the speaker embedding URL expected by Transformers.js', () => {
    expect(supertonicVoiceUrl('F1')).toBe('https://huggingface.co/onnx-community/Supertonic-TTS-ONNX/resolve/cff123c84b0655d9d647641f1b532c3cbb8f7faa/voices/F1.bin')
  })

  it('keeps Supertonic controls in the documented operating range', () => {
    expect(clampSupertonicSpeed(0.5)).toBe(0.8)
    expect(clampSupertonicSpeed(1.5)).toBe(1.2)
    expect(clampSupertonicSteps(0)).toBe(1)
    expect(clampSupertonicSteps(12)).toBe(10)
  })
})
