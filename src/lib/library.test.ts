import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { type ClipRecord, clearLibrary, clearLibraryWithSnapshot, deleteClip, deleteClipWithSnapshot, enforceLibraryCap, freeLibrarySpace, getClipBlob, listClips, restoreClipSnapshots, saveClip } from './library.ts'

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

  it('persists sentence cues with clip metadata', async () => {
    await saveClip(
      {
        ...record('cues', 1),
        cues: [{ index: 1, startSec: 0, endSec: 1.2, text: 'Cue one.' }],
      },
      new Blob(['payload'], { type: 'audio/wav' }),
    )
    const clips = await listClips()
    expect(clips[0].cues).toEqual([{ index: 1, startSec: 0, endSec: 1.2, text: 'Cue one.' }])
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

  it('restores a deleted clip from its audio snapshot', async () => {
    await saveClip(record('undo-one', 1), new Blob(['recover me']))
    const snapshot = await deleteClipWithSnapshot('undo-one')
    expect(snapshot?.record.id).toBe('undo-one')
    expect(await listClips()).toEqual([])
    await restoreClipSnapshots(snapshot ? [snapshot] : [])
    expect((await listClips()).map((clip) => clip.id)).toEqual(['undo-one'])
    expect(await (await getClipBlob('undo-one'))!.text()).toBe('recover me')
  })

  it('restores every clip after a clear-library snapshot', async () => {
    await saveClip(record('undo-a', 1), new Blob(['audio a']))
    await saveClip(record('undo-b', 2), new Blob(['audio b']))
    const snapshots = await clearLibraryWithSnapshot()
    expect(snapshots).toHaveLength(2)
    expect(await listClips()).toEqual([])
    await restoreClipSnapshots(snapshots)
    expect((await listClips()).map((clip) => clip.id)).toEqual(['undo-b', 'undo-a'])
    expect(await (await getClipBlob('undo-b'))!.text()).toBe('audio b')
  })

  it('removes a clip whose audio blob is already missing', async () => {
    await saveClip(record('missing-audio', 1), new Blob(['temporary']))
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bettertts-library')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction('blobs', 'readwrite')
    tx.objectStore('blobs').delete('missing-audio')
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()

    const snapshot = await deleteClipWithSnapshot('missing-audio')
    expect(snapshot?.blob).toBeNull()
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

  it('freeLibrarySpace evicts oldest-first until the target is reached', async () => {
    await saveClip({ ...record('old', 1), size: 50 }, new Blob(['old']))
    await saveClip({ ...record('mid', 2), size: 50 }, new Blob(['mid']))
    await saveClip({ ...record('new', 3), size: 50 }, new Blob(['new']))

    const { evicted, freedBytes } = await freeLibrarySpace(80)
    expect(evicted).toBe(2)
    expect(freedBytes).toBe(100)
    expect((await listClips()).map((c) => c.id)).toEqual(['new'])
    expect(await getClipBlob('old')).toBeNull()
  })

  it('freeLibrarySpace reports zero when the library is already empty', async () => {
    expect(await freeLibrarySpace(1000)).toEqual({ evicted: 0, freedBytes: 0 })
  })
})
