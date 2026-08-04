import { afterEach, describe, expect, it } from 'vitest'
import {
  assertExportResourcePlan,
  audioCleanupFilter,
  buildChapterMetadata,
  buildExportResourcePlan,
  outputArguments,
} from '../electron/ffmpeg.mjs'

afterEach(() => {
  delete process.env.BETTERTTS_MAX_EXPORT_DURATION_SECONDS
  delete process.env.BETTERTTS_MAX_EXPORT_TEMP_BYTES
})

describe('FFmpeg export arguments', () => {
  it('builds dependency-free cleanup filters and rejects unknown modes', () => {
    expect(audioCleanupFilter()).toBeNull()
    expect(audioCleanupFilter('denoise')).toBe('afftdn=nr=12:nf=-50:tn=1')
    expect(audioCleanupFilter('studio')).toContain('agate=threshold=0.02')
    expect(() => audioCleanupFilter('neural')).toThrow('Unsupported audio cleanup mode')
  })

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

  it('preflights decoded duration, temporary bytes, and free space', () => {
    const plan = buildExportResourcePlan({
      label: 'M4B test',
      durationSeconds: 3600,
      decodedBytes: 3600 * 48_000 * 4,
      inputBytes: 20 * 1024 * 1024,
      outputBytes: 80 * 1024 * 1024,
    })
    expect(plan.tempBytes).toBeGreaterThan(plan.decodedBytes)
    expect(assertExportResourcePlan(plan, plan.tempBytes)).toBe(plan)
    expect(() => assertExportResourcePlan(plan, plan.tempBytes - 1)).toThrow(/only .* is available.*Destination unchanged/)
  })

  it('honors configured duration and temporary-space ceilings', () => {
    process.env.BETTERTTS_MAX_EXPORT_DURATION_SECONDS = '60'
    process.env.BETTERTTS_MAX_EXPORT_TEMP_BYTES = String(100 * 1024 * 1024)
    const tooLong = buildExportResourcePlan({
      label: 'WAV test',
      durationSeconds: 61,
      decodedBytes: 1024,
      inputBytes: 1024,
      outputBytes: 1024,
    })
    expect(() => assertExportResourcePlan(tooLong)).toThrow(/configured limit is 1 minutes/)

    const tooLarge = buildExportResourcePlan({
      label: 'WAV test',
      durationSeconds: 1,
      decodedBytes: 80 * 1024 * 1024,
      inputBytes: 20 * 1024 * 1024,
      outputBytes: 20 * 1024 * 1024,
    })
    expect(() => assertExportResourcePlan(tooLarge)).toThrow(/temporary space.*configured limit/)
  })
})
