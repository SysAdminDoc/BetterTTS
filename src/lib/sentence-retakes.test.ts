import { describe, expect, it } from 'vitest'
import { replaceSentenceText, resampleMono, spliceCueAudio, spliceMonoAudio } from './sentence-retakes.ts'

describe('sentence retake audio splicing', () => {
  it('replaces a sentence while retaining smooth boundary samples and duration delta', () => {
    const original = Float32Array.from({ length: 20 }, (_, index) => index / 20)
    const replacement = Float32Array.from({ length: 10 }, () => 0.4)
    const result = spliceMonoAudio(original, replacement, 5, 15, 10, 100)

    expect(result.length).toBe(18)
    expect(result.slice(0, 4)).toEqual(original.slice(0, 4))
    expect(result[10]).toBeCloseTo(0.4)
    expect(result[result.length - 1]).toBeCloseTo(original[19])
    expect([...result].every(Number.isFinite)).toBe(true)
  })

  it('updates the selected cue, removes stale inner cues, and shifts later cues', () => {
    const cues = [
      { index: 1, startSec: 0, endSec: 1, text: 'Old sentence.' },
      { index: 2, startSec: 0.2, endSec: 0.5, text: 'Old word.' },
      { index: 3, startSec: 2, endSec: 3, text: 'Later sentence.' },
    ]
    const result = spliceCueAudio(
      new Float32Array(30),
      new Float32Array(20),
      cues,
      1,
      10,
      'New sentence.',
      0,
    )

    expect(result.samples.length).toBe(40)
    expect(result.cues).toEqual([
      { index: 1, startSec: 0, endSec: 2, text: 'New sentence.' },
      { index: 2, startSec: 3, endSec: 4, text: 'Later sentence.' },
    ])
  })

  it('resamples replacement audio when engine and stored audio rates differ', () => {
    const result = resampleMono(Float32Array.from([0, 1, 0]), 3, 6)
    expect(result.length).toBe(6)
    expect(result[0]).toBe(0)
    expect(result[1]).toBeCloseTo(0.5)
    expect(result[2]).toBeCloseTo(1)
    expect(result[5]).toBe(0)
  })

  it('rejects an empty splice range', () => {
    expect(() => spliceMonoAudio(new Float32Array(2), new Float32Array(1), 1, 1, 10)).toThrow('range is empty')
  })

  it('replaces the first matching sentence without changing unrelated text', () => {
    expect(replaceSentenceText('First. Second.', 'Second.', 'Updated.')).toBe('First. Updated.')
    expect(replaceSentenceText('First. SECOND.', 'second.', 'Updated.')).toBe('First. Updated.')
    expect(replaceSentenceText('First. Third.', 'Missing.', 'Updated.')).toBe('First. Third.')
  })
})
