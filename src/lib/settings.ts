import { type CleanupOptions, DEFAULT_CLEANUP } from './text.ts'

export const MAX_PRONUNCIATIONS = 500
export const MAX_PRONUNCIATION_WORD_CHARS = 80
export const MAX_PRONUNCIATION_VALUE_CHARS = 160

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function parsePronunciationSetting(raw: string | null): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!plainRecord(parsed)) return {}
    const entries = Object.entries(parsed)
      .filter(([word, replacement]) => (
        word.length > 0
        && word.length <= MAX_PRONUNCIATION_WORD_CHARS
        && typeof replacement === 'string'
        && replacement.length > 0
        && replacement.length <= MAX_PRONUNCIATION_VALUE_CHARS
      ))
      .slice(0, MAX_PRONUNCIATIONS) as Array<[string, string]>
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

export function parseCleanupSetting(raw: string | null): CleanupOptions {
  if (!raw) return DEFAULT_CLEANUP
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!plainRecord(parsed)) return DEFAULT_CLEANUP
    return Object.fromEntries(
      Object.entries(DEFAULT_CLEANUP).map(([key, fallback]) => [
        key,
        typeof parsed[key] === 'boolean' ? parsed[key] : fallback,
      ]),
    ) as CleanupOptions
  } catch {
    return DEFAULT_CLEANUP
  }
}
