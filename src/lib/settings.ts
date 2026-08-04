import { type CleanupOptions, DEFAULT_CLEANUP } from './text.ts'
import {
  parsePronunciationDictionary,
  type PronunciationDictionary,
} from './pronunciations.ts'

export { MAX_PRONUNCIATIONS, MAX_PRONUNCIATION_VALUE_CHARS, MAX_PRONUNCIATION_WORD_CHARS } from './pronunciations.ts'

export function parsePronunciationSetting(raw: string | null): Record<string, string> {
  const dictionary = parsePronunciationDictionary(raw)
  return Object.fromEntries(
    Object.entries(dictionary)
      .filter(([, rule]) => rule.mode === 'respelling')
      .map(([word, rule]) => [word, rule.replacement]),
  )
}

export function parsePronunciationDictionarySetting(raw: string | null): PronunciationDictionary {
  return parsePronunciationDictionary(raw)
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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
