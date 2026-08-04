export type TextSegment = { type: 'text'; content: string } | { type: 'pause'; duration: number }

export const PAUSE_TAG = /\[pause(?:\s+([\d.]+)\s*s?)?\]/gi

export type ProsodySettings = {
  rate: number
  pitchSemitones: number
}

export type ProsodySegment = ProsodySettings & {
  content: string
}

export const DEFAULT_PROSODY: ProsodySettings = {
  rate: 1,
  pitchSemitones: 0,
}

const PROSODY_TAG = /\[prosody\b([^\]]*)\]([\s\S]*?)\[\/prosody\]/gi
const PROSODY_ATTRIBUTE = /(?:^|\s)(rate|pitch)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi
const PROSODY_RATE_MIN = 0.5
const PROSODY_RATE_MAX = 2
const PROSODY_PITCH_MIN = -12
const PROSODY_PITCH_MAX = 12

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function parseProsodySettings(attributes: string): ProsodySettings {
  let rate = DEFAULT_PROSODY.rate
  let pitchSemitones = DEFAULT_PROSODY.pitchSemitones
  for (const match of attributes.matchAll(PROSODY_ATTRIBUTE)) {
    const value = match[2] ?? match[3] ?? match[4]
    if (match[1].toLowerCase() === 'rate') rate = boundedNumber(value, rate, PROSODY_RATE_MIN, PROSODY_RATE_MAX)
    if (match[1].toLowerCase() === 'pitch') pitchSemitones = boundedNumber(value, pitchSemitones, PROSODY_PITCH_MIN, PROSODY_PITCH_MAX)
  }
  return { rate, pitchSemitones }
}

/** Parses explicit [prosody ...] spans while leaving unmarked text at 1x/0 st. */
export function parseProsodyTags(text: string): ProsodySegment[] {
  const segments: ProsodySegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(PROSODY_TAG)) {
    const start = match.index ?? 0
    const before = text.slice(lastIndex, start)
    if (before.trim()) segments.push({ content: before.trim(), ...DEFAULT_PROSODY })
    const content = match[2].trim()
    if (content) segments.push({ content, ...parseProsodySettings(match[1]) })
    lastIndex = start + match[0].length
  }

  const tail = text.slice(lastIndex)
  if (tail.trim()) segments.push({ content: tail.trim(), ...DEFAULT_PROSODY })
  return segments
}

/** Removes explicit prosody markup for browser speech and other text-only paths. */
export function stripProsodyTags(text: string): string {
  return text.replace(PROSODY_TAG, '$2')
}

export const PUNCTUATION_PAUSE_KEYS = ['comma', 'semicolon', 'colon', 'period', 'question', 'exclamation', 'ellipsis', 'emDash'] as const
export type PunctuationPauseKey = typeof PUNCTUATION_PAUSE_KEYS[number]
export type PunctuationPauseSettings = Record<PunctuationPauseKey, number>

// Zero is deliberate: enabling the panel must not alter existing scripts until
// a user chooses a pause duration. Values are stored in seconds.
export const DEFAULT_PUNCTUATION_PAUSES: PunctuationPauseSettings = {
  comma: 0,
  semicolon: 0,
  colon: 0,
  period: 0,
  question: 0,
  exclamation: 0,
  ellipsis: 0,
  emDash: 0,
}

const PUNCTUATION_TOKEN = /\.{3}|…|[,;:?!]|[—–]|\./g

function punctuationPauseKey(token: string): PunctuationPauseKey | null {
  if (token === ',') return 'comma'
  if (token === ';') return 'semicolon'
  if (token === ':') return 'colon'
  if (token === '?') return 'question'
  if (token === '!') return 'exclamation'
  if (token === '…' || token === '...') return 'ellipsis'
  if (token === '—' || token === '–') return 'emDash'
  return 'period'
}

function formatPauseSeconds(seconds: number): string {
  return Number(seconds.toFixed(3)).toString()
}

/** Adds user-selected silence after punctuation without touching existing tags. */
export function applyPunctuationPauses(text: string, settings: PunctuationPauseSettings): string {
  return text.replace(PUNCTUATION_TOKEN, (token, offset, source) => {
    const key = punctuationPauseKey(token)
    if (!key) return token
    const duration = Number(settings[key])
    if (!Number.isFinite(duration) || duration <= 0) return token

    const following = source.slice(offset + token.length)
    // Decimals, abbreviations, and punctuation already followed by an explicit
    // pause should not receive an accidental second splice.
    if (token === '.' && !/^(?:\s|$|\[\/prosody\])/u.test(following)) return token
    if (/^\s*\[pause(?:\s|\])/iu.test(following)) return token
    return `${token} [pause ${formatPauseSeconds(Math.min(30, duration))}s]`
  })
}

export function parsePauseTags(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(PAUSE_TAG)) {
    const before = text.slice(lastIndex, match.index)
    if (before.trim()) segments.push({ type: 'text', content: before.trim() })
    const duration = match[1] ? Number.parseFloat(match[1]) : 1
    if (duration > 0 && duration <= 30) segments.push({ type: 'pause', duration })
    lastIndex = match.index + match[0].length
  }

  const tail = text.slice(lastIndex)
  if (tail.trim()) segments.push({ type: 'text', content: tail.trim() })
  return segments.length > 0 ? segments : [{ type: 'text', content: text.trim() }]
}

const MAX_CHUNK_CHARS = 300

// Kokoro's tokenizer silently truncates past ~510 phoneme tokens, so no single
// chunk may exceed MAX_CHUNK_CHARS even when the text has no sentence punctuation.
function hardSplit(sentence: string): string[] {
  if (sentence.length <= MAX_CHUNK_CHARS) return [sentence]

  const parts: string[] = []
  let rest = sentence
  while (rest.length > MAX_CHUNK_CHARS) {
    const window = rest.slice(0, MAX_CHUNK_CHARS)
    let cut = Math.max(window.lastIndexOf(','), window.lastIndexOf(';'), window.lastIndexOf(':'))
    if (cut < MAX_CHUNK_CHARS * 0.4) cut = window.lastIndexOf(' ')
    if (cut <= 0) {
      cut = MAX_CHUNK_CHARS
      // Never split a surrogate pair — a lone surrogate reaches the phonemizer
      // as U+FFFD and garbles the audio at the seam.
      const beforeCut = rest.charCodeAt(cut - 1)
      if (beforeCut >= 0xd800 && beforeCut <= 0xdbff) cut -= 1
    } else {
      cut += 1
    }
    const part = rest.slice(0, cut).trim()
    if (part) parts.push(part)
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

export function splitIntoSentences(text: string): string[] {
  if (!text.trim()) return []
  // Sentence terminators beyond [.!?]: Devanagari danda (Hindi is a supported
  // Kokoro locale) and fullwidth CJK stops, which often have no trailing space.
  const sentences = text.split(/(?<=[.!?।॥。！？])\s+|(?<=[。！？])/).filter(Boolean).flatMap(hardSplit)
  if (sentences.length === 0) return [text.trim()]

  const chunks: string[] = []
  let buffer = ''

  for (const s of sentences) {
    if (buffer && buffer.length + s.length + 1 > MAX_CHUNK_CHARS) {
      chunks.push(buffer)
      buffer = s
    } else {
      buffer = buffer ? `${buffer} ${s}` : s
    }
  }
  if (buffer) chunks.push(buffer)
  return chunks
}

export function splitInput(text: string, separateLines: boolean): string[] {
  const normalized = text.trim()
  if (!normalized) return []
  if (!separateLines) return [normalized]

  return normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)

  return slug || 'bettertts-audio'
}

export type DialogLine = {
  speaker: string | null
  text: string
}

const SPEAKER_PREFIX = /^\[speaker:\s*([^\]]+)\]\s*/i

export function parseDialogLines(text: string): DialogLine[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(SPEAKER_PREFIX)
      if (match) return { speaker: match[1].trim(), text: line.slice(match[0].length).trim() }
      return { speaker: null, text: line }
    })
    .filter((d) => d.text.length > 0)
}

export type NarratorRole = 'narration' | 'dialogue'

export type NarratorSegment = {
  role: NarratorRole
  text: string
  speaker?: string
}

const NARRATOR_QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  '“': '”',
  '«': '»',
  '‘': '’',
}

const NARRATOR_SPEAKER_ATTRIBUTION = /(?:^|[.!?]\s+|,\s+)([A-Z][\p{L}\p{M}'’-]*(?:\s+[A-Z][\p{L}\p{M}'’-]*){0,2})\s+(?:said|says|asked|replied|answered|whispered|shouted|muttered|called)\s*,\s*$/u
const NARRATOR_TRAILING_ATTRIBUTION = /^,?\s*([A-Z][\p{L}\p{M}'’-]*(?:\s+[A-Z][\p{L}\p{M}'’-]*){0,2})\s+(?:said|says|asked|replied|answered|whispered|shouted|muttered|called)\b/u

function inferNarratorSpeaker(prefix: string): string | undefined {
  return prefix.match(NARRATOR_SPEAKER_ATTRIBUTION)?.[1]
}

function mergeNarratorSegment(segments: NarratorSegment[], next: NarratorSegment): void {
  if (!next.text) return
  const previous = segments.at(-1)
  if (previous && previous.role === next.role && previous.speaker === next.speaker) {
    previous.text = `${previous.text} ${next.text}`.trim()
    return
  }
  segments.push(next)
}

function splitQuotedNarratorLine(line: string): NarratorSegment[] {
  const segments: NarratorSegment[] = []
  let role: NarratorRole = 'narration'
  let closingQuote: string | null = null
  let speaker: string | undefined
  let buffer = ''
  let closedQuote = false

  const flush = () => {
    const text = buffer.trim()
    buffer = ''
    if (text) mergeNarratorSegment(segments, { role, text, ...(role === 'dialogue' && speaker ? { speaker } : {}) })
  }

  for (const character of line) {
    if (role === 'narration') {
      const matchingClose = NARRATOR_QUOTE_PAIRS[character]
      if (matchingClose) {
        flush()
        role = 'dialogue'
        closingQuote = matchingClose
        speaker = inferNarratorSpeaker(segments.at(-1)?.text ?? '')
        buffer = ''
        continue
      }
    } else if (character === closingQuote) {
      flush()
      role = 'narration'
      closingQuote = null
      speaker = undefined
      closedQuote = true
      continue
    }
    buffer += character
  }

  // An unmatched quote is more likely a measurement or a typo than dialogue.
  // Return the original line so the user gets a clean single-voice fallback
  // instead of losing the opening punctuation or misclassifying the paragraph.
  if (closingQuote && !closedQuote) return line.trim() ? [{ role: 'narration', text: line.trim() }] : []
  const trailingAttribution = role === 'narration' && closedQuote ? buffer.trim().match(NARRATOR_TRAILING_ATTRIBUTION)?.[1] : undefined
  const previous = segments.at(-1)
  if (trailingAttribution && previous?.role === 'dialogue' && !previous.speaker) {
    previous.speaker = trailingAttribution
    previous.text = previous.text.replace(/,\s*$/, '.').trim()
  }
  flush()
  return segments
}

/**
 * Splits long-form text into narration and quoted dialogue segments.
 * Explicit [speaker:Name] lines remain supported and are treated as dialogue;
 * ordinary quoted speech is detected without treating apostrophes as quotes.
 */
export function splitNarratorText(text: string): NarratorSegment[] {
  const segments: NarratorSegment[] = []
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const explicitSpeaker = line.match(SPEAKER_PREFIX)
    if (explicitSpeaker) {
      const content = line.slice(explicitSpeaker[0].length).trim()
      if (content) mergeNarratorSegment(segments, { role: 'dialogue', speaker: explicitSpeaker[1].trim(), text: content })
      continue
    }
    for (const segment of splitQuotedNarratorLine(line)) mergeNarratorSegment(segments, segment)
  }
  return segments
}

export type CleanupOptions = {
  citations: boolean
  urls: boolean
  acronyms: boolean
  markdown: boolean
  footnotes: boolean
  pageArtifacts: boolean
  pdfReflow: boolean
  numbers: boolean
  metadata: boolean
}

export const DEFAULT_CLEANUP: CleanupOptions = {
  citations: true,
  urls: true,
  acronyms: true,
  markdown: true,
  footnotes: true,
  pageArtifacts: true,
  pdfReflow: true,
  numbers: true,
  metadata: true,
}

/**
 * Joins the visual line fragments emitted by PDF text extraction while
 * retaining explicit paragraph breaks. PDF line endings are layout hints, not
 * prose boundaries; a trailing hyphen followed by a letter is a wrapped word.
 */
export function reflowPdfText(input: string): string {
  const paragraphs: string[] = []
  let current = ''

  const flush = () => {
    if (current) paragraphs.push(current)
    current = ''
  }

  for (const rawLine of input.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\u00ad/gu, '').trim()
    if (!line) {
      flush()
      continue
    }

    const startsBlock = /^(?:[•▪◦‣]\s+|\d{1,3}[.)]\s+|[-*+]\s+)/u.test(line)
    if (startsBlock && current) flush()
    if (!current) {
      current = line
      continue
    }

    if (/\p{L}-$/u.test(current) && /^\p{L}/u.test(line)) {
      current = `${current.slice(0, -1)}${line}`
    } else if (/^[,.;:!?%…)}\]]/u.test(line) || /^[\u0027’”»]/u.test(line)) {
      current += line
    } else {
      current += ` ${line}`
    }
  }
  flush()
  return paragraphs.join('\n\n').trim()
}

// Pre-synthesis cleanup for pasted technical/web content. Order matters:
// markdown link syntax must resolve to its text before bare-URL replacement.
export function cleanupText(input: string, opts: CleanupOptions): string {
  let out = input
  if (opts.markdown) {
    out = out
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1')
  }
  if (opts.metadata) {
    out = stripMetadataLines(out)
  }
  if (opts.pageArtifacts) {
    out = stripPageArtifacts(out)
  }
  if (opts.footnotes) {
    out = stripFootnotesAndReferences(out)
  }
  if (opts.urls) {
    out = out.replace(/\bhttps?:\/\/\S+/gi, 'link').replace(/\bwww\.\S+/gi, 'link')
  }
  if (opts.citations) {
    out = out.replace(/\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]/g, '')
  }
  if (opts.numbers) {
    out = normalizeAudiobookNumbers(out)
  }
  if (opts.acronyms) {
    // Letter-space vowel-less ALL-CAPS runs (SQL → S Q L) so the phonemizer
    // spells them; pronounceable acronyms like NASA keep their vowels and pass.
    out = out.replace(/\b[BCDFGHJKLMNPQRSTVWXZ]{2,6}\b/g, (m) => m.split('').join(' '))
  }
  return out.replace(/[ \t]{2,}/g, ' ')
}

const UNIT_NAMES: Record<string, string> = {
  '%': 'percent',
  c: 'degrees Celsius',
  cm: 'centimeters',
  f: 'degrees Fahrenheit',
  ft: 'feet',
  g: 'grams',
  in: 'inches',
  kg: 'kilograms',
  km: 'kilometers',
  lb: 'pounds',
  lbs: 'pounds',
  m: 'meters',
  mg: 'milligrams',
  ml: 'milliliters',
  mm: 'millimeters',
}

const CURRENCY_NAMES: Record<string, [string, string]> = {
  '$': ['dollars', 'cents'],
  '€': ['euros', 'cents'],
  '£': ['pounds', 'pence'],
}

export function normalizeAudiobookNumbers(input: string): string {
  const prosodyTags: string[] = []
  const protectedInput = input.replace(/\[\/?prosody\b[^\]]*\]/gi, (tag) => {
    const index = prosodyTags.push(tag) - 1
    return `\uE000${index}\uE001`
  })
  const normalized = protectedInput
    .replace(/([$€£])\s*(\d{1,7})(?:\.(\d{1,2}))?\b/g, (_, symbol: string, whole: string, cents?: string) => {
      const [major, minor] = CURRENCY_NAMES[symbol] ?? ['units', 'cents']
      const normalizedCents = cents?.padEnd(2, '0').slice(0, 2)
      return normalizedCents && normalizedCents !== '00'
        ? `${Number(whole)} ${major} and ${Number(normalizedCents)} ${minor}`
        : `${Number(whole)} ${major}`
    })
    .replace(/\b(\d+(?:\.\d+)?)\s*(°?\s?(?:kg|mg|km|cm|mm|ml|lbs|lb|ft|%|°C|°F))(?=\s|[.,;:!?)]|$)/gi, (_, value: string, unit: string) => {
      const key = unit.toLowerCase().replace(/\s+/g, '').replace(/^°/, '')
      const label = UNIT_NAMES[key] ?? unit
      return `${speakNumericToken(value)} ${label}`
    })
    // "in", "m", and "g" collide with common English ("1 in 10", "3 in the
    // morning"), so treat them as units only before punctuation or end of line.
    .replace(/\b(\d+(?:\.\d+)?)\s*(in|m|g)(?=[.,;:!?)]|$)/g, (_, value: string, unit: string) => {
      const label = UNIT_NAMES[unit] ?? unit
      return `${speakNumericToken(value)} ${label}`
    })
    .replace(/\b(\d+)\.(\d+)\b/g, (_, whole: string, fraction: string) => `${whole} point ${fraction.split('').join(' ')}`)
  return normalized.replace(/\uE000(\d+)\uE001/g, (_, index: string) => prosodyTags[Number(index)] ?? '')
}

function stripMetadataLines(input: string): string {
  return input
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:ISBN(?:-1[03])?|ISSN|DOI|Library of Congress|Cataloging-in-Publication|Printed in)\b/i.test(line))
    .join('\n')
    .replace(/\bISBN(?:-1[03])?:?\s*(?:97[89][-\s]?)?\d[-\d\s]{8,}\d\b/gi, ' ')
    .replace(/\bDOI:?\s*10\.\d{4,9}\/\S+/gi, ' ')
}

function stripPageArtifacts(input: string): string {
  const lines = input.split(/\r?\n/)
  const counts = new Map<string, number>()
  for (const line of lines) {
    const key = normalizeRepeatedArtifactLine(line)
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return lines
    .filter((line) => {
      if (/^\s*(?:page\s*)?\d{1,4}(?:\s+of\s+\d{1,4})?\s*$/i.test(line)) return false
      const key = normalizeRepeatedArtifactLine(line)
      return !key || (counts.get(key) ?? 0) < 2
    })
    .join('\n')
}

function stripFootnotesAndReferences(input: string): string {
  return input
    .replace(/<\/?sup[^>]*>/gi, '')
    .replace(/(?<=\p{L})[¹²³⁴⁵⁶⁷⁸⁹⁰]+/gu, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:\[\d{1,3}\]|\d{1,3}[.)])\s+\S.{8,}$/i.test(line))
    .join('\n')
    .replace(/(?:^|\n)\s*(?:references|bibliography|endnotes)\s*\n[\s\S]*$/i, ' ')
}

function normalizeRepeatedArtifactLine(line: string): string | null {
  const cleaned = line.replace(/\s+/g, ' ').trim()
  if (cleaned.length < 3 || cleaned.length > 80) return null
  if (/[.!?]"?$/.test(cleaned)) return null
  if (/^\d/.test(cleaned)) return null
  return cleaned.toLowerCase()
}

function speakNumericToken(value: string): string {
  return value.includes('.') ? value.replace('.', ' point ') : value
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export type CompletenessCheck = {
  suspect: boolean
  minExpectedSeconds: number
  speakableChars: number
}

// Silent truncation — an engine dropping the tail of a sentence without any
// error — is the top trust-killer in long-form TTS. Flag audio that is
// implausibly short for its source text: no natural speech exceeds ~45
// speakable characters per second (scaled by the speed setting), so output
// under that floor lost content. Inputs below 80 speakable characters are
// exempt (single words and short lines have too much natural variance).
export function checkSynthesisCompleteness(text: string, audioSeconds: number, speed = 1): CompletenessCheck {
  // Combining marks count as speakable: in Indic scripts the vowel matras are
  // \p{M}, and dropping them would halve the counted length of Hindi text.
  const speakableChars = (text.match(/[\p{L}\p{N}\p{M}]/gu) ?? []).length
  const maxCharsPerSecond = 45 * Math.max(0.5, Math.min(2, speed))
  const minExpectedSeconds = speakableChars / maxCharsPerSecond
  return {
    suspect: speakableChars >= 80 && audioSeconds < minExpectedSeconds,
    minExpectedSeconds,
    speakableChars,
  }
}
