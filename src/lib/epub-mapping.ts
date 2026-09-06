import type { EpubChapter } from './epub.ts'

export const MAX_EPUB_MAPPING_CHAPTERS = 2_000
export const MAX_EPUB_MAPPING_TITLE_CHARS = 500

export type EpubMappingVoiceMixEntry = {
  voiceId: string
  weight: number
}

export type EpubMappingChapter = {
  id: string
  title: string
  text: string
  included: boolean
  voice?: string
  voiceMix?: EpubMappingVoiceMixEntry[]
}

function copyVoiceMix(voiceMix: readonly EpubMappingVoiceMixEntry[] | undefined): EpubMappingVoiceMixEntry[] | undefined {
  if (!voiceMix || voiceMix.length < 2) return undefined
  const entries = voiceMix
    .filter((entry) => entry.voiceId.trim() && Number.isFinite(entry.weight) && entry.weight > 0)
    .map((entry) => ({ voiceId: entry.voiceId.trim(), weight: entry.weight }))
  return entries.length >= 2 ? entries : undefined
}

function copyChapter(chapter: EpubMappingChapter): EpubMappingChapter {
  const voiceMix = copyVoiceMix(chapter.voiceMix)
  return {
    id: chapter.id,
    title: chapter.title,
    text: chapter.text,
    included: chapter.included,
    ...(chapter.voice?.trim() ? { voice: chapter.voice.trim() } : {}),
    ...(voiceMix ? { voiceMix } : {}),
  }
}

function chapterAt(chapters: readonly EpubMappingChapter[], chapterId: string): EpubMappingChapter | undefined {
  return chapters.find((chapter) => chapter.id === chapterId)
}

function mapChapter(
  chapters: readonly EpubMappingChapter[],
  chapterId: string,
  update: (chapter: EpubMappingChapter) => EpubMappingChapter,
): EpubMappingChapter[] {
  return chapters.map((chapter) => chapter.id === chapterId ? update(copyChapter(chapter)) : copyChapter(chapter))
}

export function createEpubMapping(
  chapters: readonly EpubChapter[],
  defaults: { voice?: string; voiceMix?: readonly EpubMappingVoiceMixEntry[] } = {},
): EpubMappingChapter[] {
  return chapters.slice(0, MAX_EPUB_MAPPING_CHAPTERS).map((chapter, index) => {
    const voiceMix = copyVoiceMix(defaults.voiceMix)
    return {
      id: `epub-chapter-${index + 1}`,
      title: chapter.title.trim().slice(0, MAX_EPUB_MAPPING_TITLE_CHARS) || `Chapter ${index + 1}`,
      text: chapter.text,
      included: true,
      ...(defaults.voice?.trim() ? { voice: defaults.voice.trim() } : {}),
      ...(voiceMix ? { voiceMix } : {}),
    }
  })
}

export function renameEpubChapter(
  chapters: readonly EpubMappingChapter[],
  chapterId: string,
  title: string,
): EpubMappingChapter[] {
  if (!chapterAt(chapters, chapterId)) return chapters.map(copyChapter)
  const nextTitle = title.trim().slice(0, MAX_EPUB_MAPPING_TITLE_CHARS)
  return mapChapter(chapters, chapterId, (chapter) => ({
    ...chapter,
    title: nextTitle || chapter.title,
  }))
}

export function setEpubChapterIncluded(
  chapters: readonly EpubMappingChapter[],
  chapterId: string,
  included: boolean,
): EpubMappingChapter[] {
  if (!chapterAt(chapters, chapterId)) return chapters.map(copyChapter)
  return mapChapter(chapters, chapterId, (chapter) => ({ ...chapter, included }))
}

export function setEpubChapterVoice(
  chapters: readonly EpubMappingChapter[],
  chapterId: string,
  voice: string | undefined,
): EpubMappingChapter[] {
  if (!chapterAt(chapters, chapterId)) return chapters.map(copyChapter)
  return mapChapter(chapters, chapterId, (chapter) => ({
    ...chapter,
    ...(voice?.trim() ? { voice: voice.trim() } : { voice: undefined }),
  }))
}

export function setEpubChapterVoiceMix(
  chapters: readonly EpubMappingChapter[],
  chapterId: string,
  voiceMix: readonly EpubMappingVoiceMixEntry[] | undefined,
): EpubMappingChapter[] {
  if (!chapterAt(chapters, chapterId)) return chapters.map(copyChapter)
  return mapChapter(chapters, chapterId, (chapter) => ({
    ...chapter,
    ...(copyVoiceMix(voiceMix) ? { voiceMix: copyVoiceMix(voiceMix) } : { voiceMix: undefined }),
  }))
}

export function updateEpubChapterVoiceMixEntry(
  chapters: readonly EpubMappingChapter[],
  chapterId: string,
  entryIndex: number,
  patch: Partial<EpubMappingVoiceMixEntry>,
): EpubMappingChapter[] {
  const chapter = chapterAt(chapters, chapterId)
  if (!chapter?.voiceMix || entryIndex < 0 || entryIndex >= chapter.voiceMix.length) return chapters.map(copyChapter)
  return setEpubChapterVoiceMix(chapters, chapterId, chapter.voiceMix.map((entry, index) => (
    index === entryIndex
      ? {
          voiceId: typeof patch.voiceId === 'string' ? patch.voiceId : entry.voiceId,
          weight: typeof patch.weight === 'number' ? patch.weight : entry.weight,
        }
      : entry
  )))
}

export function addEpubChapterVoiceMixEntry(
  chapters: readonly EpubMappingChapter[],
  chapterId: string,
  entry: EpubMappingVoiceMixEntry,
): EpubMappingChapter[] {
  const chapter = chapterAt(chapters, chapterId)
  if (!chapter?.voiceMix || chapter.voiceMix.length >= 4) return chapters.map(copyChapter)
  return setEpubChapterVoiceMix(chapters, chapterId, [...chapter.voiceMix, entry])
}

export function removeEpubChapterVoiceMixEntry(
  chapters: readonly EpubMappingChapter[],
  chapterId: string,
  entryIndex: number,
): EpubMappingChapter[] {
  const chapter = chapterAt(chapters, chapterId)
  if (!chapter?.voiceMix || chapter.voiceMix.length <= 2 || entryIndex < 0 || entryIndex >= chapter.voiceMix.length) {
    return chapters.map(copyChapter)
  }
  return setEpubChapterVoiceMix(chapters, chapterId, chapter.voiceMix.filter((_, index) => index !== entryIndex))
}

function chooseSplitOffset(text: string, requested?: number): number {
  if (text.length < 2) return 0
  const middle = requested === undefined
    ? Math.floor(text.length / 2)
    : Math.max(1, Math.min(text.length - 1, Math.floor(requested)))
  const paragraphBreaks = [...text.matchAll(/\n\s*\n/gu)]
    .map((match) => (match.index ?? 0) + match[0].length)
    .filter((offset) => offset > 0 && offset < text.length)
  if (requested === undefined && paragraphBreaks.length > 0) {
    return paragraphBreaks.reduce((closest, offset) => Math.abs(offset - middle) < Math.abs(closest - middle) ? offset : closest)
  }
  for (let distance = 0; distance <= text.length; distance += 1) {
    const candidates = [middle - distance, middle + distance]
    for (const offset of candidates) {
      if (offset > 0 && offset < text.length && /\s/u.test(text[offset - 1])) return offset
    }
  }
  return middle
}

export function splitEpubChapter(
  chapters: readonly EpubMappingChapter[],
  chapterId: string,
  requestedOffset?: number,
): EpubMappingChapter[] {
  const index = chapters.findIndex((chapter) => chapter.id === chapterId)
  const chapter = index >= 0 ? chapters[index] : undefined
  if (!chapter || chapters.length >= MAX_EPUB_MAPPING_CHAPTERS || chapter.text.trim().length < 2) return chapters.map(copyChapter)
  const offset = chooseSplitOffset(chapter.text, requestedOffset)
  const leftText = chapter.text.slice(0, offset).trim()
  const rightText = chapter.text.slice(offset).trim()
  if (!leftText || !rightText) return chapters.map(copyChapter)
  const first = copyChapter(chapter)
  const second = copyChapter(chapter)
  first.id = `${chapter.id}-a`
  second.id = `${chapter.id}-b`
  first.title = `${chapter.title}, part 1`.slice(0, MAX_EPUB_MAPPING_TITLE_CHARS)
  second.title = `${chapter.title}, part 2`.slice(0, MAX_EPUB_MAPPING_TITLE_CHARS)
  first.text = leftText
  second.text = rightText
  return [...chapters.slice(0, index), first, second, ...chapters.slice(index + 1)].map(copyChapter)
}

export function mergeEpubChapterWithNext(
  chapters: readonly EpubMappingChapter[],
  chapterId: string,
): EpubMappingChapter[] {
  const index = chapters.findIndex((chapter) => chapter.id === chapterId)
  if (index < 0 || index >= chapters.length - 1) return chapters.map(copyChapter)
  const first = copyChapter(chapters[index])
  const second = copyChapter(chapters[index + 1])
  const voiceMix = first.voiceMix ?? second.voiceMix
  const voice = first.voice ?? second.voice
  const merged: EpubMappingChapter = {
    ...first,
    title: first.title || second.title,
    text: [first.text.trim(), second.text.trim()].filter(Boolean).join('\n\n'),
    included: first.included || second.included,
    ...(voice ? { voice } : {}),
    ...(voiceMix ? { voiceMix: copyVoiceMix(voiceMix) } : {}),
  }
  return [...chapters.slice(0, index), merged, ...chapters.slice(index + 2)].map(copyChapter)
}

export function reorderEpubChapter(
  chapters: readonly EpubMappingChapter[],
  chapterId: string,
  delta: -1 | 1,
): EpubMappingChapter[] {
  const index = chapters.findIndex((chapter) => chapter.id === chapterId)
  const target = index + delta
  if (index < 0 || target < 0 || target >= chapters.length) return chapters.map(copyChapter)
  const next = chapters.map(copyChapter)
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  return next
}

export function includedEpubChapters(chapters: readonly EpubMappingChapter[]): Array<{ title: string; text: string }> {
  return chapters
    .filter((chapter) => chapter.included && chapter.text.trim())
    .map((chapter) => ({ title: chapter.title.trim() || 'Untitled chapter', text: chapter.text }))
}
