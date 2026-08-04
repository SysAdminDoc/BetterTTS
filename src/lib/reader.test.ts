import { describe, expect, it } from 'vitest'
import {
  buildReaderCueBindings,
  createReaderDocument,
  flattenReaderSentences,
  loadReaderResume,
  normalizeReaderText,
  saveReaderResume,
  sentenceParts,
} from './reader.ts'
import type { Cue } from './subtitles.ts'

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

describe('reader document coordinates', () => {
  it('builds stable chapter, paragraph, sentence, and word ids', () => {
    const input = { kind: 'article' as const, title: 'A story', text: 'First sentence. Second sentence.\n\nA new paragraph.' }
    const first = createReaderDocument(input)
    const second = createReaderDocument(input)
    expect(first.id).toBe(second.id)
    expect(first.chapters[0].paragraphs).toHaveLength(2)
    expect(first.chapters[0].paragraphs[0].sentences[0].id).toBe('reader-c0-p0-s0')
    expect(first.chapters[0].paragraphs[0].sentences[0].words.map((word) => word.text)).toEqual(['First', 'sentence'])
  })

  it('splits punctuation without losing the source range', () => {
    const parts = sentenceParts('Hello!  How are you?')
    expect(parts.map((part) => part.text)).toEqual(['Hello!', 'How are you?'])
    expect('Hello!  How are you?'.slice(parts[1].start, parts[1].end)).toBe(parts[1].text)
  })

  it('binds a combined sentence cue to stable document sentences', () => {
    const document = createReaderDocument({ kind: 'article', title: 'Cue test', text: 'First sentence. Second sentence.' })
    const cues: Cue[] = [{ index: 1, startSec: 0, endSec: 4, text: 'First sentence. Second sentence.' }]
    const bindings = buildReaderCueBindings(document, 'First sentence. Second sentence.', cues)
    expect(bindings.map((binding) => binding.sentenceId)).toEqual(['reader-c0-p0-s0', 'reader-c0-p0-s1'])
    expect(bindings[0].startSec).toBe(0)
    expect(bindings[1].startSec).toBeGreaterThan(bindings[0].startSec)
  })

  it('binds word cues to word ids instead of DOM positions', () => {
    const document = createReaderDocument({ kind: 'article', title: 'Word test', text: 'Hello world.' })
    const cues: Cue[] = [
      { index: 1, startSec: 0, endSec: 0.5, text: 'Hello' },
      { index: 2, startSec: 0.5, endSec: 1, text: 'world' },
    ]
    const bindings = buildReaderCueBindings(document, 'Hello world.', cues)
    expect(bindings.map((binding) => binding.wordId)).toEqual(['reader-c0-p0-s0-w0', 'reader-c0-p0-s0-w1'])
  })

  it('persists a bounded per-document resume coordinate', () => {
    const store = storage()
    saveReaderResume('reader-test', { chapterIndex: 2, sentenceId: 'reader-c2-p1-s0', wordId: 'reader-c2-p1-s0-w1', timeSec: 12.5 }, store)
    expect(loadReaderResume('reader-test', store)).toMatchObject({ chapterIndex: 2, sentenceId: 'reader-c2-p1-s0', wordId: 'reader-c2-p1-s0-w1', timeSec: 12.5 })
    expect(loadReaderResume('missing', store)).toBeNull()
  })

  it('normalizes matching text across punctuation and case changes', () => {
    expect(normalizeReaderText('“Hello,” WORLD!')).toBe('hello world')
    expect(flattenReaderSentences(createReaderDocument({ kind: 'text', title: 'Empty', text: '' }))).toEqual([])
  })
})
