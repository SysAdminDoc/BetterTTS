import { describe, expect, it } from 'vitest'
import {
  countEnglishWords,
  countWordTokens,
  cropTimestampedKokoroAudio,
  isShortKokoroInput,
  joinWordTimestamps,
  padShortInput,
  shouldPadShortInput,
  synthesizeTimestampedKokoro,
  timestampTokensToPhonemes,
  type TimestampToken,
} from './kokoro-timestamps.ts'

describe('timestampTokensToPhonemes', () => {
  it('joins token phonemes with explicit whitespace markers', () => {
    const tokens: TimestampToken[] = [
      { text: 'Hello', phonemes: 'həlˈoʊ', whitespace: true, kind: 'word' },
      { text: 'world', phonemes: 'wˈɜːld', whitespace: false, kind: 'word' },
      { text: '.', phonemes: '.', whitespace: false, kind: 'punctuation' },
    ]

    expect(timestampTokensToPhonemes(tokens)).toBe('həlˈoʊ wˈɜːld.')
  })
})

describe('joinWordTimestamps', () => {
  it('maps duration frames to word cues and consumes punctuation timing', () => {
    const tokens: TimestampToken[] = [
      { text: 'Hello', phonemes: 'abc', whitespace: true, kind: 'word' },
      { text: 'world', phonemes: 'de', whitespace: false, kind: 'word' },
      { text: '.', phonemes: '.', whitespace: false, kind: 'punctuation' },
    ]
    const cues = joinWordTimestamps(tokens, [
      3,
      4, 4, 4, 2,
      5, 5,
      1,
      0,
    ])

    expect(cues).toEqual([
      { startSec: 0, endSec: 0.325, text: 'Hello' },
      { startSec: 0.325, endSec: 0.6, text: 'world' },
    ])
  })

  it('returns no cues when duration output is too short to align', () => {
    const tokens: TimestampToken[] = [{ text: 'Hi', phonemes: 'haɪ', whitespace: false, kind: 'word' }]

    expect(joinWordTimestamps(tokens, [1, 2])).toEqual([])
  })
})

describe('short-input padding and crop', () => {
  it('pads one-to-four-word inputs while leaving longer text alone', () => {
    expect(countEnglishWords('six')).toBe(1)
    expect(isShortKokoroInput('one two three four')).toBe(true)
    expect(isShortKokoroInput('one two three four five')).toBe(false)
    expect(padShortInput('six')).toBe('Please say six clearly.')
  })

  it('crops fixture audio to the target cue and rebases its timing', () => {
    const tokens: TimestampToken[] = [
      { text: 'Please', phonemes: 'abc', whitespace: true, kind: 'word' },
      { text: 'say', phonemes: 'de', whitespace: true, kind: 'word' },
      { text: 'six', phonemes: 'f', whitespace: true, kind: 'word' },
      { text: 'clearly', phonemes: 'gh', whitespace: false, kind: 'word' },
    ]
    expect(countWordTokens(tokens)).toBe(4)
    expect(shouldPadShortInput(tokens)).toBe(true)

    const output = cropTimestampedKokoroAudio({
      samples: Float32Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]),
      sampleRate: 10,
      wordCues: [
        { startSec: 0.2, endSec: 0.4, text: 'six' },
      ],
    }, [{ startSec: 0.2, endSec: 0.4, text: 'six' }])

    expect(output.samples).toEqual(Float32Array.from([7, 6]))
    expect(output.wordCues).toEqual([{ startSec: 0, endSec: 0.2, text: 'six' }])
  })

  it('synthesizes a padded fixture and returns only the source word', async () => {
    const fixture = Float32Array.from({ length: 48_000 }, (_, index) => index % 97)
    let modelCalls = 0
    const tts = {
      tokenizer: (input: string) => ({ input_ids: { dims: [1, input.length] } }),
      model: async () => {
        modelCalls += 1
        return {
          waveform: { data: fixture },
          pred_dur: { data: new Float32Array(4096).fill(1) },
        }
      },
    } as unknown as Parameters<typeof synthesizeTimestampedKokoro>[0]

    const output = await synthesizeTimestampedKokoro(tts, 'six', 'af_heart', 1, new Float32Array(256 * 512))

    expect(modelCalls).toBe(1)
    expect(output).not.toBeNull()
    expect(output?.sampleRate).toBe(24_000)
    expect(output?.samples.length).toBeLessThan(fixture.length)
    expect(output?.wordCues).toHaveLength(1)
    expect(output?.wordCues[0]?.text).toBe('six')
    expect(output?.wordCues[0]?.startSec).toBeGreaterThanOrEqual(0)
    expect(output?.wordCues[0]?.startSec).toBeLessThan(1 / 24_000)
  })
})
