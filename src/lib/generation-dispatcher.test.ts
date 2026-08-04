import { describe, expect, it } from 'vitest'
import { dispatchGeneration } from './generation-dispatcher.ts'

const audio = (samples = 4) => ({ samples: new Float32Array(samples), sampleRate: 10 })

describe('generation dispatcher', () => {
  it('keeps pauses, offsets word cues, and reports progress', async () => {
    const progress: Array<[number, number]> = []
    const result = await dispatchGeneration([
      { text: 'Hello. [pause 0.2s] World.', voice: 'voice' },
    ], {
      sampleRate: 10,
      speed: 1,
      requestStart: performance.now(),
      synthesize: async (text) => text.startsWith('Hello')
        ? { ...audio(), wordCues: [{ startSec: 0.1, endSec: 0.2, text: 'Hello' }] }
        : { ...audio(6), wordCues: [{ startSec: 0, endSec: 0.3, text: 'World' }] },
      onProgress: (done, total) => progress.push([done, total]),
    })

    expect(result.cancelled).toBe(false)
    expect(result.jobs[0].audioParts).toHaveLength(3)
    expect(result.jobs[0].cues).toHaveLength(2)
    expect(result.jobs[0].cues[0]).toEqual({ startSec: 0.1, endSec: 0.2, text: 'Hello' })
    expect(result.jobs[0].cues[1].startSec).toBeCloseTo(0.6)
    expect(result.jobs[0].cues[1].endSec).toBeCloseTo(0.9)
    expect(result.totalSamples).toBe(12)
    expect(progress).toEqual([[1, 2], [2, 2]])
  })

  it('flags missing audio without marking the run complete', async () => {
    const missing: string[] = []
    const result = await dispatchGeneration([{ text: 'Dropped sentence.', voice: 'voice' }], {
      sampleRate: 10,
      speed: 1,
      requestStart: performance.now(),
      synthesize: async () => null,
      onMissingAudio: (text) => missing.push(text),
    })

    expect(result.jobs[0].audioParts).toEqual([])
    expect(result.flaggedSentences).toBe(1)
    expect(missing).toEqual(['Dropped sentence.'])
  })

  it('stops before the next sentence when cancellation is requested', async () => {
    let calls = 0
    const result = await dispatchGeneration([{ text: 'First. Second.', voice: 'voice' }], {
      sampleRate: 10,
      speed: 1,
      requestStart: performance.now(),
      isCancelled: () => calls > 0,
      synthesize: async () => {
        calls += 1
        return audio()
      },
    })

    expect(calls).toBe(1)
    expect(result.cancelled).toBe(true)
    expect(result.completedSentences).toBe(1)
    expect(result.jobs[0].audioParts).toHaveLength(1)
  })

  it('applies span rate to synthesis and passes pitch to post-processing', async () => {
    const speeds: number[] = []
    const prosody: Array<{ rate: number; pitchSemitones: number }> = []
    const result = await dispatchGeneration([{
      text: 'Plain. [prosody rate=1.5 pitch=2]Emphasis.[/prosody]',
      voice: 'voice',
    }], {
      sampleRate: 10,
      speed: 1,
      requestStart: performance.now(),
      synthesize: async (_text, _voice, speed) => {
        speeds.push(speed)
        return audio()
      },
      processAudio: (current, settings) => {
        prosody.push(settings)
        return current
      },
    })

    expect(result.totalSentences).toBe(2)
    expect(speeds).toEqual([1, 1.5])
    expect(prosody).toEqual([
      { rate: 1, pitchSemitones: 0 },
      { rate: 1.5, pitchSemitones: 2 },
    ])
    expect(result.jobs[0].cues.map((cue) => cue.text)).toEqual(['Plain.', 'Emphasis.'])
  })

  it('keeps pauses inside a prosody span from exposing its markup', async () => {
    const spoken: string[] = []
    const result = await dispatchGeneration([{
      text: '[prosody rate=1.25 pitch=-2]Marked [pause 0.2s] phrase.[/prosody]',
      voice: 'voice',
    }], {
      sampleRate: 10,
      speed: 1,
      requestStart: performance.now(),
      synthesize: async (text) => {
        spoken.push(text)
        return audio()
      },
    })

    expect(spoken).toEqual(['Marked', 'phrase.'])
    expect(result.jobs[0].audioParts).toHaveLength(3)
  })
})
