import type { Cue } from './subtitles.ts'

export type ReaderSourceKind = 'epub' | 'article' | 'pdf' | 'docx' | 'text'

export type ReaderWord = {
  id: string
  text: string
  start: number
  end: number
}

export type ReaderSentence = {
  id: string
  text: string
  start: number
  end: number
  words: ReaderWord[]
}

export type ReaderParagraph = {
  id: string
  text: string
  sentences: ReaderSentence[]
}

export type ReaderChapter = {
  id: string
  title: string
  paragraphs: ReaderParagraph[]
}

export type ReaderDocument = {
  id: string
  kind: ReaderSourceKind
  title: string
  chapters: ReaderChapter[]
}

export type ReaderSourceChapter = {
  title: string
  text: string
}

export type ReaderCueBinding = {
  cueIndex: number
  sentenceId: string
  wordId?: string
  startSec: number
  endSec: number
  text: string
}

export type ReaderResume = {
  chapterIndex: number
  sentenceId?: string
  wordId?: string
  timeSec?: number
  updatedAt: number
}

const READER_STORAGE_PREFIX = 'bettertts-reader-v1:'

export function createReaderDocument(input: {
  kind: ReaderSourceKind
  title: string
  text?: string
  chapters?: readonly ReaderSourceChapter[]
}): ReaderDocument {
  const sourceChapters = input.chapters && input.chapters.length > 0
    ? input.chapters
    : [{ title: '', text: input.text ?? '' }]
  const normalizedTitle = input.title.trim() || 'Untitled reading'
  const chapters = sourceChapters
    .map((chapter, chapterIndex) => buildChapter(chapter, chapterIndex))
    .filter((chapter) => chapter.paragraphs.length > 0)

  const sourceFingerprint = sourceChapters
    .map((chapter) => `${chapter.title}\n${chapter.text}`)
    .join('\n\u0000')
  return {
    id: `reader-${hashString(`${input.kind}\n${normalizedTitle}\n${sourceFingerprint}`)}`,
    kind: input.kind,
    title: normalizedTitle,
    chapters,
  }
}

export function flattenReaderSentences(document: ReaderDocument): ReaderSentence[] {
  return document.chapters.flatMap((chapter) => chapter.paragraphs.flatMap((paragraph) => paragraph.sentences))
}

export function findReaderSentence(document: ReaderDocument, sentenceId: string): ReaderSentence | null {
  return flattenReaderSentences(document).find((sentence) => sentence.id === sentenceId) ?? null
}

export function normalizeReaderText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function buildReaderCueBindings(
  document: ReaderDocument,
  sourceText: string,
  cues: readonly Cue[],
): ReaderCueBinding[] {
  if (!sourceText.trim() || cues.length === 0) return []
  const sourceSentences = sentenceParts(sourceText)
  const documentSentences = flattenReaderSentences(document)
  if (sourceSentences.length === 0 || documentSentences.length === 0) return []

  const targets = matchSourceSentences(sourceSentences, documentSentences)
  if (isWordCueSet(sourceSentences, cues)) {
    return bindWordCues(sourceSentences, targets, cues)
  }
  return bindSentenceCues(sourceSentences, targets, cues)
}

export function readerCueAtTime(bindings: readonly ReaderCueBinding[], timeSec: number): ReaderCueBinding | null {
  if (!Number.isFinite(timeSec) || bindings.length === 0) return null
  return bindings.find((binding) => timeSec >= binding.startSec && timeSec < binding.endSec)
    ?? [...bindings].reverse().find((binding) => timeSec >= binding.startSec)
    ?? null
}

export function loadReaderResume(documentId: string, storage: Pick<Storage, 'getItem'> | null = browserStorage()): ReaderResume | null {
  if (!storage || !documentId.trim()) return null
  try {
    const raw = JSON.parse(storage.getItem(readerStorageKey(documentId)) ?? 'null') as Partial<ReaderResume> | null
    if (!raw || !Number.isSafeInteger(raw.chapterIndex) || Number(raw.chapterIndex) < 0 || !Number.isFinite(raw.updatedAt)) return null
    return {
      chapterIndex: Number(raw.chapterIndex),
      ...(typeof raw.sentenceId === 'string' && raw.sentenceId.length <= 240 ? { sentenceId: raw.sentenceId } : {}),
      ...(typeof raw.wordId === 'string' && raw.wordId.length <= 280 ? { wordId: raw.wordId } : {}),
      ...(Number.isFinite(raw.timeSec) && Number(raw.timeSec) >= 0 ? { timeSec: Number(raw.timeSec) } : {}),
      updatedAt: Math.max(0, Number(raw.updatedAt)),
    }
  } catch {
    return null
  }
}

export function saveReaderResume(
  documentId: string,
  resume: Omit<ReaderResume, 'updatedAt'> & { updatedAt?: number },
  storage: Pick<Storage, 'setItem'> | null = browserStorage(),
): void {
  if (!storage || !documentId.trim() || !Number.isSafeInteger(resume.chapterIndex) || resume.chapterIndex < 0) return
  try {
    storage.setItem(readerStorageKey(documentId), JSON.stringify({
      chapterIndex: resume.chapterIndex,
      ...(resume.sentenceId?.trim() ? { sentenceId: resume.sentenceId.slice(0, 240) } : {}),
      ...(resume.wordId?.trim() ? { wordId: resume.wordId.slice(0, 280) } : {}),
      ...(Number.isFinite(resume.timeSec) && Number(resume.timeSec) >= 0 ? { timeSec: Number(resume.timeSec) } : {}),
      updatedAt: resume.updatedAt ?? Date.now(),
    } satisfies ReaderResume))
  } catch {
    // Private browsing and quota failures should never stop reading or playback.
  }
}

export function readerStorageKey(documentId: string): string {
  return `${READER_STORAGE_PREFIX}${documentId}`
}

export function sentenceParts(text: string): Array<{ text: string; start: number; end: number; words: ReaderWord[] }> {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  const parts: Array<{ text: string; start: number; end: number; words: ReaderWord[] }> = []
  const pattern = /[^.!?。！？।॥]+(?:[.!?。！？।॥]+|$)/gu
  for (const match of normalized.matchAll(pattern)) {
    const raw = match[0]
    const leading = raw.search(/\S/u)
    if (leading < 0) continue
    const start = (match.index ?? 0) + leading
    const value = raw.trim()
    const end = start + value.length
    parts.push({ text: value, start, end, words: wordParts(value, start) })
  }
  if (parts.length > 0) return parts
  return [{ text: normalized, start: 0, end: normalized.length, words: wordParts(normalized, 0) }]
}

function buildChapter(source: ReaderSourceChapter, chapterIndex: number): ReaderChapter {
  const title = source.title.trim()
  const paragraphs = splitParagraphs(source.text).map((text, paragraphIndex) => {
    const paragraphId = `reader-c${chapterIndex}-p${paragraphIndex}`
    const sentences = sentenceParts(text).map((part, sentenceIndex) => ({
      id: `${paragraphId}-s${sentenceIndex}`,
      text: part.text,
      start: part.start,
      end: part.end,
      words: part.words.map((word, wordIndex) => ({ ...word, id: `${paragraphId}-s${sentenceIndex}-w${wordIndex}` })),
    }))
    return { id: paragraphId, text, sentences }
  })
  return {
    id: `reader-c${chapterIndex}`,
    title: title || `Chapter ${chapterIndex + 1}`,
    paragraphs,
  }
}

function splitParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
  return normalized
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
}

function wordParts(text: string, offset: number): ReaderWord[] {
  const words: ReaderWord[] = []
  const pattern = /[\p{L}\p{M}\p{N}]+(?:['’_-][\p{L}\p{M}\p{N}]+)*/gu
  for (const match of text.matchAll(pattern)) {
    const start = offset + (match.index ?? 0)
    words.push({ id: '', text: match[0], start, end: start + match[0].length })
  }
  return words
}

function matchSourceSentences(
  sourceSentences: Array<{ text: string; start: number; end: number; words: ReaderWord[] }>,
  documentSentences: ReaderSentence[],
): ReaderSentence[] {
  const targets: ReaderSentence[] = []
  let cursor = 0
  for (const source of sourceSentences) {
    const normalized = normalizeReaderText(source.text)
    let targetIndex = documentSentences.findIndex((candidate, index) => index >= cursor && normalizeReaderText(candidate.text) === normalized)
    if (targetIndex < 0) {
      targetIndex = documentSentences.findIndex((candidate, index) => index >= cursor && (
        normalizeReaderText(candidate.text).includes(normalized) || normalized.includes(normalizeReaderText(candidate.text))
      ))
    }
    if (targetIndex < 0) targetIndex = Math.min(cursor, documentSentences.length - 1)
    const target = documentSentences[targetIndex]
    if (target) {
      targets.push(target)
      cursor = Math.max(cursor, targetIndex + 1)
    }
  }
  return targets
}

function isWordCueSet(
  sourceSentences: Array<{ text: string; start: number; end: number; words: ReaderWord[] }>,
  cues: readonly Cue[],
): boolean {
  const sourceWordCount = sourceSentences.reduce((total, sentence) => total + sentence.words.length, 0)
  const shortCueCount = cues.filter((cue) => cue.text.trim().length > 0 && cue.text.trim().length <= 80 && wordParts(cue.text, 0).length <= 1).length
  return sourceWordCount > sourceSentences.length && cues.length > sourceSentences.length && shortCueCount >= Math.floor(cues.length * 0.7)
}

function bindWordCues(
  sourceSentences: Array<{ text: string; start: number; end: number; words: ReaderWord[] }>,
  targets: ReaderSentence[],
  cues: readonly Cue[],
): ReaderCueBinding[] {
  const bindings: ReaderCueBinding[] = []
  let cueCursor = 0
  for (let sentenceIndex = 0; sentenceIndex < sourceSentences.length && sentenceIndex < targets.length; sentenceIndex += 1) {
    const source = sourceSentences[sentenceIndex]
    const target = targets[sentenceIndex]
    const count = Math.min(source.words.length, cues.length - cueCursor, target.words.length)
    for (let wordIndex = 0; wordIndex < count; wordIndex += 1) {
      const cue = cues[cueCursor + wordIndex]
      const word = target.words[wordIndex]
      if (cue && word && cue.endSec > cue.startSec) {
        bindings.push({
          cueIndex: cue.index,
          sentenceId: target.id,
          wordId: word.id,
          startSec: Math.max(0, cue.startSec),
          endSec: Math.max(cue.startSec, cue.endSec),
          text: cue.text,
        })
      }
    }
    cueCursor += count
  }
  return bindings
}

function bindSentenceCues(
  sourceSentences: Array<{ text: string; start: number; end: number; words: ReaderWord[] }>,
  targets: ReaderSentence[],
  cues: readonly Cue[],
): ReaderCueBinding[] {
  const bindings: ReaderCueBinding[] = []
  let sourceCursor = 0
  for (const cue of cues) {
    if (cue.endSec <= cue.startSec) continue
    const parts = sentenceParts(cue.text)
    const usableParts = parts.length > 0 ? parts : [{ text: cue.text, start: 0, end: cue.text.length, words: [] }]
    const totalChars = usableParts.reduce((total, part) => total + Math.max(1, part.text.length), 0)
    let elapsed = cue.startSec
    for (const part of usableParts) {
      const source = sourceSentences[sourceCursor]
      const target = targets[sourceCursor]
      if (!source || !target) break
      const duration = (cue.endSec - cue.startSec) * (Math.max(1, part.text.length) / totalChars)
      bindings.push({
        cueIndex: cue.index,
        sentenceId: target.id,
        startSec: elapsed,
        endSec: Math.max(elapsed, Math.min(cue.endSec, elapsed + duration)),
        text: part.text,
      })
      elapsed += duration
      sourceCursor += 1
    }
  }
  return bindings
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function hashString(value: string): string {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
