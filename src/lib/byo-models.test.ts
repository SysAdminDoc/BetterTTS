import { describe, expect, it } from 'vitest'
import {
  BYO_MODEL_OPTIONS,
  MAX_BYO_MODELS,
  createByoModelRecord,
  byoModelToVoiceSource,
  parseByoConsent,
  parseByoModelRecords,
  removeByoModelRecord,
  serializeByoModelRecords,
  upsertByoModelRecord,
} from './byo-models.ts'

const input = {
  modelId: 'f5-tts' as const,
  weightsPath: 'C:\\Models\\f5-tts',
  selectionKind: 'directory' as const,
  license: 'CC-BY-NC-4.0; verify the checkpoint terms.',
  provenance: 'Downloaded from the upstream release at commit abc123.',
  sourceUrl: 'https://example.test/f5-tts',
}

describe('bring-your-own model metadata', () => {
  it('round-trips bounded provenance and license metadata', () => {
    const record = createByoModelRecord(input, '2026-08-03T12:00:00.000Z')
    const parsed = parseByoModelRecords(serializeByoModelRecords([record]))
    expect(parsed).toEqual([record])
    expect(parsed[0]).toMatchObject({ modelName: 'F5-TTS', selectionKind: 'directory' })
  })

  it('drops malformed, unknown, oversized, and control-character records', () => {
    const valid = createByoModelRecord(input, '2026-08-03T12:00:00.000Z')
    const malformed = [
      valid,
      { ...valid, modelId: 'qwen' },
      { ...valid, weightsPath: 'x'.repeat(2_049) },
      { ...valid, provenance: 'bad\nprovenance' },
      { ...valid, license: '' },
    ]
    expect(parseByoModelRecords(JSON.stringify(malformed))).toEqual([valid])
    expect(parseByoModelRecords('{')).toEqual([])
  })

  it('requires explicit non-commercial consent and keeps the catalog download-free', () => {
    expect(parseByoConsent('1')).toBe(true)
    expect(parseByoConsent('true')).toBe(false)
    expect(BYO_MODEL_OPTIONS.every((option) => !('url' in option))).toBe(true)
  })

  it('upserts the same path and bounds registered records', () => {
    const first = createByoModelRecord(input, '2026-08-03T12:00:00.000Z')
    const replacement = { ...first, id: 'replacement', license: 'Updated terms.' }
    expect(upsertByoModelRecord([first], replacement)).toEqual([replacement])

    const records = Array.from({ length: MAX_BYO_MODELS + 2 }, (_, index) => createByoModelRecord({
      ...input,
      weightsPath: `C:\\Models\\f5-${index}`,
    }, `2026-08-03T12:${String(index).padStart(2, '0')}:00.000Z`))
    expect(upsertByoModelRecord([], records[0])).toHaveLength(1)
    expect(records).toHaveLength(MAX_BYO_MODELS + 2)
    expect(upsertByoModelRecord(records.slice(0, MAX_BYO_MODELS), records[MAX_BYO_MODELS])).toHaveLength(MAX_BYO_MODELS)
    expect(removeByoModelRecord([first], first.id)).toEqual([])
  })

  it('converts a consented registered model into bounded user-supplied voice attribution', () => {
    const record = createByoModelRecord({
      modelId: 'f5-tts',
      weightsPath: 'C:\\Models\\f5',
      selectionKind: 'directory',
      license: 'CC-BY-NC-4.0',
      provenance: 'Reviewed local release.',
    }, '2026-08-09T12:00:00.000Z')
    expect(() => byoModelToVoiceSource(record, false)).toThrow(/consent/iu)
    expect(byoModelToVoiceSource(record, true)).toMatchObject({
      source: 'user-supplied',
      sourceId: record.id,
      modelId: 'f5-tts',
      consent: { required: true, acknowledged: true, acknowledgedAt: '2026-08-09T12:00:00.000Z' },
      watermark: { status: 'unknown' },
    })
  })
})
