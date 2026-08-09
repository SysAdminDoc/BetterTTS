import { zipSync, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { AUDIOBOOK_INTEROP_FIXTURE } from './audiobook-interoperability.fixtures.ts'
import {
  migrateChapteredZipManifest,
  validateAudiobookExport,
  validateChapteredZip,
} from './audiobook-interoperability.ts'
import { buildEpubMediaOverlay } from './media-overlays.ts'
import { aacAudioSpecificConfig, buildM4bContainer } from './m4b.ts'

const encoder = new TextEncoder()

function expected() {
  return {
    title: AUDIOBOOK_INTEROP_FIXTURE.title,
    language: AUDIOBOOK_INTEROP_FIXTURE.language,
    narrator: AUDIOBOOK_INTEROP_FIXTURE.narrator,
    chapterTitles: AUDIOBOOK_INTEROP_FIXTURE.chapters.map((chapter) => chapter.title),
    requireCover: true,
  }
}

function audioBlob(seconds = 0.2): Blob {
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

function chapterText(index: number): string {
  return AUDIOBOOK_INTEROP_FIXTURE.chapters[index].paragraphs.join('\n\n')
}

function fixtureCues(text: string) {
  return [{ index: 1, startSec: 0, endSec: 2, text }]
}

describe('audiobook interoperability conformance', () => {
  it('validates a golden two-chapter EPUB Media Overlay for reader-system profiles', async () => {
    const result = await buildEpubMediaOverlay({
      title: AUDIOBOOK_INTEROP_FIXTURE.title,
      jobId: AUDIOBOOK_INTEROP_FIXTURE.id,
      language: AUDIOBOOK_INTEROP_FIXTURE.language,
      narrator: AUDIOBOOK_INTEROP_FIXTURE.narrator,
      cover: AUDIOBOOK_INTEROP_FIXTURE.cover,
      chunks: AUDIOBOOK_INTEROP_FIXTURE.chapters.map((chapter, index) => ({
        index,
        title: chapter.title,
        text: chapterText(index),
        format: 'wav' as const,
        blob: audioBlob(),
        cues: fixtureCues(chapterText(index)),
      })),
    })

    const report = validateAudiobookExport('epub', new Uint8Array(await result.blob.arrayBuffer()), expected())
    expect(report.valid).toBe(true)
    expect(report.chapterTitles).toEqual(expected().chapterTitles)
    expect(report.playerSmoke).toMatchObject({ ok: true, steps: 6 })
    expect(report.consumers.readium).toMatchObject({ supported: true, valid: true })
    expect(report.consumers.thorium).toMatchObject({ supported: true, valid: true })
    expect(report.consumers.calibre).toMatchObject({ supported: true, valid: true })
    expect(report.consumers.audiobookshelf).toMatchObject({ supported: false, valid: true })
  })

  it('catches broken SMIL text references before an EPUB leaves the app', async () => {
    const result = await buildEpubMediaOverlay({
      title: AUDIOBOOK_INTEROP_FIXTURE.title,
      jobId: 'broken-smil',
      language: AUDIOBOOK_INTEROP_FIXTURE.language,
      cover: AUDIOBOOK_INTEROP_FIXTURE.cover,
      chunks: [{
        index: 0,
        title: AUDIOBOOK_INTEROP_FIXTURE.chapters[0].title,
        text: chapterText(0),
        format: 'mp3',
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }),
        cues: fixtureCues(chapterText(0)),
      }],
    })
    const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    const smilPath = 'OEBPS/media/0001.smil'
    entries[smilPath] = encoder.encode(new TextDecoder().decode(entries[smilPath]).replace('../text/0001.xhtml#', '../text/missing.xhtml#'))
    const broken = zipSync(entries, { level: 0 })
    const report = validateAudiobookExport('epub', broken, { ...expected(), chapterTitles: [expected().chapterTitles[0]] })
    expect(report.valid).toBe(false)
    expect(report.issues.some((issue) => issue.code === 'overlay-textref-path' || issue.code === 'cue-text-reference')).toBe(true)
  })

  it('validates M4B metadata, attached cover, chapter track order, and chapter linkage', async () => {
    const blob = buildM4bContainer({
      title: AUDIOBOOK_INTEROP_FIXTURE.title,
      language: AUDIOBOOK_INTEROP_FIXTURE.language,
      narrator: AUDIOBOOK_INTEROP_FIXTURE.narrator,
      cover: AUDIOBOOK_INTEROP_FIXTURE.cover,
      sampleRate: 24_000,
      bitrate: 128_000,
      audioSpecificConfig: aacAudioSpecificConfig(24_000, 1),
      frames: [
        { data: new Uint8Array([1, 2, 3]), duration: 1024 },
        { data: new Uint8Array([4, 5, 6]), duration: 1024 },
        { data: new Uint8Array([7, 8, 9]), duration: 1024 },
        { data: new Uint8Array([10, 11, 12]), duration: 1024 },
      ],
      chapters: [
        { title: AUDIOBOOK_INTEROP_FIXTURE.chapters[0].title, startSample: 0 },
        { title: AUDIOBOOK_INTEROP_FIXTURE.chapters[1].title, startSample: 2048 },
      ],
    })
    const report = validateAudiobookExport('m4b', new Uint8Array(await blob.arrayBuffer()), expected())
    expect(report.valid).toBe(true)
  })

  it('validates chaptered ZIP fallback ordering and migrates the legacy manifest shape', () => {
    const entries = {
      '001-lantern.wav': new Uint8Array([1, 2, 3]),
      '002-road.wav': new Uint8Array([4, 5, 6]),
      'cover/cover.png': AUDIOBOOK_INTEROP_FIXTURE.cover.bytes,
      'chapters.json': encoder.encode(JSON.stringify({
        schemaVersion: 2,
        app: 'BetterTTS',
        title: AUDIOBOOK_INTEROP_FIXTURE.title,
        language: AUDIOBOOK_INTEROP_FIXTURE.language,
        format: 'wav',
        cover: { filename: 'cover/cover.png', mimeType: AUDIOBOOK_INTEROP_FIXTURE.cover.mimeType },
        chunks: [
          { index: 0, filename: '001-lantern.wav', text: chapterText(0), chapterTitle: AUDIOBOOK_INTEROP_FIXTURE.chapters[0].title, chapterIndex: 0 },
          { index: 1, filename: '002-road.wav', text: chapterText(1), chapterTitle: AUDIOBOOK_INTEROP_FIXTURE.chapters[1].title, chapterIndex: 1 },
        ],
      })),
    }
    const report = validateChapteredZip(zipSync(entries, { level: 0 }), expected())
    expect(report.valid).toBe(true)
    expect(report.consumers.audiobookshelf).toMatchObject({ supported: true, valid: true })
    expect(report.playerSmoke.steps).toBe(2)

    const migrated = migrateChapteredZipManifest({
      app: 'BetterTTS',
      title: AUDIOBOOK_INTEROP_FIXTURE.title,
      chunks: [{ index: 0, filename: '001-lantern.wav' }],
    })
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.chunks[0].filename).toBe('001-lantern.wav')
  })
})
