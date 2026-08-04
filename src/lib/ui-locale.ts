/**
 * UI language boundary. Synthesis languages belong to individual engines and
 * must never be inferred from this setting. English is the only reviewed UI
 * locale shipped until a future translation pass supplies reviewed copy.
 */
export const UI_LOCALE_STORAGE_KEY = 'bettertts-ui-locale'
export const DEFAULT_UI_LOCALE = 'en' as const

export const UI_LOCALES = [
  { id: 'en', label: 'English', reviewed: true },
] as const

export type UiLocale = typeof UI_LOCALES[number]['id']

const UI_COPY = {
  en: {
    interfaceLanguage: 'Interface language',
    synthesisLanguage: 'Synthesis language',
  },
} as const

export type UiTextKey = keyof typeof UI_COPY.en

export function parseUiLocale(value: unknown): UiLocale {
  return UI_LOCALES.some((locale) => locale.id === value) ? value as UiLocale : DEFAULT_UI_LOCALE
}

export function readUiLocale(storage: Pick<Storage, 'getItem'> | null | undefined): UiLocale {
  try {
    return parseUiLocale(storage?.getItem(UI_LOCALE_STORAGE_KEY))
  } catch {
    return DEFAULT_UI_LOCALE
  }
}

export function uiText(locale: UiLocale, key: UiTextKey): string {
  return UI_COPY[parseUiLocale(locale)][key]
}
