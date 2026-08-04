import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildEpubMediaOverlay } from './media-overlays.ts'

function readEntry(entries: Record<string, Uint8Array>, name: string): string {
  const value = entries[name]
  if (!value) throw new Error(`Missing ${name}`)
  return new TextDecoder().decode(value)
}

function audioBlob(seconds = 0.1): Blob {
  const sampleRate = 8_000
  const sampleCount = Math.max(1, Math.floor(sampleRate * seconds))
  const buffer = new ArrayBuffer(44 + sampleCount * 2)
  const view = new DataView(buffer)
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, sampleCount * 2, true)
  return new Blob([buffer], { type: 'audio/wav' })
}

describe('EPUB3 media overlays', () => {
  it('writes an EPUB3 package with text, audio, SMIL, nav, and active highlight metadata', async () => {
    const result = await buildEpubMediaOverlay({
      title: 'Overlay & Book',
      jobId: 'job-123',
      chunks: [{
        index: 0,
        title: 'Chapter 1',
        text: 'First sentence. Second sentence.',
        format: 'wav',
        blob: audioBlob(),
        cues: [{ index: 1, startSec: 0, endSec: 2, text: 'First sentence. Second sentence.' }],
      }],
    })

    const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    expect(result.chunkCount).toBe(1)
    expect(Object.keys(entries)[0]).toBe('mimetype')
    expect(readEntry(entries, 'mimetype')).toBe('application/epub+zip')
    const opf = readEntry(entries, 'OEBPS/package.opf')
    const smil = readEntry(entries, 'OEBPS/media/0001.smil')
    const xhtml = readEntry(entries, 'OEBPS/text/0001.xhtml')
    expect(opf).toContain('version="3.0"')
    expect(opf).toContain('media-overlay="smil-0"')
    expect(opf).toContain('media:duration')
    expect(opf).toContain('media:active-class')
    expect(opf).toContain('media:duration" refines="#smil-0"')
    expect(opf).toContain('audio/mpeg')
    expect(opf).toContain('Overlay &amp; Book')
    expect(smil).toContain('../audio/0001.mp3')
    expect(smil).toContain('clipBegin="0.000s"')
    expect(smil).toContain('#reader-c0-p0-s0')
    expect(smil).toContain('#reader-c0-p0-s1')
    expect(xhtml).toContain('class="sentence"')
    expect(xhtml).toContain('href="../styles.css"')
    expect(readEntry(entries, 'OEBPS/nav.xhtml')).toContain('Chapter 1')
  })

  it('references word spans when persisted cues are word-level', async () => {
    const result = await buildEpubMediaOverlay({
      title: 'Word timing',
      jobId: 'word-job',
      chunks: [{
        index: 2,
        title: 'Words',
        text: 'Hello world.',
        format: 'mp3',
        blob: new Blob([new Uint8Array(12)], { type: 'audio/mpeg' }),
        cues: [
          { index: 1, startSec: 0, endSec: 0.5, text: 'Hello' },
          { index: 2, startSec: 0.5, endSec: 1, text: 'world' },
        ],
      }],
    })
    const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    const smil = readEntry(entries, 'OEBPS/media/0001.smil')
    const xhtml = readEntry(entries, 'OEBPS/text/0001.xhtml')
    expect(smil).toContain('#reader-c0-p0-s0-w0')
    expect(smil).toContain('#reader-c0-p0-s0-w1')
    expect(xhtml).toContain('class="word"')
    expect(entries['OEBPS/audio/0001.mp3']).toHaveLength(12)
  })

  it('falls back to sentence timing when a legacy queue chunk has no cues', async () => {
    const result = await buildEpubMediaOverlay({
      title: 'Legacy timing',
      jobId: 'legacy-timing',
      chunks: [{ index: 0, text: 'First. Second.', format: 'mp3', blob: new Blob([new Uint8Array(12)], { type: 'audio/mpeg' }), duration: '2s' }],
    })
    const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    const smil = readEntry(entries, 'OEBPS/media/0001.smil')
    expect(smil).toContain('#reader-c0-p0-s0')
    expect(smil).toContain('#reader-c0-p0-s1')
  })

  it('rejects empty, duplicate, or oversized overlay inputs before packaging', async () => {
    await expect(buildEpubMediaOverlay({ title: 'Empty', jobId: 'empty', chunks: [] })).rejects.toThrow('No completed EPUB chunks')
    await expect(buildEpubMediaOverlay({
      title: 'Duplicate',
      jobId: 'duplicate',
      chunks: [
        { index: 0, text: 'One.', format: 'wav', blob: audioBlob() },
        { index: 0, text: 'Two.', format: 'wav', blob: audioBlob() },
      ],
    })).rejects.toThrow('unique increasing indexes')
    await expect(buildEpubMediaOverlay({
      title: 'Empty audio',
      jobId: 'empty-audio',
      chunks: [{ index: 0, text: 'One.', format: 'wav', blob: new Blob([], { type: 'audio/wav' }) }],
    })).rejects.toThrow('has no audio')
  })
})
