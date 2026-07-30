import type { EpubChapter } from './epub.ts'

export const MAX_EPUB_QUEUE_CHUNKS = 10_000
export const MAX_EPUB_QUEUE_CHUNK_CHARS = 5_000

export type EpubQueueSourceChunk = {
  title: string
  chapterIndex: number
  text: string
}

export function buildEpubQueueChunks(
  chapters: readonly EpubChapter[],
  prepareText: (text: string) => string,
  splitText: (text: string) => string[],
  maxChunks = MAX_EPUB_QUEUE_CHUNKS,
  maxChunkChars = MAX_EPUB_QUEUE_CHUNK_CHARS,
): EpubQueueSourceChunk[] {
  const chunks: EpubQueueSourceChunk[] = []
  for (const [chapterIndex, chapter] of chapters.entries()) {
    const chapterChunks = splitText(prepareText(chapter.text))
    for (const text of chapterChunks) {
      let remaining = text.trim()
      while (remaining) {
        let cut = Math.min(remaining.length, maxChunkChars)
        if (cut < remaining.length) {
          const wordBoundary = remaining.lastIndexOf(' ', cut)
          if (wordBoundary >= Math.floor(maxChunkChars * 0.5)) cut = wordBoundary
          const codeUnit = remaining.charCodeAt(cut - 1)
          if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) cut -= 1
        }
        const bounded = remaining.slice(0, cut).trim()
        remaining = remaining.slice(cut).trim()
        if (!bounded) continue
        if (chunks.length >= maxChunks) {
          throw new Error(`EPUB would create more than ${maxChunks.toLocaleString()} queue chunks.`)
        }
        chunks.push({ title: chapter.title, chapterIndex, text: bounded })
      }
    }
  }
  return chunks
}
