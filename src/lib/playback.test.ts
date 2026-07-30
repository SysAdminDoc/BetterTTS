import { describe, expect, it } from 'vitest'
import type { Cue } from './subtitles.ts'
import {
  clampResumeTime,
  clearPlaybackState,
  cueIndexAtTime,
  formatPlaybackTime,
  loadPlaybackState,
  nextCueIndex,
  previousCueIndex,
  savePlaybackState,
  shouldPersistPlayback,
  type PlaybackStorage,
} from './playback.ts'

class MemoryStorage implements PlaybackStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const cues: Cue[] = [
  { index: 1, startSec: 0, endSec: 2, text: 'One.' },
  { index: 2, startSec: 2, endSec: 4.5, text: 'Two.' },
  { index: 3, startSec: 4.5, endSec: 8, text: 'Three.' },
]

describe('playback resume state', () => {
  it('throttles routine progress writes but always permits terminal writes', () => {
    expect(shouldPersistPlayback(Number.NaN, 0.2)).toBe(true)
    expect(shouldPersistPlayback(10, 10.5)).toBe(false)
    expect(shouldPersistPlayback(10, 11)).toBe(true)
    expect(shouldPersistPlayback(10, 10.1, true)).toBe(true)
  })

  it('round-trips time and cue position', () => {
    const storage = new MemoryStorage()
    savePlaybackState('clip:a', { timeSec: 3.25, cueIndex: 1, updatedAt: 100 }, storage)
    expect(loadPlaybackState('clip:a', storage)).toEqual({ timeSec: 3.25, cueIndex: 1, updatedAt: 100 })
  })

  it('clears one saved playback entry', () => {
    const storage = new MemoryStorage()
    savePlaybackState('clip:a', { timeSec: 3, updatedAt: 100 }, storage)
    savePlaybackState('clip:b', { timeSec: 4, updatedAt: 200 }, storage)
    clearPlaybackState('clip:a', storage)
    expect(loadPlaybackState('clip:a', storage)).toBeNull()
    expect(loadPlaybackState('clip:b', storage)?.timeSec).toBe(4)
  })

  it('drops invalid storage payloads instead of throwing', () => {
    const storage = new MemoryStorage()
    storage.setItem('bettertts-playback-v1', '{not-json')
    expect(loadPlaybackState('clip:a', storage)).toBeNull()
  })

  it('bounds saved entries to the newest playback positions', () => {
    const storage = new MemoryStorage()
    for (let i = 0; i < 90; i += 1) {
      savePlaybackState(`clip:${i}`, { timeSec: i, updatedAt: i }, storage)
    }
    expect(loadPlaybackState('clip:0', storage)).toBeNull()
    expect(loadPlaybackState('clip:10', storage)?.timeSec).toBe(10)
    expect(loadPlaybackState('clip:89', storage)?.timeSec).toBe(89)
  })

  it('finds the active cue at a playback time', () => {
    expect(cueIndexAtTime(cues, 0.5)).toBe(0)
    expect(cueIndexAtTime(cues, 3)).toBe(1)
    expect(cueIndexAtTime(cues, 8.2)).toBe(-1)
  })

  it('navigates previous and next sentence positions', () => {
    expect(previousCueIndex(cues, 3.5)).toBe(1)
    expect(previousCueIndex(cues, 2.2)).toBe(0)
    expect(previousCueIndex(cues, 0.3)).toBe(0)
    expect(nextCueIndex(cues, 0.5)).toBe(1)
    expect(nextCueIndex(cues, 9)).toBe(2)
  })

  it('suppresses resume at the completed end of a clip', () => {
    expect(clampResumeTime(12, 12.2)).toBe(0)
    expect(clampResumeTime(8, 12.2)).toBe(8)
    expect(clampResumeTime(30, Number.NaN)).toBe(30)
  })

  it('formats playback positions compactly', () => {
    expect(formatPlaybackTime(7.9)).toBe('0:07')
    expect(formatPlaybackTime(68)).toBe('1:08')
    expect(formatPlaybackTime(3661)).toBe('1:01:01')
  })
})
