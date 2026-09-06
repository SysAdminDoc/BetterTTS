// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_UI_LOCALE,
  UI_LOCALE_CATALOG_VERSION,
  UI_LOCALE_STORAGE_KEY,
  UI_LOCALES,
  applyUiLocaleAttributes,
  formatUiDate,
  formatUiNumber,
  parseUiLocale,
  readUiLocale,
  uiDirection,
  uiDirectionForLocaleTag,
  uiPlural,
  uiText,
  validateUiCatalog,
} from './ui-locale.ts'

describe('UI locale adapter', () => {
  it('ships only the reviewed English UI locale and keeps synthesis separate', () => {
    expect(UI_LOCALES).toEqual([{
      id: 'en',
      tag: 'en',
      label: 'English',
      reviewed: true,
      direction: 'ltr',
    }])
    expect(UI_LOCALE_CATALOG_VERSION).toBe(1)
    expect(DEFAULT_UI_LOCALE).toBe('en')
    expect(parseUiLocale('fr')).toBe('en')
    expect(uiText('en', 'interfaceLanguage')).toBe('Interface language')
    expect(uiText('en', 'synthesisLanguage')).toBe('Synthesis language')
    expect(uiText('fr', 'generationCancelled')).toBe('Generation cancelled.')
  })

  it('reads persisted UI language safely and uses a namespaced key', () => {
    expect(UI_LOCALE_STORAGE_KEY).toBe('bettertts-ui-locale')
    expect(readUiLocale({ getItem: () => 'en' })).toBe('en')
    expect(readUiLocale({ getItem: () => 'fr' })).toBe('en')
    expect(readUiLocale({ getItem: () => { throw new Error('storage unavailable') } })).toBe('en')
  })

  it('formats plural, number, and date values with deterministic invalid-value fallbacks', () => {
    expect(uiPlural('en', 'qualityChecks', 1)).toContain('1 quality check needs review')
    expect(uiPlural('en', 'qualityChecks', 2)).toContain('2 quality checks need review')
    expect(formatUiNumber('en', 1234.5)).toBe('1,234.5')
    expect(formatUiNumber('en', Number.NaN)).toBe('Unavailable')
    expect(formatUiDate('en', '2026-01-02T00:00:00.000Z', { timeZone: 'UTC', dateStyle: 'medium' })).toContain('Jan')
    expect(formatUiDate('en', 'not-a-date')).toBe('Unavailable')
  })

  it('provides an RTL fixture without adding an unreviewed selectable locale', () => {
    const root = document.createElement('html')
    applyUiLocaleAttributes(root, 'en')
    expect(root.getAttribute('lang')).toBe('en')
    expect(root.getAttribute('dir')).toBe('ltr')
    expect(uiDirection('en')).toBe('ltr')
    applyUiLocaleAttributes(root, 'ar')
    expect(root.getAttribute('lang')).toBe('ar')
    expect(root.getAttribute('dir')).toBe('rtl')
    expect(uiDirection('ar')).toBe('rtl')
    expect(uiDirectionForLocaleTag('ar-EG')).toBe('rtl')
    expect(uiDirectionForLocaleTag('he-IL')).toBe('rtl')
    expect(uiDirectionForLocaleTag('fr-FR')).toBe('ltr')
  })

  it('reports catalog completeness issues instead of silently falling back', () => {
    const issues = validateUiCatalog({
      en: {
        text: {
          interfaceLanguage: 'Interface language',
          synthesisLanguage: '',
        },
        plurals: {
          qualityChecks: { one: '{count} check', other: '{count} checks' },
        },
      },
    })
    expect(issues.some((entry) => entry.code === 'missing-text' && entry.key === 'synthesisLanguage')).toBe(true)
    expect(issues.some((entry) => entry.code === 'missing-required-text' && entry.key === 'persistenceUnavailable')).toBe(true)
  })

  it('passes the checked-in catalog contract', () => {
    expect(validateUiCatalog()).toEqual([])
  })
})
