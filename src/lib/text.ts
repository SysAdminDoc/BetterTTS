export type TextSegment = { type: 'text'; content: string } | { type: 'pause'; duration: number }

export const PAUSE_TAG = /\[pause(?:\s+([\d.]+)\s*s?)?\]/gi

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
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).flatMap(hardSplit)
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

export type CleanupOptions = {
  citations: boolean
  urls: boolean
  acronyms: boolean
  markdown: boolean
  footnotes: boolean
  pageArtifacts: boolean
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
  numbers: true,
  metadata: true,
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
  return input
    .replace(/([$€£])\s*(\d{1,7})(?:\.(\d{1,2}))?\b/g, (_, symbol: string, whole: string, cents?: string) => {
      const [major, minor] = CURRENCY_NAMES[symbol] ?? ['units', 'cents']
      const normalizedCents = cents?.padEnd(2, '0').slice(0, 2)
      return normalizedCents && normalizedCents !== '00'
        ? `${Number(whole)} ${major} and ${Number(normalizedCents)} ${minor}`
        : `${Number(whole)} ${major}`
    })
    .replace(/\b(\d+(?:\.\d+)?)\s*(°?\s?(?:kg|mg|g|km|cm|mm|ml|lbs|lb|ft|in|m|%|°C|°F))(?=\s|[.,;:!?)]|$)/gi, (_, value: string, unit: string) => {
      const key = unit.toLowerCase().replace(/\s+/g, '').replace(/^°/, '')
      const label = UNIT_NAMES[key] ?? unit
      return `${speakNumericToken(value)} ${label}`
    })
    .replace(/\b(\d+)\.(\d+)\b/g, (_, whole: string, fraction: string) => `${whole} point ${fraction.split('').join(' ')}`)
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
