import localeManifest from './ui-locale.catalog.json'

/**
 * UI language is deliberately independent from synthesis-language capability.
 * Engine language lists belong to each adapter; this catalog owns only the
 * words rendered by the application shell.
 */
export const UI_LOCALE_STORAGE_KEY = 'bettertts-ui-locale'
export const DEFAULT_UI_LOCALE = 'en' as const

export const UI_TEXT_KEYS = [
  'interfaceLanguage',
  'synthesisLanguage',
  'persistenceUnavailable',
  'generationCancelled',
  'shareUnavailable',
  'articleImportFallback',
  'articleImportTimeout',
  'articleImportCancelled',
  'unexpectedInterfaceError',
] as const

export type UiTextKey = typeof UI_TEXT_KEYS[number]

export const UI_PLURAL_KEYS = [
  'qualityChecks',
] as const

export type UiPluralKey = typeof UI_PLURAL_KEYS[number]
export type UiDirection = 'ltr' | 'rtl'

export type UiLocaleDescriptor = {
  readonly id: string
  readonly tag: string
  readonly label: string
  readonly reviewed: boolean
  readonly direction: UiDirection
}

export type UiLocaleCopy = {
  readonly text: Readonly<Record<UiTextKey, string>>
  readonly plurals: Readonly<Record<UiPluralKey, Readonly<Record<string, string>>>>
}

export type UiLocaleCatalog = Readonly<Record<string, UiLocaleCopy>>

type UiLocaleManifest = {
  readonly version: number
  readonly locales: readonly UiLocaleDescriptor[]
  readonly requiredTextKeys: readonly string[]
  readonly requiredPluralKeys: readonly string[]
  readonly catalog: UiLocaleCatalog
}

const manifest = localeManifest as unknown as UiLocaleManifest

// The manifest is data-driven at runtime while the reviewed locale IDs remain
// a narrow type for React controls and persisted settings.
export const UI_LOCALES = manifest.locales as readonly [{
  readonly id: 'en'
  readonly tag: 'en'
  readonly label: 'English'
  readonly reviewed: true
  readonly direction: 'ltr'
}]

export type UiLocale = typeof UI_LOCALES[number]['id']

export const UI_LOCALE_CATALOG_VERSION = manifest.version
export const UI_LOCALE_CATALOG = manifest.catalog as Record<UiLocale, UiLocaleCopy>
export const UI_COPY = UI_LOCALE_CATALOG

const RTL_LANGUAGE_TAGS = new Set(['ae', 'ar', 'ckb', 'dv', 'fa', 'he', 'ku', 'ps', 'ur', 'yi'])

export type UiMessageValues = Readonly<Record<string, string | number>>

function interpolate(template: string, values?: UiMessageValues): string {
  if (!values) return template
  return template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (placeholder, name: string) => {
    const value = values[name]
    return value === undefined ? placeholder : String(value)
  })
}

function catalogEntry(locale: unknown): UiLocaleCopy {
  const normalized = parseUiLocale(locale)
  return UI_LOCALE_CATALOG[normalized] ?? UI_LOCALE_CATALOG[DEFAULT_UI_LOCALE]
}

function localeDescriptor(locale: unknown): UiLocaleDescriptor {
  const known = typeof locale === 'string'
    ? UI_LOCALES.find((candidate) => candidate.id === locale)
    : undefined
  if (known || typeof locale !== 'string' || !locale.trim()) return known ?? UI_LOCALES[0]
  const tag = locale.trim()
  return {
    id: tag,
    tag,
    label: tag,
    reviewed: false,
    direction: uiDirectionForLocaleTag(tag),
  }
}

export function parseUiLocale(value: unknown): UiLocale {
  const found = UI_LOCALES.find((locale) => locale.id === value)
  return found?.id ?? DEFAULT_UI_LOCALE
}

export function readUiLocale(storage: Pick<Storage, 'getItem'> | null | undefined): UiLocale {
  try {
    return parseUiLocale(storage?.getItem(UI_LOCALE_STORAGE_KEY))
  } catch {
    return DEFAULT_UI_LOCALE
  }
}

export function uiLocaleInfo(locale: unknown): UiLocaleDescriptor {
  return localeDescriptor(locale)
}

export function uiDirectionForLocaleTag(tag: string): UiDirection {
  const primaryTag = tag.trim().toLowerCase().split('-')[0] ?? ''
  return RTL_LANGUAGE_TAGS.has(primaryTag) ? 'rtl' : 'ltr'
}

export function uiDirection(locale: unknown): UiDirection {
  return localeDescriptor(locale).direction
}

export function applyUiLocaleAttributes(root: Pick<HTMLElement, 'setAttribute'>, locale: unknown): void {
  const info = localeDescriptor(locale)
  root.setAttribute('lang', info.tag)
  root.setAttribute('dir', info.direction)
}

export function uiText(locale: unknown, key: UiTextKey, values?: UiMessageValues): string {
  const fallback = UI_LOCALE_CATALOG[DEFAULT_UI_LOCALE]?.text[key] ?? key
  const localized = catalogEntry(locale).text[key]
  return interpolate(localized ?? fallback, values)
}

export function uiPlural(locale: unknown, key: UiPluralKey, count: number): string {
  const safeCount = Number.isFinite(count) ? count : 0
  const info = localeDescriptor(locale)
  let category = 'other'
  try {
    category = new Intl.PluralRules(info.tag).select(safeCount)
  } catch {
    // The default English template below remains deterministic if an embedded
    // browser has an incomplete Intl implementation.
  }
  const fallback = UI_LOCALE_CATALOG[DEFAULT_UI_LOCALE]?.plurals[key]
  const localized = catalogEntry(locale).plurals[key]
  const template = localized?.[category] ?? localized?.other ?? fallback?.[category] ?? fallback?.other ?? key
  return interpolate(template, { count: formatUiNumber(locale, safeCount) })
}

export function formatUiNumber(locale: unknown, value: number, options?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(value)) return '—'
  const info = localeDescriptor(locale)
  try {
    return new Intl.NumberFormat(info.tag, options).format(value)
  } catch {
    try {
      return new Intl.NumberFormat('en', options).format(value)
    } catch {
      return String(value)
    }
  }
}

export function formatUiDate(locale: unknown, value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  const resolvedOptions = options ?? { dateStyle: 'medium' }
  const info = localeDescriptor(locale)
  try {
    return new Intl.DateTimeFormat(info.tag, resolvedOptions).format(date)
  } catch {
    try {
      return new Intl.DateTimeFormat('en', resolvedOptions).format(date)
    } catch {
      return date.toISOString().slice(0, 10)
    }
  }
}

export type UiCatalogValidationIssue = {
  readonly code: string
  readonly locale?: string
  readonly key?: string
  readonly message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issue(code: string, message: string, locale?: string, key?: string): UiCatalogValidationIssue {
  return { code, locale, key, message }
}

export function validateUiCatalog(
  catalog: unknown = UI_LOCALE_CATALOG,
  locales: readonly UiLocaleDescriptor[] = UI_LOCALES,
): UiCatalogValidationIssue[] {
  const issues: UiCatalogValidationIssue[] = []
  if (!isRecord(catalog)) return [issue('catalog-shape', 'Catalog must be an object.')]

  const defaultEntry = catalog[DEFAULT_UI_LOCALE]
  if (!isRecord(defaultEntry) || !isRecord(defaultEntry.text) || !isRecord(defaultEntry.plurals)) {
    return [issue('default-locale', `Default locale ${DEFAULT_UI_LOCALE} must contain text and plurals.`)]
  }

  const expectedTextKeys = Object.keys(defaultEntry.text)
  const expectedPluralKeys = Object.keys(defaultEntry.plurals)
  const localeIds = new Set(locales.map((locale) => locale.id))

  for (const locale of locales) {
    if (!locale.id || !locale.tag || !locale.label || !locale.reviewed || !['ltr', 'rtl'].includes(locale.direction)) {
      issues.push(issue('locale-metadata', `Locale ${locale.id || '<empty>'} has incomplete or invalid metadata.`, locale.id))
    }
    const entry = catalog[locale.id]
    if (!isRecord(entry) || !isRecord(entry.text) || !isRecord(entry.plurals)) {
      issues.push(issue('missing-locale', `Locale ${locale.id} is missing a text/plural catalog.`, locale.id))
      continue
    }
    for (const key of expectedTextKeys) {
      const value = entry.text[key]
      if (typeof value !== 'string' || value.trim() === '') {
        issues.push(issue('missing-text', `Locale ${locale.id} has no non-empty translation for ${key}.`, locale.id, key))
      }
    }
    for (const key of Object.keys(entry.text)) {
      if (!expectedTextKeys.includes(key)) issues.push(issue('extra-text', `Locale ${locale.id} has an unknown text key ${key}.`, locale.id, key))
    }
    for (const key of expectedPluralKeys) {
      const plural = entry.plurals[key]
      const fallbackPlural = defaultEntry.plurals[key]
      if (!isRecord(plural) || !isRecord(fallbackPlural)) {
        issues.push(issue('missing-plural', `Locale ${locale.id} has no plural catalog for ${key}.`, locale.id, key))
        continue
      }
      let categories = ['other']
      try {
        categories = new Intl.PluralRules(locale.tag).resolvedOptions().pluralCategories
      } catch {
        issues.push(issue('locale-plural-rules', `Locale ${locale.id} has an invalid plural-rules tag.`, locale.id))
      }
      for (const category of categories) {
        const value = plural[category]
        if (typeof value !== 'string' || value.trim() === '') {
          issues.push(issue('missing-plural-category', `Locale ${locale.id} has no ${category} form for ${key}.`, locale.id, key))
        }
      }
      for (const category of Object.keys(fallbackPlural)) {
        if (typeof plural[category] !== 'string' || plural[category].trim() === '') {
          issues.push(issue('missing-plural-category', `Locale ${locale.id} has no ${category} form for ${key}.`, locale.id, key))
        }
      }
    }
  }

  for (const localeId of Object.keys(catalog)) {
    if (!localeIds.has(localeId)) issues.push(issue('orphan-locale', `Catalog has no locale metadata for ${localeId}.`, localeId))
  }
  for (const key of UI_TEXT_KEYS) {
    if (!expectedTextKeys.includes(key)) issues.push(issue('missing-required-text', `Default catalog is missing required text key ${key}.`, DEFAULT_UI_LOCALE, key))
  }
  for (const key of UI_PLURAL_KEYS) {
    if (!expectedPluralKeys.includes(key)) issues.push(issue('missing-required-plural', `Default catalog is missing required plural key ${key}.`, DEFAULT_UI_LOCALE, key))
  }
  return issues
}
