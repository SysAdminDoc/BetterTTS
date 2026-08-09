export type AudiobookInteropFixture = {
  id: string
  title: string
  language: string
  narrator: string
  cover: {
    mimeType: 'image/jpeg' | 'image/png'
    bytes: Uint8Array
  }
  chapters: readonly [
    { title: string; paragraphs: readonly string[] },
    { title: string; paragraphs: readonly string[] },
  ]
}

// This fixture intentionally has paragraph breaks and more than one chapter.
// It is the smallest artifact that still exercises text references, chapter
// ordering, metadata, cover handling, and fallback packaging together.
export const AUDIOBOOK_INTEROP_FIXTURE: AudiobookInteropFixture = {
  id: 'two-chapter-paragraphs',
  title: 'The Lantern and the Long Road',
  language: 'en-US',
  narrator: 'BetterTTS interoperability fixture',
  cover: {
    mimeType: 'image/png',
    bytes: new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2,
      0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0,
      1, 5, 1, 1, 39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68,
      174, 66, 96, 130,
    ]),
  },
  chapters: [
    {
      title: 'The Lantern',
      paragraphs: [
        'At dusk, Mira lit the old lantern. Its small flame made the rain look like silver thread.',
        'She folded the map twice and listened for the road beyond the orchard.',
      ],
    },
    {
      title: 'The Long Road',
      paragraphs: [
        'By morning, the clouds had opened. Mira followed the markers one careful mile at a time.',
        'The road was long, but every quiet step carried her toward home.',
      ],
    },
  ],
}

export const AUDIOBOOK_INTEROP_CONSUMERS = [
  { id: 'readium', label: 'Readium', formats: ['epub'] },
  { id: 'thorium', label: 'Thorium', formats: ['epub'] },
  { id: 'calibre', label: 'Calibre', formats: ['epub', 'm4b', 'zip'] },
  { id: 'audiobookshelf', label: 'Audiobookshelf', formats: ['m4b', 'zip'] },
] as const

export type AudiobookInteropConsumerId = typeof AUDIOBOOK_INTEROP_CONSUMERS[number]['id']
