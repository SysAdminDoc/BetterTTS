import { describe, expect, it } from 'vitest'
import { buildChapterMetadata, outputArguments } from '../electron/ffmpeg.mjs'

describe('FFmpeg export arguments', () => {
  it('uses bounded bitrate and sanitized metadata without a shell', () => {
    expect(outputArguments('mp3', 999, 'Book\r\nTitle')).toEqual([
      '-c:a', 'libmp3lame', '-b:a', '320k', '-metadata', 'title=Book  Title',
    ])
  })

  it('uses lossless codecs without irrelevant bitrate flags', () => {
    expect(outputArguments('flac')).toEqual(['-c:a', 'flac'])
    expect(() => outputArguments('exe')).toThrow('Unsupported native audio format')
  })

  it('writes bounded chapter metadata with escaped titles', () => {
    const metadata = buildChapterMetadata('Book', [{ title: 'One' }, { title: 'Two=End' }], [1.25, 2])
    expect(metadata).toContain('START=0\nEND=1250\ntitle=One')
    expect(metadata).toContain('START=1250\nEND=3250\ntitle=Two\\=End')
  })
})
