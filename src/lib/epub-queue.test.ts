import { describe, expect, it } from 'vitest'
import { buildEpubQueueChunks } from './epub-queue.ts'

describe('EPUB queue planning', () => {
  it('preserves chapter metadata while enforcing the total chunk cap', () => {
    const chapters = [
      { title: 'One', text: 'a|b' },
      { title: 'Two', text: 'c' },
    ]
    const chunks = buildEpubQueueChunks(chapters, (text) => text, (text) => text.split('|'), 3)
    expect(chunks).toEqual([
      { title: 'One', chapterIndex: 0, text: 'a' },
      { title: 'One', chapterIndex: 0, text: 'b' },
      { title: 'Two', chapterIndex: 1, text: 'c' },
    ])
    expect(() => buildEpubQueueChunks(chapters, (text) => text, (text) => text.split('|'), 2)).toThrow('queue chunks')
  })

  it('splits oversized chapter text without silently truncating it', () => {
    const chunks = buildEpubQueueChunks(
      [{ title: 'Long', text: 'alpha beta gamma' }],
      (text) => text,
      (text) => [text],
      10,
      6,
    )
    expect(chunks.map((chunk) => chunk.text).join(' ')).toBe('alpha beta gamma')
    expect(chunks.every((chunk) => chunk.text.length <= 6)).toBe(true)
  })
})
