import { describe, expect, it } from 'vitest'
import { MAX_BGM_FILE_BYTES, validateBackgroundMusicFile } from './audio-file.ts'

describe('validateBackgroundMusicFile', () => {
  it('accepts audio files within the size cap', () => {
    expect(validateBackgroundMusicFile({ name: 'bed.mp3', size: MAX_BGM_FILE_BYTES, type: 'audio/mpeg' })).toBeNull()
  })

  it('rejects non-audio files when the browser provides a MIME type', () => {
    expect(validateBackgroundMusicFile({ name: 'cover.png', size: 100, type: 'image/png' })).toBe('Background music must be an audio file.')
  })

  it('rejects oversized audio files before decode', () => {
    expect(validateBackgroundMusicFile({ name: 'long.wav', size: MAX_BGM_FILE_BYTES + 1, type: 'audio/wav' })).toContain('or smaller')
  })

  it('rejects empty and invalid-size files before decode', () => {
    expect(validateBackgroundMusicFile({ name: 'empty.wav', size: 0, type: 'audio/wav' })).toContain('empty')
    expect(validateBackgroundMusicFile({ name: 'invalid.wav', size: Number.NaN, type: 'audio/wav' })).toContain('invalid size')
  })
})
