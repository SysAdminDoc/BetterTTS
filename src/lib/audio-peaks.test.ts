import { describe, expect, it } from 'vitest'
import { MAX_WAVEFORM_BINS, buildPeakEnvelope } from './audio-peaks.ts'

describe('bounded output waveform peaks', () => {
  it('returns one bounded peak per requested bin', () => {
    const samples = new Float32Array(1000)
    samples[12] = -2
    samples[712] = 0.5

    const peaks = buildPeakEnvelope(samples, 24)

    expect(peaks).toHaveLength(24)
    expect(peaks.every((peak) => peak >= 0 && peak <= 1)).toBe(true)
    expect(peaks.some((peak) => peak === 1)).toBe(true)
    expect(peaks.some((peak) => peak === 0.5)).toBe(true)
  })

  it('never allocates more than the waveform cap', () => {
    expect(buildPeakEnvelope(new Float32Array([0, 1]), MAX_WAVEFORM_BINS + 1000)).toHaveLength(MAX_WAVEFORM_BINS)
    expect(buildPeakEnvelope(new Float32Array(), 12)).toEqual([])
  })

  it('ignores non-finite samples instead of contaminating the envelope', () => {
    expect(buildPeakEnvelope([Number.NaN, Number.POSITIVE_INFINITY, 0.25], 1)).toEqual([0.25])
  })
})
