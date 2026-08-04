import { describe, expect, it } from 'vitest'
import {
  DEFAULT_UI_LOCALE,
  UI_LOCALE_STORAGE_KEY,
  UI_LOCALES,
  parseUiLocale,
  readUiLocale,
  uiText,
} from './ui-locale.ts'

describe('UI locale adapter', () => {
  it('ships only the reviewed English UI locale', () => {
    expect(UI_LOCALES).toEqual([{ id: 'en', label: 'English', reviewed: true }])
    expect(DEFAULT_UI_LOCALE).toBe('en')
    expect(parseUiLocale('fr')).toBe('en')
    expect(uiText('en', 'interfaceLanguage')).toBe('Interface language')
    expect(uiText('en', 'synthesisLanguage')).toBe('Synthesis language')
  })

  it('reads persisted UI language safely and uses a namespaced key', () => {
    expect(UI_LOCALE_STORAGE_KEY).toBe('bettertts-ui-locale')
    expect(readUiLocale({ getItem: () => 'en' })).toBe('en')
    expect(readUiLocale({ getItem: () => 'fr' })).toBe('en')
    expect(readUiLocale({ getItem: () => { throw new Error('storage unavailable') } })).toBe('en')
  })
})
