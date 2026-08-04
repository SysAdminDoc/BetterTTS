import { describe, expect, it } from 'vitest'
import { buildCliChunks, buildCliCues, CliUsageError, parseCliArgs } from './cli-core.ts'

describe('headless CLI argument core', () => {
  it('parses a chaptered M4B plan with default captions', () => {
    const parsed = parseCliArgs(['synth', '--in', 'book.epub', '--out', 'out.m4b', '--voice', 'bf_emma', '--speed', '1.2', '--bitrate', '192', '--json'])
    expect(parsed.kind).toBe('synth')
    if (parsed.kind !== 'synth') return
    expect(parsed.options).toMatchObject({
      inputPath: expect.stringMatching(/[\\/]book\.epub$/),
      outputPath: expect.stringMatching(/[\\/]out\.m4b$/),
      format: 'm4b',
      voice: 'bf_emma',
      speed: 1.2,
      bitrate: 192,
      json: true,
    })
    expect(parsed.options.srtPath).toMatch(/out\.srt$/)
    expect(parsed.options.vttPath).toMatch(/out\.vtt$/)
  })

  it('supports stdin, explicit caption suppression, and format aliases', () => {
    const parsed = parseCliArgs(['synth', '--in', '-', '--out', 'speech', '--m4b', '--no-captions', '--progress=json'])
    expect(parsed.kind).toBe('synth')
    if (parsed.kind !== 'synth') return
    expect(parsed.options).toMatchObject({ inputPath: '-', format: 'm4b', json: true, srtPath: null, vttPath: null })
  })

  it('rejects unsafe or incomplete command lines with exit code 2', () => {
    expect(() => parseCliArgs(['synth'])).toThrow(CliUsageError)
    try {
      parseCliArgs(['synth', '--in', '-', '--out', 'book.wav', '--speed', '3'])
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError)
      expect((error as CliUsageError).exitCode).toBe(2)
    }
  })
})

describe('headless CLI chunking and captions', () => {
  it('keeps chapter labels while using the same bounded sentence splitter as the app', () => {
    const chunks = buildCliChunks([
      { title: 'One', text: 'First sentence. Second sentence.' },
      { title: 'Two', text: 'A short second chapter.' },
    ])
    expect(chunks).toEqual([
      { title: 'One', chapterIndex: 0, text: 'First sentence. Second sentence.' },
      { title: 'Two', chapterIndex: 1, text: 'A short second chapter.' },
    ])
  })

  it('allocates monotonic sentence cues across chunk durations', () => {
    const cues = buildCliCues([
      { title: 'One', chapterIndex: 0, text: 'First sentence. Second sentence.', duration: 4 },
      { title: 'Two', chapterIndex: 1, text: 'Final line.', duration: 2 },
    ])
    expect(cues.map((cue) => cue.text)).toEqual(['First sentence.', 'Second sentence.', 'Final line.'])
    expect(cues[0].startSec).toBe(0)
    expect(cues.at(-1)?.endSec).toBe(6)
    expect(cues.every((cue, index) => index === 0 || cue.startSec >= cues[index - 1].endSec)).toBe(true)
  })
})
