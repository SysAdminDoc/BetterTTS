import { describe, expect, it } from 'vitest'
import {
  MAX_WHISPER_AUDIO_SECONDS,
  WHISPER_MODEL_FILENAME,
  WHISPER_SAMPLE_RATE,
  cuesFromWhisperWords,
  formatWhisperRuntimeRecovery,
  parseWhisperJson,
  resampleMonoAudio,
} from './whisper.ts'

describe('whisper.cpp caption parsing', () => {
  it('turns whisper word segments into indexed word cues and keeps language metadata', () => {
    const result = parseWhisperJson({
      result: { language: 'es' },
      transcription: [
        { offsets: { from: 125, to: 620 }, text: ' Hola' },
        { offsets: { from: 620, to: 1010 }, text: ' mundo' },
        { offsets: { from: 1010, to: 1100 }, text: '.' },
      ],
    })

    expect(result.language).toBe('es')
    expect(result.words).toEqual([
      { startSec: 0.125, endSec: 0.62, text: 'Hola' },
      { startSec: 0.62, endSec: 1.1, text: 'mundo.' },
    ])
    expect(result.cues[0]).toEqual({ index: 1, startSec: 0.125, endSec: 0.62, text: 'Hola' })
    expect(result.cues[1].index).toBe(2)
  })

  it('splits a fallback multiword segment into word-level cues', () => {
    const result = parseWhisperJson({
      transcription: [{ timestamps: { from: '00:00:01,000', to: '00:00:03,000' }, text: ' bonjour le monde' }],
    }, 'fr')
    expect(result.words.map((word) => word.text)).toEqual(['bonjour', 'le', 'monde'])
    expect(result.words[0].startSec).toBe(1)
    expect(result.words[2].endSec).toBe(3)
  })

  it('returns an empty alignment for silence and rejects malformed payloads', () => {
    expect(parseWhisperJson({ result: { language: 'de' }, transcription: [] }).cues).toEqual([])
    expect(() => parseWhisperJson('not-json')).toThrow(/invalid JSON object/i)
  })

  it('clamps cue indexes from arbitrary word input', () => {
    expect(cuesFromWhisperWords([
      { startSec: -1, endSec: 0.5, text: 'one' },
      { startSec: 0.5, endSec: 0.4, text: 'bad' },
      { startSec: 0.5, endSec: 1, text: 'two' },
    ])).toEqual([
      { index: 1, startSec: 0, endSec: 0.5, text: 'one' },
      { index: 2, startSec: 0.5, endSec: 1, text: 'two' },
    ])
  })
})

describe('whisper audio preparation', () => {
  it('downmixes and resamples without mutating source channels', () => {
    const left = new Float32Array([0, 1, 0, -1])
    const right = new Float32Array([0, 0, 1, 0])
    const copy = Array.from(left)
    const output = resampleMonoAudio([left, right], 4, 2)
    expect(output.length).toBe(2)
    expect(Array.from(left)).toEqual(copy)
    expect(WHISPER_SAMPLE_RATE).toBe(16_000)
    expect(MAX_WHISPER_AUDIO_SECONDS).toBe(1800)
  })
})

describe('whisper runtime guidance', () => {
  it('names both recovery paths when the optional desktop assets are missing', () => {
    const message = formatWhisperRuntimeRecovery({})
    expect(message).toContain('whisper.cpp')
    expect(message).toContain(WHISPER_MODEL_FILENAME)
    expect(message).toContain('BETTERTTS_WHISPER_MODEL')
  })
})
