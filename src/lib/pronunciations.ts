export const PRONUNCIATION_SCHEMA_VERSION = 1 as const
export const MAX_PRONUNCIATIONS = 500
export const MAX_PRONUNCIATION_WORD_CHARS = 80
export const MAX_PRONUNCIATION_VALUE_CHARS = 160
export const MAX_PRONUNCIATION_PACK_NAME_CHARS = 100
export const MAX_PRONUNCIATION_PACK_DESCRIPTION_CHARS = 500

export type PronunciationMode = 'respelling' | 'phoneme'

export type PronunciationRule = {
  replacement: string
  mode: PronunciationMode
}

export type PronunciationDictionary = Record<string, PronunciationRule>

export type PronunciationPackEntry = {
  word: string
  replacement: string
  mode: PronunciationMode
}

export type PronunciationPack = {
  schemaVersion: typeof PRONUNCIATION_SCHEMA_VERSION
  name: string
  description?: string
  entries: PronunciationPackEntry[]
}

export const TECH_PRONUNCIATION_PACK: PronunciationPack = {
  schemaVersion: PRONUNCIATION_SCHEMA_VERSION,
  name: 'Tech abbreviations',
  description: 'Readable respellings for common technical abbreviations in documentation and source code.',
  entries: [
    { word: 'API', replacement: 'A P I', mode: 'respelling' },
    { word: 'CPU', replacement: 'C P U', mode: 'respelling' },
    { word: 'EPUB', replacement: 'E P U B', mode: 'respelling' },
    { word: 'GPU', replacement: 'G P U', mode: 'respelling' },
    { word: 'HTML', replacement: 'H T M L', mode: 'respelling' },
    { word: 'JSON', replacement: 'J S O N', mode: 'respelling' },
    { word: 'ONNX', replacement: 'O N N X', mode: 'respelling' },
    { word: 'PDF', replacement: 'P D F', mode: 'respelling' },
    { word: 'SQL', replacement: 'S Q L', mode: 'respelling' },
    { word: 'TTS', replacement: 'T T S', mode: 'respelling' },
    { word: 'UI', replacement: 'U I', mode: 'respelling' },
    { word: 'URL', replacement: 'U R L', mode: 'respelling' },
    { word: 'UX', replacement: 'U X', mode: 'respelling' },
    { word: 'WASM', replacement: 'W A S M', mode: 'respelling' },
  ],
}

// Private-use delimiters keep phoneme replacements distinguishable from user
// text while they travel through the normal sentence/chunk pipeline.
const PHONEME_TAG_START = '\uE000'
const PHONEME_TAG_END = '\uE001'

export type PhonemeTag = {
  word: string
  phonemes: string
}

export type PronunciationSegment =
  | { kind: 'text'; value: string }
  | { kind: 'phoneme'; value: PhonemeTag }

export function parsePronunciationDictionary(raw: unknown): PronunciationDictionary {
  const value = typeof raw === 'string' ? parseJson(raw) : raw
  if (!isRecord(value)) return {}

  if (value.schemaVersion === PRONUNCIATION_SCHEMA_VERSION && Array.isArray(value.entries)) {
    return dictionaryFromEntries(value.entries)
  }

  // Versions before packs stored { "word": "replacement" }. Treat those
  // values as respellings so existing local dictionaries migrate in place.
  const entries = Object.entries(value).map(([word, replacement]) => ({ word, replacement, mode: 'respelling' }))
  return dictionaryFromEntries(entries)
}

export function serializePronunciationDictionary(dictionary: PronunciationDictionary): string {
  return JSON.stringify({
    schemaVersion: PRONUNCIATION_SCHEMA_VERSION,
    entries: dictionaryEntries(dictionary),
  })
}

export function parsePronunciationPack(raw: unknown): PronunciationPack {
  const value = typeof raw === 'string' ? parseJson(raw) : raw
  if (!isRecord(value) || value.schemaVersion !== PRONUNCIATION_SCHEMA_VERSION || !Array.isArray(value.entries)) {
    throw new Error(`Pronunciation packs must use schema version ${PRONUNCIATION_SCHEMA_VERSION}.`)
  }
  const name = boundedString(value.name, MAX_PRONUNCIATION_PACK_NAME_CHARS)?.trim()
  if (!name) throw new Error('Pronunciation pack name is missing.')
  const description = boundedString(value.description, MAX_PRONUNCIATION_PACK_DESCRIPTION_CHARS)?.trim()
  const dictionary = dictionaryFromEntries(value.entries)
  return {
    schemaVersion: PRONUNCIATION_SCHEMA_VERSION,
    name,
    ...(description ? { description } : {}),
    entries: dictionaryEntries(dictionary),
  }
}

export function serializePronunciationPack(pack: PronunciationPack): string {
  return JSON.stringify(parsePronunciationPack(pack), null, 2)
}

export function createPronunciationPack(
  name: string,
  dictionary: PronunciationDictionary,
  description?: string,
): PronunciationPack {
  return parsePronunciationPack({
    schemaVersion: PRONUNCIATION_SCHEMA_VERSION,
    name,
    description,
    entries: dictionaryEntries(dictionary),
  })
}

export function mergePronunciationPack(
  dictionary: PronunciationDictionary,
  pack: PronunciationPack,
): PronunciationDictionary {
  return dictionaryFromEntries([
    ...dictionaryEntries(dictionary),
    ...pack.entries,
  ])
}

export function applyPronunciationRules(
  input: string,
  dictionary: PronunciationDictionary,
  options: { phonemeTags?: boolean } = {},
): string {
  const entries = Object.entries(dictionary).filter(([word, rule]) => word && isRule(rule))
  if (entries.length === 0) return input

  const rules = new Map(entries)
  const pattern = entries
    .map(([word]) => word)
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const re = new RegExp(`(?<!\\w)(?:${pattern})(?!\\w)`, 'g')
  return input.replace(re, (match) => {
    const rule = rules.get(match)
    if (!rule) return match
    return rule.mode === 'phoneme' && options.phonemeTags === true
      ? encodePhonemeTag(match, rule.replacement)
      : rule.replacement
  })
}

export function encodePhonemeTag(word: string, phonemes: string): string {
  const payload = encodeURIComponent(JSON.stringify({ word, phonemes }))
  return `${PHONEME_TAG_START}${payload}${PHONEME_TAG_END}`
}

export function splitPronunciationTags(input: string): PronunciationSegment[] {
  const segments: PronunciationSegment[] = []
  const re = new RegExp(`${escapeRegExp(PHONEME_TAG_START)}([^${PHONEME_TAG_END}]*)${escapeRegExp(PHONEME_TAG_END)}`, 'gu')
  let lastIndex = 0
  for (const match of input.matchAll(re)) {
    const index = match.index ?? 0
    if (index > lastIndex) segments.push({ kind: 'text', value: input.slice(lastIndex, index) })
    const tag = decodePhonemeTag(match[1])
    if (tag) segments.push({ kind: 'phoneme', value: tag })
    else segments.push({ kind: 'text', value: match[0] })
    lastIndex = index + match[0].length
  }
  if (lastIndex < input.length) segments.push({ kind: 'text', value: input.slice(lastIndex) })
  return segments.length > 0 ? segments : [{ kind: 'text', value: input }]
}

function decodePhonemeTag(payload: string): PhonemeTag | null {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(payload))
    if (!isRecord(parsed)) return null
    const word = boundedString(parsed.word, MAX_PRONUNCIATION_WORD_CHARS)?.trim()
    const phonemes = boundedString(parsed.phonemes, MAX_PRONUNCIATION_VALUE_CHARS)?.trim()
    return word && phonemes ? { word, phonemes } : null
  } catch {
    return null
  }
}

function dictionaryFromEntries(rawEntries: unknown[]): PronunciationDictionary {
  const dictionary: PronunciationDictionary = {}
  for (const raw of rawEntries) {
    if (Object.keys(dictionary).length >= MAX_PRONUNCIATIONS) break
    if (!isRecord(raw)) continue
    const word = boundedString(raw.word, MAX_PRONUNCIATION_WORD_CHARS)?.trim()
    const replacement = boundedString(raw.replacement, MAX_PRONUNCIATION_VALUE_CHARS)?.trim()
    const mode = normalizeMode(raw.mode)
    if (!word || !replacement || !mode) continue
    dictionary[word] = { replacement, mode }
  }
  return dictionary
}

function dictionaryEntries(dictionary: PronunciationDictionary): PronunciationPackEntry[] {
  return Object.entries(dictionary)
    .filter(([word, rule]) => word && isRule(rule))
    .slice(0, MAX_PRONUNCIATIONS)
    .map(([word, rule]) => ({ word, replacement: rule.replacement, mode: rule.mode }))
}

function isRule(value: unknown): value is PronunciationRule {
  if (!isRecord(value)) return false
  return Boolean(boundedString(value.replacement, MAX_PRONUNCIATION_VALUE_CHARS)?.trim() && normalizeMode(value.mode))
}

function normalizeMode(value: unknown): PronunciationMode | null {
  return value === 'phoneme' || value === 'respelling' ? value : null
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
