import { describe, expect, it } from 'vitest'
import {
  assembleSubtitleTimeline,
  fitAudioToCue,
  parseSubtitleText,
  type Cue,
  subtitleTextForSpeech,
  toSRT,
  toVTT,
} from './subtitles.ts'

const CUES: Cue[] = [
  { index: 1, startSec: 0, endSec: 2.5, text: 'Hello world.' },
  { index: 2, startSec: 2.5, endSec: 5.123, text: 'Second sentence.' },
]

describe('toSRT', () => {
  it('formats cues with comma-separated milliseconds', () => {
    const srt = toSRT(CUES)
    expect(srt).toContain('00:00:00,000 --> 00:00:02,500')
    expect(srt).toContain('00:00:02,500 --> 00:00:05,123')
    expect(srt).toContain('Hello world.')
    expect(srt).toContain('Second sentence.')
  })

  it('includes cue index numbers', () => {
    const srt = toSRT(CUES)
    expect(srt).toMatch(/^1\n/)
    expect(srt).toContain('\n\n2\n')
  })
})

describe('toVTT', () => {
  it('starts with WEBVTT header', () => {
    const vtt = toVTT(CUES)
    expect(vtt).toMatch(/^WEBVTT\n/)
  })

  it('uses dot-separated milliseconds', () => {
    const vtt = toVTT(CUES)
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.500')
  })
})

describe('timestamp edge cases', () => {
  it('never emits a 4-digit millisecond field when the fraction rounds up', () => {
    const cues: Cue[] = [{ index: 1, startSec: 1.9995, endSec: 59.9999, text: 'Edge.' }]
    const srt = toSRT(cues)
    expect(srt).toContain('00:00:02,000 --> 00:01:00,000')
    expect(srt).not.toMatch(/,\d{4}/)
  })

  it('handles negative-adjacent zero without underflow', () => {
    const srt = toSRT([{ index: 1, startSec: 0, endSec: 0.0004, text: 'Tiny.' }])
    expect(srt).toContain('00:00:00,000 --> 00:00:00,000')
  })

  it('collapses blank lines inside cue text so blocks are not terminated early', () => {
    const srt = toSRT([{ index: 1, startSec: 0, endSec: 1, text: 'Para one\n\nPara two' }])
    expect(srt).toContain('Para one\nPara two')
    expect(srt).not.toContain('\n\n\n')
    const blocks = srt.split('\n\n')
    expect(blocks.length).toBe(1)
  })
})

describe('subtitle parsing', () => {
  it('parses SRT identifiers, multiline text, and malformed blocks with warnings', () => {
    const parsed = parseSubtitleText(`\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nHello <i>world</i>.\r\n\r\ninvalid block\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nSecond\r\nline.`)
    expect(parsed.format).toBe('srt')
    expect(parsed.cues).toEqual([
      { index: 1, startSec: 1, endSec: 2.5, text: 'Hello <i>world</i>.' },
      { index: 2, startSec: 3, endSec: 4, text: 'Second\nline.' },
    ])
    expect(parsed.warnings).toHaveLength(1)
  })

  it('parses VTT cue identifiers, cue settings, and short timestamps', () => {
    const parsed = parseSubtitleText('WEBVTT\n\nintro\n00:01.250 --> 00:03.000 align:start\n<v Narrator>Hello &amp; welcome.</v>')
    expect(parsed.format).toBe('vtt')
    expect(parsed.cues).toEqual([{ index: 1, startSec: 1.25, endSec: 3, text: '<v Narrator>Hello &amp; welcome.</v>' }])
    expect(subtitleTextForSpeech(parsed.cues[0].text)).toBe('Hello & welcome.')
  })

  it('rejects input with no valid cues', () => {
    expect(() => parseSubtitleText('1\n00:00:02,000 --> 00:00:01,000\nBackwards')).toThrow('No valid SRT cues found')
  })
})

describe('subtitle timing fit', () => {
  it('pads short audio to the cue window without changing the onset', () => {
    const result = fitAudioToCue(new Float32Array([0.25, 0.5]), 2, 2, 2, 4)
    expect(result.mode).toBe('padded')
    expect(result.samples).toHaveLength(4)
    expect(Array.from(result.samples)).toEqual([0.25, 0.5, 0, 0])
  })

  it('compresses a cue that is only moderately longer than its window', () => {
    const result = fitAudioToCue(new Float32Array([0, 1, 0, -1, 0]), 5, 5, 0.8, 2)
    expect(result.mode).toBe('compressed')
    expect(result.samples).toHaveLength(4)
    expect(result.warning).toBeUndefined()
  })

  it('clips an audio segment that cannot fit and returns a warning', () => {
    const result = fitAudioToCue(new Float32Array(20), 10, 10, 0.5, 7)
    expect(result.mode).toBe('trimmed')
    expect(result.samples).toHaveLength(5)
    expect(result.warning).toContain('Cue 7 audio')
  })

  it('places cues on the absolute timeline, mixes overlaps, and preserves trailing duration', () => {
    const result = assembleSubtitleTimeline([
      { cue: { index: 2, startSec: 1, endSec: 2, text: 'later' }, samples: new Float32Array([0.5, 0.5]), sampleRate: 2 },
      { cue: { index: 1, startSec: 0, endSec: 1.5, text: 'first' }, samples: new Float32Array([0.25, 0.25, 0.25]), sampleRate: 2 },
    ], 2)
    expect(result.durationSec).toBe(2)
    expect(result.samples).toHaveLength(4)
    expect(Array.from(result.samples)).toEqual([0.25, 0.25, 0.75, 0.5])
    expect(result.warnings).toContain('Cue 2 overlaps an earlier cue; overlapping audio was mixed.')
  })
})
