import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { type ClipRecord, clearLibrary, deleteClip, enforceLibraryCap, getClipBlob, listClips, saveClip } from './library.ts'

function record(id: string, createdAt: number): ClipRecord {
  return {
    id,
    filename: `${id}.wav`,
    label: `Clip ${id}`,
    voice: 'af_heart',
    speed: 1,
    createdAt,
    size: 4,
    duration: '1.0s',
  }
}

describe('library', () => {
  beforeEach(async () => {
    await clearLibrary()
  })

  it('saves and lists clips newest-first', async () => {
    await saveClip(record('a', 100), new Blob(['aaaa']))
    await saveClip(record('b', 300), new Blob(['bbbb']))
    await saveClip(record('c', 200), new Blob(['cccc']))
    const clips = await listClips()
    expect(clips.map((c) => c.id)).toEqual(['b', 'c', 'a'])
  })

  it('round-trips the audio blob', async () => {
    await saveClip(record('x', 1), new Blob(['payload'], { type: 'audio/wav' }))
    const blob = await getClipBlob('x')
    expect(blob).not.toBeNull()
    expect(await blob!.text()).toBe('payload')
  })

  it('returns null for a missing blob', async () => {
    expect(await getClipBlob('nope')).toBeNull()
  })

  it('deleteClip removes both the record and the blob', async () => {
    await saveClip(record('gone', 1), new Blob(['gone']))
    await deleteClip('gone')
    expect(await listClips()).toEqual([])
    expect(await getClipBlob('gone')).toBeNull()
  })

  it('overwrites an existing id instead of duplicating', async () => {
    await saveClip(record('dup', 1), new Blob(['one']))
    await saveClip({ ...record('dup', 2), label: 'updated' }, new Blob(['two']))
    const clips = await listClips()
    expect(clips.length).toBe(1)
    expect(clips[0].label).toBe('updated')
    expect(await (await getClipBlob('dup'))!.text()).toBe('two')
  })

  it('clearLibrary empties everything', async () => {
    await saveClip(record('a', 1), new Blob(['a']))
    await saveClip(record('b', 2), new Blob(['b']))
    await clearLibrary()
    expect(await listClips()).toEqual([])
  })

  it('enforceLibraryCap evicts oldest clips past the byte budget', async () => {
    await saveClip({ ...record('old', 1), size: 60 }, new Blob(['old']))
    await saveClip({ ...record('mid', 2), size: 60 }, new Blob(['mid']))
    await saveClip({ ...record('new', 3), size: 60 }, new Blob(['new']))
    const evicted = await enforceLibraryCap(150)
    expect(evicted).toBe(1)
    const clips = await listClips()
    expect(clips.map((c) => c.id)).toEqual(['new', 'mid'])
    expect(await getClipBlob('old')).toBeNull()
  })

  it('enforceLibraryCap is a no-op under the budget', async () => {
    await saveClip({ ...record('a', 1), size: 10 }, new Blob(['a']))
    expect(await enforceLibraryCap(1000)).toBe(0)
    expect((await listClips()).length).toBe(1)
  })
})
