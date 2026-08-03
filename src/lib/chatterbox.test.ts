import { describe, expect, it } from 'vitest'
import {
  CHATTERBOX_LANGUAGES,
  CHATTERBOX_MAX_REFERENCE_SECONDS,
  CHATTERBOX_MIN_REFERENCE_SECONDS,
  chatterboxModelId,
  chatterboxPrompt,
  clampChatterboxExaggeration,
  resampleMonoAudio,
  validateChatterboxReference,
} from './chatterbox.ts'

describe('Chatterbox helpers', () => {
  it('exposes the full multilingual language set and prefixes prompts', () => {
    expect(CHATTERBOX_LANGUAGES).toHaveLength(23)
    expect(chatterboxPrompt('hello', 'multilingual', 'fr')).toBe('[fr] hello')
    expect(chatterboxPrompt('hello', 'english', 'en')).toBe('hello')
    expect(chatterboxModelId('english')).toBe('onnx-community/chatterbox-ONNX')
    expect(chatterboxModelId('multilingual')).toBe('onnx-community/chatterbox-multilingual-ONNX')
  })

  it('clamps the emotion exaggeration control and rejects unsafe references', () => {
    expect(clampChatterboxExaggeration(-1)).toBe(0)
    expect(clampChatterboxExaggeration(3)).toBe(2)
    expect(validateChatterboxReference(new Float32Array(6000))).toContain(`${CHATTERBOX_MIN_REFERENCE_SECONDS}`)
    expect(validateChatterboxReference(new Float32Array(31 * 24000))).toContain(`${CHATTERBOX_MAX_REFERENCE_SECONDS}`)
    expect(validateChatterboxReference(new Float32Array(24000))).toBeNull()
  })

  it('resamples reference audio without mutating the source', () => {
    const source = new Float32Array([0, 1, 0, -1])
    const output = resampleMonoAudio(source, 4, 2)
    expect([...output]).toEqual([0, 0])
    expect([...source]).toEqual([0, 1, 0, -1])
  })
})
