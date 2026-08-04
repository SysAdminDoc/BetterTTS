import { describe, expect, it } from 'vitest'
import {
  PRONUNCIATION_SCHEMA_VERSION,
  TECH_PRONUNCIATION_PACK,
  applyPronunciationRules,
  encodePhonemeTag,
  mergePronunciationPack,
  parsePronunciationDictionary,
  parsePronunciationPack,
  serializePronunciationDictionary,
  serializePronunciationPack,
  splitPronunciationTags,
  type PronunciationDictionary,
} from './pronunciations.ts'

describe('pronunciation dictionaries', () => {
  const dictionary: PronunciationDictionary = {
    API: { replacement: 'A P I', mode: 'respelling' },
    cache: { replacement: 'cash', mode: 'respelling' },
    SQL: { replacement: 'sˌiːkwəl', mode: 'phoneme' },
  }

  it('migrates legacy string maps and round-trips versioned settings', () => {
    expect(parsePronunciationDictionary(JSON.stringify({ API: 'A P I' }))).toEqual({
      API: { replacement: 'A P I', mode: 'respelling' },
    })
    expect(parsePronunciationDictionary(serializePronunciationDictionary(dictionary))).toEqual(dictionary)
  })

  it('applies replacements once with longest word-boundary matches', () => {
    const output = applyPronunciationRules('API cache APIcache SQL.', dictionary)
    expect(output).toBe('A P I cash APIcache sˌiːkwəl.')
  })

  it('keeps phoneme entries readable for non-Kokoro engines and tags them for Kokoro', () => {
    expect(applyPronunciationRules('Use SQL.', dictionary)).toBe('Use sˌiːkwəl.')
    const tagged = applyPronunciationRules('Use SQL.', dictionary, { phonemeTags: true })
    expect(tagged).toContain('\uE000')
    expect(splitPronunciationTags(tagged)).toEqual([
      { kind: 'text', value: 'Use ' },
      { kind: 'phoneme', value: { word: 'SQL', phonemes: 'sˌiːkwəl' } },
      { kind: 'text', value: '.' },
    ])
    expect(splitPronunciationTags(encodePhonemeTag('A', 'ə'))).toEqual([
      { kind: 'phoneme', value: { word: 'A', phonemes: 'ə' } },
    ])
  })
})

describe('pronunciation packs', () => {
  it('validates versioned packs and merges them without exceeding bounds', () => {
    const pack = parsePronunciationPack(serializePronunciationPack(TECH_PRONUNCIATION_PACK))
    expect(pack.schemaVersion).toBe(PRONUNCIATION_SCHEMA_VERSION)
    expect(pack.entries.some((entry) => entry.word === 'API')).toBe(true)
    const merged = mergePronunciationPack({}, pack)
    expect(merged.API).toEqual({ replacement: 'A P I', mode: 'respelling' })
  })

  it('rejects unsupported pack versions and malformed entries', () => {
    expect(() => parsePronunciationPack({ schemaVersion: 2, name: 'Nope', entries: [] })).toThrow(/schema version 1/)
    expect(parsePronunciationPack({
      schemaVersion: 1,
      name: 'Partial',
      entries: [
        { word: 'good', replacement: 'gud', mode: 'respelling' },
        { word: 'bad', replacement: 'ignored', mode: 'unknown' },
      ],
    }).entries).toEqual([{ word: 'good', replacement: 'gud', mode: 'respelling' }])
  })
})
