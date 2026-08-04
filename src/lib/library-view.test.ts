import { describe, expect, it } from 'vitest'
import type { ClipRecord } from './library.ts'
import { DEFAULT_LIBRARY_FILTERS, libraryEngineId, parseDurationSeconds, selectLibraryClips, summarizeLibraryStorage } from './library-view.ts'

function clip(overrides: Partial<ClipRecord> = {}): ClipRecord {
  return {
    id: 'clip',
    filename: 'clip.wav',
    label: 'Clip',
    voice: 'af_heart',
    speed: 1,
    createdAt: 100,
    size: 100,
    duration: '10.0s',
    ...overrides,
  }
}

describe('library view', () => {
  it('parses the duration formats used by saved clips', () => {
    expect(parseDurationSeconds('3.0s')).toBe(3)
    expect(parseDurationSeconds('1m 5s')).toBe(65)
    expect(parseDurationSeconds('1:02:03.5')).toBe(3723.5)
    expect(parseDurationSeconds('native')).toBeNull()
  })

  it('searches labels and filenames without loading audio blobs', () => {
    const clips = selectLibraryClips([
      clip({ id: 'alpha', label: 'Morning read' }),
      clip({ id: 'beta', filename: 'chapter-two.wav', label: 'Evening read' }),
    ], { ...DEFAULT_LIBRARY_FILTERS, query: 'chapter-two' })
    expect(clips.map((item) => item.id)).toEqual(['beta'])
  })

  it('filters by voice, engine, and cue presence', () => {
    const clips = [
      clip({ id: 'kokoro', engine: 'kokoro', voice: 'af_heart', cues: [{ index: 1, startSec: 0, endSec: 1, text: 'Cue' }] }),
      clip({ id: 'supertonic', engine: 'supertonic', voice: 'M1', cues: undefined }),
    ]
    expect(selectLibraryClips(clips, { ...DEFAULT_LIBRARY_FILTERS, voice: 'M1' }).map((item) => item.id)).toEqual(['supertonic'])
    expect(selectLibraryClips(clips, { ...DEFAULT_LIBRARY_FILTERS, engine: 'kokoro', cues: 'with-cues' }).map((item) => item.id)).toEqual(['kokoro'])
    expect(selectLibraryClips(clips, { ...DEFAULT_LIBRARY_FILTERS, cues: 'without-cues' }).map((item) => item.id)).toEqual(['supertonic'])
  })

  it('sorts by creation, duration, and size in either direction', () => {
    const clips = [
      clip({ id: 'old', createdAt: 1, duration: '2s', size: 300 }),
      clip({ id: 'new', createdAt: 3, duration: '1m', size: 100 }),
      clip({ id: 'middle', createdAt: 2, duration: '10s', size: 200 }),
    ]
    expect(selectLibraryClips(clips, DEFAULT_LIBRARY_FILTERS, 'created-desc').map((item) => item.id)).toEqual(['new', 'middle', 'old'])
    expect(selectLibraryClips(clips, DEFAULT_LIBRARY_FILTERS, 'duration-desc').map((item) => item.id)).toEqual(['new', 'middle', 'old'])
    expect(selectLibraryClips(clips, DEFAULT_LIBRARY_FILTERS, 'size-asc').map((item) => item.id)).toEqual(['new', 'middle', 'old'])
  })

  it('keeps clips with an unknown duration at the end of sorted results', () => {
    const clips = selectLibraryClips([
      clip({ id: 'unknown', duration: 'native' }),
      clip({ id: 'known', duration: '5s' }),
    ], DEFAULT_LIBRARY_FILTERS, 'duration-desc')
    expect(clips.map((item) => item.id)).toEqual(['known', 'unknown'])
  })

  it('derives legacy engine identity without inventing a capability', () => {
    expect(libraryEngineId(clip())).toBe('unknown')
    expect(libraryEngineId(clip({ engine: 'piper' }))).toBe('piper')
  })

  it('summarizes usage against the bounded clip budget', () => {
    const summary = summarizeLibraryStorage([clip({ id: 'old', size: 60, createdAt: 1 }), clip({ id: 'new', size: 55, createdAt: 2 })], 100)
    expect(summary).toMatchObject({
      clipCount: 2,
      totalBytes: 115,
      remainingBytes: 0,
      percentUsed: 100,
      overCap: true,
      oldestClipId: 'old',
    })
  })

  it('handles an empty library summary', () => {
    expect(summarizeLibraryStorage([], 100)).toMatchObject({ clipCount: 0, totalBytes: 0, percentUsed: 0, oldestClipId: null })
  })
})
