import { describe, expect, it } from 'vitest'
import {
  addEpubChapterVoiceMixEntry,
  createEpubMapping,
  includedEpubChapters,
  mergeEpubChapterWithNext,
  removeEpubChapterVoiceMixEntry,
  renameEpubChapter,
  reorderEpubChapter,
  setEpubChapterIncluded,
  setEpubChapterVoice,
  setEpubChapterVoiceMix,
  splitEpubChapter,
  updateEpubChapterVoiceMixEntry,
} from './epub-mapping.ts'

const source = [
  { title: 'First', text: 'Alpha paragraph.\n\nBeta paragraph.' },
  { title: 'Second', text: 'Gamma paragraph.' },
  { title: 'Third', text: 'Delta paragraph.' },
]

describe('EPUB chapter mapping', () => {
  it('creates stable editable chapters and filters excluded output', () => {
    const mapping = createEpubMapping(source, { voice: 'af_heart' })
    expect(mapping.map((chapter) => chapter.id)).toEqual(['epub-chapter-1', 'epub-chapter-2', 'epub-chapter-3'])
    const excluded = setEpubChapterIncluded(mapping, mapping[1].id, false)
    expect(includedEpubChapters(excluded)).toEqual([
      { title: 'First', text: source[0].text },
      { title: 'Third', text: source[2].text },
    ])
    expect(excluded[0].voice).toBe('af_heart')
  })

  it('renames, reorders, and merges adjacent chapters without mutating the input', () => {
    const mapping = createEpubMapping(source)
    const renamed = renameEpubChapter(mapping, mapping[1].id, 'Renamed')
    const reordered = reorderEpubChapter(renamed, mapping[1].id, -1)
    const merged = mergeEpubChapterWithNext(reordered, mapping[1].id)
    expect(mapping.map((chapter) => chapter.title)).toEqual(['First', 'Second', 'Third'])
    expect(merged).toHaveLength(2)
    expect(merged[0].title).toBe('Renamed')
    expect(merged[0].text).toContain('Alpha paragraph.')
    expect(merged[0].text).toContain('Gamma paragraph.')
  })

  it('splits at a paragraph boundary and preserves assignment metadata', () => {
    const mapping = createEpubMapping(source, {
      voice: 'af_bella',
      voiceMix: [{ voiceId: 'af_heart', weight: 2 }, { voiceId: 'af_bella', weight: 1 }],
    })
    const split = splitEpubChapter(mapping, mapping[0].id)
    expect(split).toHaveLength(4)
    expect(split.slice(0, 2).map((chapter) => chapter.title)).toEqual(['First — 1', 'First — 2'])
    expect(split[0].text).toBe('Alpha paragraph.')
    expect(split[1].text).toBe('Beta paragraph.')
    expect(split[0].voiceMix).toEqual(mapping[0].voiceMix)
    expect(split[1].voice).toBe('af_bella')
  })

  it('edits and removes per-chapter blend entries', () => {
    const mapping = createEpubMapping(source)
    const chapterId = mapping[0].id
    let next = setEpubChapterVoiceMix(mapping, chapterId, [
      { voiceId: 'af_heart', weight: 2 },
      { voiceId: 'af_bella', weight: 1 },
    ])
    next = updateEpubChapterVoiceMixEntry(next, chapterId, 1, { voiceId: 'af_nova', weight: 3 })
    next = addEpubChapterVoiceMixEntry(next, chapterId, { voiceId: 'af_sky', weight: 1 })
    expect(next[0].voiceMix).toEqual([
      { voiceId: 'af_heart', weight: 2 },
      { voiceId: 'af_nova', weight: 3 },
      { voiceId: 'af_sky', weight: 1 },
    ])
    next = removeEpubChapterVoiceMixEntry(next, chapterId, 1)
    expect(next[0].voiceMix).toEqual([
      { voiceId: 'af_heart', weight: 2 },
      { voiceId: 'af_sky', weight: 1 },
    ])
    next = setEpubChapterVoice(next, chapterId, undefined)
    expect(next[0].voice).toBeUndefined()
  })
})
