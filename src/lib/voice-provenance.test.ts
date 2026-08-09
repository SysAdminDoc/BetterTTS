import { describe, expect, it } from 'vitest'
import {
  VOICE_PROVENANCE_SCHEMA_VERSION,
  createVoiceSourceRecord,
  normalizeVoiceSourceRecord,
  voiceSourceRequiresShareReview,
} from './voice-provenance.ts'

describe('voice source provenance', () => {
  it('classifies built-in and sidecar voices without inventing watermark claims', () => {
    expect(createVoiceSourceRecord({ source: 'built-in', sourceId: 'af_heart' })).toMatchObject({
      source: 'built-in',
      consent: { required: false, acknowledged: false },
      watermark: { status: 'not-applicable' },
    })
    expect(createVoiceSourceRecord({ source: 'sidecar', sourceId: 'Vivian' })).toMatchObject({
      source: 'sidecar',
      consent: { required: false, acknowledged: false },
      watermark: { status: 'unknown' },
    })
  })

  it('requires durable acknowledgement for user-supplied, cloned, and RVC sources', () => {
    expect(() => createVoiceSourceRecord({ source: 'user-supplied', sourceId: 'weights' })).toThrow(/acknowledgement/iu)
    const acknowledgedAt = '2026-08-09T12:00:00.000Z'
    for (const source of ['user-supplied', 'cloned', 'rvc'] as const) {
      expect(createVoiceSourceRecord({
        source,
        sourceId: `${source}-a`,
        consent: { required: true, acknowledged: true, acknowledgedAt },
        watermark: { status: 'unknown', note: 'No universal watermark claim.' },
      })).toMatchObject({ source, consent: { required: true, acknowledged: true, acknowledgedAt } })
    }
  })

  it('marks clone-derived output for review, including RVC output derived from a clone', () => {
    const clone = createVoiceSourceRecord({
      source: 'cloned',
      sourceId: 'reference-a',
      consent: { required: true, acknowledged: true, acknowledgedAt: '2026-08-09T12:00:00.000Z' },
      watermark: { status: 'retained', label: 'PerTh', modelId: 'chatterbox' },
    })
    expect(voiceSourceRequiresShareReview(clone)).toBe(true)
    expect(voiceSourceRequiresShareReview({
      source: 'rvc',
      derivedFrom: ['cloned'],
    })).toBe(true)
    expect(voiceSourceRequiresShareReview({ source: 'built-in' })).toBe(false)
  })

  it('migrates old or edited records to explicit unknown watermark state', () => {
    expect(normalizeVoiceSourceRecord({ source: 'sidecar', sourceId: 'speaker' })).toEqual({
      source: 'sidecar',
      sourceId: 'speaker',
      consent: { required: false, acknowledged: false },
      watermark: { status: 'unknown' },
    })
    expect(VOICE_PROVENANCE_SCHEMA_VERSION).toBe(1)
  })
})
