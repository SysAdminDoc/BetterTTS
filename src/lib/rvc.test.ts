import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RVC_SETTINGS,
  MAX_RVC_MODELS,
  blendRvcSamples,
  createRvcClipProvenance,
  createRvcModelRecord,
  normalizeRvcSettings,
  parseRvcConsent,
  parseRvcModelRecords,
  resolveRvcInferencePlan,
  serializeRvcModelRecords,
  serializeRvcSettings,
} from './rvc.ts'

const first = createRvcModelRecord({
  modelName: 'Voice A',
  modelPath: 'C:\\Models\\voice-a.pth',
  indexPath: 'C:\\Models\\voice-a.index',
  license: 'MIT',
  provenance: 'Local model owned by the operator.',
  sourceUrl: 'https://example.test/voice-a',
}, '2026-08-03T12:00:00.000Z')
const second = createRvcModelRecord({
  modelName: 'Voice B',
  modelPath: 'C:\\Models\\voice-b.pth',
  license: 'CC-BY-4.0',
  provenance: 'Downloaded from a reviewed release.',
}, '2026-08-03T12:00:00.000Z')

describe('RVC model metadata', () => {
  it('round-trips model and optional index paths with provenance', () => {
    expect(parseRvcModelRecords(serializeRvcModelRecords([first, second]))).toEqual([first, second])
  })

  it('drops malformed records and bounds the local registry', () => {
    const malformed = { ...first, provenance: 'bad\nrecord' }
    expect(parseRvcModelRecords(JSON.stringify([first, malformed]))).toEqual([first])
    const records = Array.from({ length: MAX_RVC_MODELS + 2 }, (_, index) => createRvcModelRecord({
      ...second,
      modelPath: `C:\\Models\\voice-${index}.pth`,
    }, `2026-08-03T12:${String(index).padStart(2, '0')}:00.000Z`))
    expect(parseRvcModelRecords(serializeRvcModelRecords(records))).toHaveLength(MAX_RVC_MODELS)
  })

  it('uses an explicit consent value and bounded settings', () => {
    expect(parseRvcConsent('1')).toBe(true)
    expect(parseRvcConsent('true')).toBe(false)
    expect(normalizeRvcSettings({ enabled: true, modelId: first.id, blendRatio: 4, pitchSemitones: -99, indexRate: -1 })).toEqual({
      enabled: true,
      modelId: first.id,
      blendModelId: null,
      blendRatio: 1,
      pitchSemitones: -24,
      indexRate: 0,
    })
    expect(JSON.parse(serializeRvcSettings(DEFAULT_RVC_SETTINGS))).toEqual(DEFAULT_RVC_SETTINGS)
  })
})
describe('RVC inference planning', () => {
  it('requires consent and reports missing selected models', () => {
    const settings = { ...DEFAULT_RVC_SETTINGS, enabled: true, modelId: first.id }
    expect(() => resolveRvcInferencePlan(settings, [first], false)).toThrow(/consent/iu)
    expect(() => resolveRvcInferencePlan(settings, [], true)).toThrow(/missing/iu)
  })

  it('builds an optional two-model blend and records only safe provenance', () => {
    const plan = resolveRvcInferencePlan({
      ...DEFAULT_RVC_SETTINGS,
      enabled: true,
      modelId: first.id,
      blendModelId: second.id,
      blendRatio: 0.7,
      pitchSemitones: 2,
      indexRate: 0.25,
    }, [first, second], true)
    expect(plan).toMatchObject({ primary: first, blend: second, blendRatio: 0.7 })
    expect(createRvcClipProvenance(plan!, '2026-08-03T12:01:00.000Z')).toEqual({
      stage: 'rvc',
      appliedAt: '2026-08-03T12:01:00.000Z',
      models: [
        { id: first.id, name: 'Voice A', license: 'MIT', provenance: 'Local model owned by the operator.' },
        { id: second.id, name: 'Voice B', license: 'CC-BY-4.0', provenance: 'Downloaded from a reviewed release.' },
      ],
      blendRatio: 0.7,
      pitchSemitones: 2,
      indexRate: 0.25,
    })
  })
})

describe('blendRvcSamples', () => {
  it('mixes two conversion passes and clamps the output', () => {
    expect([...blendRvcSamples(new Float32Array([1, 0]), new Float32Array([0, 2]), 0.5)]).toEqual([0.5, 1])
  })
})
