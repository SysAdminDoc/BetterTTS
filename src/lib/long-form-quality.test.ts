import { describe, expect, it } from 'vitest'
import { dispatchGeneration } from './generation-dispatcher.ts'
import { LONG_FORM_QUALITY_FIXTURES } from './long-form-quality.fixtures.ts'
import { evaluateLongFormQuality, qualityReviewsForStorage, qualityWords } from './long-form-quality.ts'

function sineSamples(length: number, phase = 0): Float32Array {
  const samples = new Float32Array(length)
  for (let index = 0; index < length; index += 1) samples[index] = Math.sin((index + phase) * 0.17) * 0.2
  return samples
}

const qualityOptions = { enabled: true, repeatedTailWindowSeconds: 0.2 }

describe('long-form quality gates', () => {
  it('accepts a paragraph fixture with finite, uncapped waveform output', async () => {
    const text = LONG_FORM_QUALITY_FIXTURES.paragraph.text
    const result = await evaluateLongFormQuality({
      text,
      samples: sineSamples(400),
      sampleRate: 100,
      speed: 1,
    }, qualityOptions)

    expect(result.status).toBe('pass')
    expect(result.verification).toBe('not-requested')
    expect(result.issues).toEqual([])
  })

  it('flags empty, short, and clipped output', async () => {
    const empty = await evaluateLongFormQuality({
      text: LONG_FORM_QUALITY_FIXTURES.paragraph.text,
      samples: new Float32Array(),
      sampleRate: 100,
      speed: 1,
    }, qualityOptions)
    const clipped = await evaluateLongFormQuality({
      text: LONG_FORM_QUALITY_FIXTURES.paragraph.text,
      samples: Float32Array.from({ length: 40 }, () => 1),
      sampleRate: 100,
      speed: 1,
    }, qualityOptions)

    expect(empty.issues.map((issue) => issue.code)).toContain('empty-audio')
    expect(empty.issues.map((issue) => issue.code)).toContain('short-audio')
    expect(clipped.issues.map((issue) => issue.code)).toContain('clipped-output')
  })

  it('flags expected-duration and cue contract mismatches', async () => {
    const result = await evaluateLongFormQuality({
      text: 'A chapter cue should line up with its rendered audio.',
      samples: sineSamples(100),
      sampleRate: 100,
      speed: 1,
      expectedDurationSeconds: 2,
      cues: [{ startSec: 0, endSec: 1.4, text: 'A chapter cue' }],
    }, qualityOptions)

    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['duration-mismatch', 'cue-mismatch']))
  })

  it('detects a repeated tail, pronunciation mismatch, and alignment drift', async () => {
    const repeatedWindow = sineSamples(10)
    const samples = new Float32Array(60)
    samples.set(sineSamples(30), 0)
    samples.set(repeatedWindow, 30)
    samples.set(repeatedWindow, 40)
    samples.set(repeatedWindow, 50)
    const result = await evaluateLongFormQuality({
      text: LONG_FORM_QUALITY_FIXTURES.chapters[0].text,
      samples,
      sampleRate: 50,
      speed: 1,
      cues: [{ startSec: 0.8, endSec: 1, text: 'station' }],
    }, {
      ...qualityOptions,
      transcribe: async () => ({ text: 'unrelated words' }),
    })

    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['repeated-tail', 'pronunciation-failure', 'alignment-drift']))
    expect(result.verification).toBe('verified')
    expect(result.wordErrorRate).toBeGreaterThan(0.5)
  })

  it('reports unavailable optional verification without failing waveform checks', async () => {
    const result = await evaluateLongFormQuality({
      text: LONG_FORM_QUALITY_FIXTURES.paragraph.text,
      samples: sineSamples(400),
      sampleRate: 100,
      speed: 1,
    }, {
      ...qualityOptions,
      transcribe: async () => { throw new Error('Whisper runtime unavailable') },
    })

    expect(result.status).toBe('pass')
    expect(result.verification).toBe('unavailable')
    expect(result.verificationError).toBe('Whisper runtime unavailable')
  })

  it('stores bounded review metadata without source text', async () => {
    const assessment = await evaluateLongFormQuality({
      text: LONG_FORM_QUALITY_FIXTURES.paragraph.text,
      samples: new Float32Array(),
      sampleRate: 100,
      speed: 1,
    }, qualityOptions)
    const stored = qualityReviewsForStorage([{
      scope: 'segment',
      text: 'Do not persist this source text.',
      attempts: 2,
      issues: assessment.issues,
      durationSeconds: assessment.durationSeconds,
      verification: assessment.verification,
    }])

    expect(stored[0]).not.toHaveProperty('text')
    expect(stored[0]).toMatchObject({ scope: 'segment', attempts: 2, verification: 'not-requested' })
  })

  it('runs the multi-chapter fixture as independent quality jobs', async () => {
    const calls: string[] = []
    const result = await dispatchGeneration(LONG_FORM_QUALITY_FIXTURES.chapters.map((chapter) => ({ text: chapter.text, voice: 'voice' })), {
      sampleRate: 100,
      speed: 1,
      requestStart: performance.now(),
      qualityGate: qualityOptions,
      synthesize: async (text) => {
        calls.push(text)
        return { samples: sineSamples(300, calls.length * 10), sampleRate: 100 }
      },
    })

    expect(result.jobs).toHaveLength(2)
    expect(result.jobs.every((job) => job.needsReview.length === 0)).toBe(true)
    expect(result.needsReview).toEqual([])
    expect(qualityWords(LONG_FORM_QUALITY_FIXTURES.chapters[0].text).length).toBeGreaterThan(10)
  })

  it('retries a failed segment once and keeps the final clean take', async () => {
    let calls = 0
    const result = await dispatchGeneration([{ text: LONG_FORM_QUALITY_FIXTURES.paragraph.text, voice: 'voice' }], {
      sampleRate: 100,
      speed: 1,
      requestStart: performance.now(),
      qualityGate: { ...qualityOptions, maxRetries: 1 },
      synthesize: async () => {
        calls += 1
        return { samples: calls === 1 ? new Float32Array(4) : sineSamples(400), sampleRate: 100 }
      },
    })

    expect(calls).toBe(2)
    expect(result.needsReview).toEqual([])
    expect(result.jobs[0].audioParts[0].length).toBe(400)
  })

  it('returns a segment-level needs-review outcome after bounded retries', async () => {
    const result = await dispatchGeneration([{ text: LONG_FORM_QUALITY_FIXTURES.paragraph.text, voice: 'voice' }], {
      sampleRate: 100,
      speed: 1,
      requestStart: performance.now(),
      qualityGate: { ...qualityOptions, maxRetries: 1 },
      synthesize: async () => null,
    })

    expect(result.needsReview).toHaveLength(2)
    expect(result.needsReview[0]).toMatchObject({ scope: 'segment', attempts: 2 })
    expect(result.needsReview[0].issues.map((issue) => issue.code)).toContain('empty-audio')
  })
})
