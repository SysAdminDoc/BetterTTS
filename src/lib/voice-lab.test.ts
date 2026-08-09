import { describe, expect, it } from 'vitest'
import {
  assertVoiceLabModelAllowed,
  chatterboxVoiceLabModel,
  createVoiceProvenance,
  migrateVoiceProvenance,
  type VoiceLabModel,
} from './voice-lab.ts'

describe('voice lab policy', () => {
  it('describes both Chatterbox variants as permissive reference-voice engines', () => {
    expect(chatterboxVoiceLabModel('english')).toMatchObject({
      id: 'onnx-community/chatterbox-ONNX',
      referenceVoice: true,
      license: { spdx: 'MIT', tier: 'permissive' },
    })
    expect(chatterboxVoiceLabModel('multilingual')).toMatchObject({
      id: 'onnx-community/chatterbox-multilingual-ONNX',
      referenceVoice: true,
      license: { spdx: 'MIT', tier: 'permissive' },
    })
  })

  it('blocks restricted and non-commercial models from the default lab', () => {
    const restricted: VoiceLabModel = {
      id: 'restricted-voice',
      label: 'Restricted voice',
      license: { spdx: 'LicenseRef-Research', tier: 'restricted' },
      referenceVoice: true,
    }
    const nonCommercial: VoiceLabModel = {
      ...restricted,
      id: 'research-voice',
      label: 'Research voice',
      license: { spdx: 'LicenseRef-NonCommercial', tier: 'non-commercial' },
    }
    expect(() => assertVoiceLabModelAllowed(restricted)).toThrow(/blocked from the default voice lab/)
    expect(() => assertVoiceLabModelAllowed(nonCommercial)).toThrow(/blocked from the default voice lab/)
  })

  it('creates bounded local provenance only with an acknowledgement', () => {
    const provenance = createVoiceProvenance({
      referenceId: 'reference-a',
      referenceName: 'speaker.wav',
      referenceDurationSeconds: 4.25,
      acknowledgedAt: '2026-08-03T12:00:00.000Z',
      model: chatterboxVoiceLabModel('english'),
    })
    expect(provenance).toEqual({
      kind: 'reference-voice',
      source: 'cloned',
      referenceId: 'reference-a',
      referenceName: 'speaker.wav',
      referenceDurationSeconds: 4.25,
      acknowledgedAt: '2026-08-03T12:00:00.000Z',
      modelId: 'onnx-community/chatterbox-ONNX',
      modelLabel: 'Chatterbox English',
      modelLicenseSpdx: 'MIT',
      modelLicenseTier: 'permissive',
      consent: {
        required: true,
        acknowledged: true,
        acknowledgedAt: '2026-08-03T12:00:00.000Z',
      },
      watermark: {
        status: 'retained',
        label: 'PerTh',
        modelId: 'onnx-community/chatterbox-ONNX',
        note: 'Chatterbox model-specific watermark retained; this status does not apply to other voice models.',
      },
    })
    expect(() => createVoiceProvenance({
      referenceId: 'reference-a',
      referenceName: 'speaker.wav',
      referenceDurationSeconds: 4.25,
      model: chatterboxVoiceLabModel('english'),
    })).toThrow(/consent acknowledgement/)
  })

  it('fails closed when stored provenance is tampered with', () => {
    const valid = createVoiceProvenance({
      referenceId: 'reference-a',
      referenceName: 'speaker.wav',
      referenceDurationSeconds: 4.25,
      acknowledgedAt: '2026-08-03T12:00:00.000Z',
      model: chatterboxVoiceLabModel('multilingual'),
    })
    expect(migrateVoiceProvenance(valid)).toEqual(valid)
    expect(migrateVoiceProvenance({ ...valid, modelLicenseTier: 'restricted' })).toBeNull()
    expect(migrateVoiceProvenance({ ...valid, referenceDurationSeconds: 0.1 })).toBeNull()
  })
})
