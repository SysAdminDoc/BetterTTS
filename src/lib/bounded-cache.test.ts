import { describe, expect, it, vi } from 'vitest'
import { readLruEntry, writeLruEntry } from './bounded-cache.ts'

describe('bounded LRU cache', () => {
  it('refreshes reads and disposes the least-recently-used value', () => {
    const cache = new Map<string, string>()
    const dispose = vi.fn()
    writeLruEntry(cache, 'a', 'url-a', 2, dispose)
    writeLruEntry(cache, 'b', 'url-b', 2, dispose)
    expect(readLruEntry(cache, 'a')).toBe('url-a')
    writeLruEntry(cache, 'c', 'url-c', 2, dispose)

    expect([...cache.keys()]).toEqual(['a', 'c'])
    expect(dispose).toHaveBeenCalledWith('url-b')
  })

  it('disposes replaced resources without growing the cache', () => {
    const cache = new Map([['voice', 'old']])
    const dispose = vi.fn()
    writeLruEntry(cache, 'voice', 'new', 3, dispose)

    expect(cache.get('voice')).toBe('new')
    expect(cache).toHaveLength(1)
    expect(dispose).toHaveBeenCalledWith('old')
  })
})
