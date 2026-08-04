import { describe, expect, it } from 'vitest'
import {
  MAX_PRONUNCIATIONS,
  parseCleanupSetting,
  parsePronunciationSetting,
} from './settings.ts'
import { DEFAULT_CLEANUP } from './text.ts'

describe('persisted editor settings', () => {
  it('rejects malformed and non-object pronunciation dictionaries', () => {
    expect(parsePronunciationSetting('{')).toEqual({})
    expect(parsePronunciationSetting('null')).toEqual({})
    expect(parsePronunciationSetting('["word"]')).toEqual({})
  })

  it('keeps only bounded string pronunciation pairs', () => {
    const oversized = 'x'.repeat(200)
    expect(parsePronunciationSetting(JSON.stringify({
      BetterTTS: 'better tee tee ess',
      empty: '',
      numeric: 3,
      oversized,
    }))).toEqual({ BetterTTS: 'better tee tee ess' })
  })

  it('caps pronunciation entries before regex construction', () => {
    const source = Object.fromEntries(Array.from({ length: MAX_PRONUNCIATIONS + 20 }, (_, index) => [`word${index}`, `sound${index}`]))
    expect(Object.keys(parsePronunciationSetting(JSON.stringify(source)))).toHaveLength(MAX_PRONUNCIATIONS)
  })

  it('accepts only boolean cleanup overrides', () => {
    expect(parseCleanupSetting(JSON.stringify({
      citations: false,
      dropHeaders: 'yes',
      unknown: true,
    }))).toEqual({
      ...DEFAULT_CLEANUP,
      citations: false,
    })
    expect(parseCleanupSetting('null')).toEqual(DEFAULT_CLEANUP)
  })

  it('persists the PDF re-flow toggle independently', () => {
    expect(parseCleanupSetting(JSON.stringify({ pdfReflow: false })).pdfReflow).toBe(false)
    expect(parseCleanupSetting(JSON.stringify({ citations: false })).pdfReflow).toBe(true)
  })
})
