import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { type QueueJob, commitQueueChunk, deleteJob, deleteJobWithSnapshot, getChunkBlob, getJob, jobProgress, listJobs, migrateQueueJob, nextPendingChunk, replaceQueueChunk, restoreQueueJob, saveChunkBlob, saveJob } from './queue.ts'

function makeJob(id: string, chunks = 3): QueueJob {
  return {
    schemaVersion: 2,
    id,
    title: `Job ${id}`,
    createdAt: Date.now(),
    engine: 'kokoro',
    voice: 'af_heart',
    speed: 1,
    format: 'wav',
    bitrate: 128,
    narratorMode: false,
    chunks: Array.from({ length: chunks }, (_, i) => ({
      index: i,
      text: `Chunk ${i} text.`,
      status: 'pending' as const,
    })),
  }
}

describe('queue', () => {
  beforeEach(async () => {
    const jobs = await listJobs()
    for (const j of jobs) await deleteJob(j.id)
  })

  it('saves and retrieves a job', async () => {
    const job = makeJob('q1')
    await saveJob(job)
    const retrieved = await getJob('q1')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.title).toBe('Job q1')
    expect(retrieved!.schemaVersion).toBe(2)
    expect(retrieved!.engine).toBe('kokoro')
    expect(retrieved!.chunks.length).toBe(3)
  })

  it('lists jobs newest-first', async () => {
    await saveJob({ ...makeJob('old'), createdAt: 100 })
    await saveJob({ ...makeJob('new'), createdAt: 300 })
    const jobs = await listJobs()
    expect(jobs[0].id).toBe('new')
    expect(jobs[1].id).toBe('old')
  })

  it('updates an existing job in place', async () => {
    const job = makeJob('q2')
    await saveJob(job)
    job.chunks[0].status = 'done'
    await saveJob(job)
    const updated = await getJob('q2')
    expect(updated!.chunks[0].status).toBe('done')
  })

  it('stores and retrieves chunk blobs', async () => {
    await saveJob(makeJob('q3'))
    const blob = new Blob(['audio data'], { type: 'audio/wav' })
    await saveChunkBlob('q3', 0, blob)
    const retrieved = await getChunkBlob('q3', 0)
    expect(retrieved).not.toBeNull()
    expect(await retrieved!.text()).toBe('audio data')
  })

  it('commits completed chunk metadata and audio in one transaction', async () => {
    const job = makeJob('atomic')
    await saveJob(job)
    job.chunks[0].status = 'done'
    job.chunks[0].duration = '1.0s'
    await commitQueueChunk(job, 0, new Blob(['complete audio']))

    expect((await getJob(job.id))?.chunks[0]).toMatchObject({ status: 'done', duration: '1.0s' })
    expect(await (await getChunkBlob(job.id, 0))?.text()).toBe('complete audio')
  })

  it('refuses to commit audio without completed metadata', async () => {
    const job = makeJob('incomplete')
    await saveJob(job)

    await expect(commitQueueChunk(job, 0, new Blob(['partial audio']))).rejects.toThrow('completed chunk')
    expect(await getChunkBlob(job.id, 0)).toBeNull()
    expect((await getJob(job.id))?.chunks[0].status).toBe('pending')
  })

  it('deleteJob removes job and its chunk blobs', async () => {
    await saveJob(makeJob('q4'))
    await saveChunkBlob('q4', 0, new Blob(['chunk0']))
    await saveChunkBlob('q4', 1, new Blob(['chunk1']))
    await deleteJob('q4')
    expect(await getJob('q4')).toBeNull()
    expect(await getChunkBlob('q4', 0)).toBeNull()
    expect(await getChunkBlob('q4', 1)).toBeNull()
  })

  it('restores a deleted queue job and all saved chunk audio', async () => {
    await saveJob(makeJob('undo-job', 2))
    await saveChunkBlob('undo-job', 0, new Blob(['chunk zero']))
    await saveChunkBlob('undo-job', 1, new Blob(['chunk one']))
    const snapshot = await deleteJobWithSnapshot('undo-job')
    expect(snapshot?.blobs.map((entry) => entry.chunkIndex)).toEqual([0, 1])
    expect(await getJob('undo-job')).toBeNull()
    await restoreQueueJob(snapshot!)
    expect((await getJob('undo-job'))?.title).toBe('Job undo-job')
    expect(await (await getChunkBlob('undo-job', 0))!.text()).toBe('chunk zero')
    expect(await (await getChunkBlob('undo-job', 1))!.text()).toBe('chunk one')
  })

  it('aborts restored job metadata when a chunk blob cannot be cloned', async () => {
    const job = makeJob('atomic-restore', 1)
    await expect(restoreQueueJob({
      job,
      blobs: [{
        chunkIndex: 0,
        blob: (() => 'not cloneable') as unknown as Blob,
      }],
    })).rejects.toThrow()

    expect(await getJob(job.id)).toBeNull()
    expect(await getChunkBlob(job.id, 0)).toBeNull()
  })

  it('jobProgress computes percentages', () => {
    const job = makeJob('q5')
    job.chunks[0].status = 'done'
    job.chunks[1].status = 'done'
    const { done, total, pct } = jobProgress(job)
    expect(done).toBe(2)
    expect(total).toBe(3)
    expect(pct).toBe(67)
  })

  it('nextPendingChunk finds the first pending', () => {
    const job = makeJob('q6')
    job.chunks[0].status = 'done'
    const next = nextPendingChunk(job)
    expect(next).not.toBeNull()
    expect(next!.index).toBe(1)
  })

  it('nextPendingChunk returns null when all done', () => {
    const job = makeJob('q7')
    for (const c of job.chunks) c.status = 'done'
    expect(nextPendingChunk(job)).toBeNull()
  })

  it('migrates v1 Kokoro-only jobs without losing chunks', () => {
    const legacy = {
      id: 'legacy',
      title: 'Legacy job',
      createdAt: 100,
      voice: 'af_bella',
      language: 'en-US',
      speed: 1.1,
      format: 'mp3',
      bitrate: 160,
      chunks: [{ index: 0, text: 'Old chunk.', status: 'generating' }],
    }
    const migrated = migrateQueueJob(legacy)
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.engine).toBe('kokoro')
    expect(migrated.voice).toBe('af_bella')
    expect(migrated.language).toBe('en-US')
    // A persisted 'generating' chunk is a zombie from a crashed session and
    // must come back resumable, not stuck on a perpetual "running" pill.
    expect(migrated.chunks[0].status).toBe('pending')
  })

  it('migrates native Melo jobs as single-speaker queue records', () => {
    const migrated = migrateQueueJob({
      ...makeJob('melo', 1),
      engine: 'melo',
      voice: 'melo-default',
      language: 'cmn',
    })

    expect(migrated.engine).toBe('melo')
    expect(migrated.voice).toBe('melo-default')
    expect(migrated.language).toBeUndefined()
    expect(migrated.speed).toBe(1)
  })

  it('preserves the optional reader source identity across migration', () => {
    const migrated = migrateQueueJob({ ...makeJob('reader-job', 1), sourceDocumentId: 'reader-deadbeef' })
    expect(migrated.sourceDocumentId).toBe('reader-deadbeef')
    expect(migrateQueueJob({ ...makeJob('reader-invalid', 1), sourceDocumentId: { unsafe: true } }).sourceDocumentId).toBeUndefined()
  })

  it('migrates queue chunk playback metadata', () => {
    const migrated = migrateQueueJob({
      ...makeJob('playback', 1),
      chunks: [{
        index: 0,
        text: 'Chunk text.',
        status: 'done',
        duration: '1.2s',
        cues: [
          { index: 1, startSec: 0, endSec: 1.2, text: 'Chunk text.' },
          { index: 2, startSec: 1.2, endSec: 1.2, text: 'Invalid zero duration.' },
        ],
      }],
    })

    expect(migrated.chunks[0].duration).toBe('1.2s')
    expect(migrated.chunks[0].cues).toEqual([{ index: 1, startSec: 0, endSec: 1.2, text: 'Chunk text.' }])
  })

  it('persists narrator role and per-chunk voice assignments', () => {
    const migrated = migrateQueueJob({
      ...makeJob('narrator', 2),
      narratorMode: true,
      voice: 'af_heart',
      chunks: [
        { index: 0, text: 'Narration.', status: 'pending', role: 'narration', voice: 'af_heart' },
        { index: 1, text: 'Dialogue.', status: 'pending', role: 'dialogue', speaker: 'Eve', voice: 'af_bella' },
      ],
    })

    expect(migrated.narratorMode).toBe(true)
    expect(migrated.chunks).toMatchObject([
      { role: 'narration', voice: 'af_heart' },
      { role: 'dialogue', speaker: 'Eve', voice: 'af_bella' },
    ])
  })

  it('drops malformed narrator metadata during migration', () => {
    const migrated = migrateQueueJob({
      ...makeJob('bad-narrator', 1),
      narratorMode: 'yes',
      chunks: [{ index: 0, text: 'Text.', status: 'pending', role: 'other', voice: { id: 'unsafe' }, speaker: 42 }],
    })

    expect(migrated.narratorMode).toBe(false)
    expect(migrated.chunks[0].voice).toBeUndefined()
    expect(migrated.chunks[0].role).toBeUndefined()
    expect(migrated.chunks[0].speaker).toBeUndefined()
  })

  it('sanitizes malformed persisted synthesis settings and chunk indexes', () => {
    const migrated = migrateQueueJob({
      ...makeJob('malformed', 1),
      createdAt: Number.POSITIVE_INFINITY,
      engine: 'kitten',
      speed: Number.NaN,
      format: 'exe',
      bitrate: 9999,
      kittenModel: 'unknown',
      chunks: [{
        index: -4,
        text: 'Recovered.',
        status: 'generating',
        cues: [
          { index: 0, startSec: 0, endSec: 1, text: 'Invalid index.' },
          { index: 1, startSec: -1, endSec: 1, text: 'Invalid start.' },
          { index: 2, startSec: 0, endSec: 1, text: 'Valid.' },
        ],
      }],
    })

    expect(migrated.createdAt).toBeGreaterThan(0)
    expect(migrated).toMatchObject({
      engine: 'kitten',
      speed: 1,
      format: 'wav',
      bitrate: 320,
      kittenModel: 'nano',
    })
    expect(migrated.chunks[0]).toMatchObject({ index: 0, status: 'pending' })
    expect(migrated.chunks[0].cues).toEqual([{ index: 2, startSec: 0, endSec: 1, text: 'Valid.' }])
  })

  it('removes non-string persisted metadata before rendering or synthesis', () => {
    const migrated = migrateQueueJob({
      ...makeJob('typed', 1),
      title: { unsafe: true },
      voice: ['af_heart'],
      language: { locale: 'en-us' },
      chunks: [{
        index: 0,
        text: { nested: true },
        status: 'failed',
        chapterTitle: 7,
        chapterIndex: -1,
        error: { message: 'bad' },
      }],
    })

    expect(migrated).toMatchObject({ title: 'Untitled job', voice: 'af_heart' })
    expect(migrated.language).toBeUndefined()
    expect(migrated.chunks[0]).toMatchObject({ text: '', status: 'failed' })
    expect(migrated.chunks[0].chapterTitle).toBeUndefined()
    expect(migrated.chunks[0].error).toBeUndefined()
    expect(migrateQueueJob(null)).toMatchObject({ title: 'Untitled job', chunks: [] })
  })

  it('clamps engine-specific persisted speed and Supertonic quality bounds', () => {
    expect(migrateQueueJob({ ...makeJob('slow', 0), engine: 'supertonic', speed: 0.1, supertonicSteps: 99 }))
      .toMatchObject({ speed: 0.8, supertonicSteps: 10 })
    expect(migrateQueueJob({ ...makeJob('fast', 0), engine: 'kitten', speed: 9 }))
      .toMatchObject({ speed: 2 })
  })

  it('preserves Piper engine and language across restart migration', () => {
    const migrated = migrateQueueJob({
      ...makeJob('piper', 1),
      engine: 'piper',
      voice: 'ja',
      language: 'ja',
    })
    expect(migrated.engine).toBe('piper')
    expect(migrated.voice).toBe('ja')
    expect(migrated.language).toBe('ja')
  })

  it('replaces one queue chunk without mutating the original job', () => {
    const job = makeJob('replace', 2)
    job.chunks[0] = { ...job.chunks[0], status: 'failed', error: 'old failure', chapterTitle: 'Old title' }
    const next = replaceQueueChunk(job, 0, {
      text: 'Replacement text.',
      status: 'done',
      chapterTitle: 'New title',
      duration: '2.0s',
      cues: [{ index: 1, startSec: 0, endSec: 2, text: 'Replacement text.' }],
    })

    expect(next).not.toBe(job)
    expect(next.chunks[0]).toMatchObject({ text: 'Replacement text.', status: 'done', chapterTitle: 'New title', duration: '2.0s' })
    expect(next.chunks[0].error).toBeUndefined()
    expect(next.chunks[1]).toEqual(job.chunks[1])
    expect(job.chunks[0].text).toBe('Chunk 0 text.')
    expect(job.chunks[0].error).toBe('old failure')
  })

  it('keeps narrator voice metadata when editing chunk text or titles', () => {
    const job = makeJob('narrator-edit', 1)
    job.chunks[0] = { ...job.chunks[0], role: 'dialogue', speaker: 'Eve', voice: 'af_bella' }
    const next = replaceQueueChunk(job, 0, { text: 'New line.', status: 'pending', chapterTitle: 'Dialogue' })
    expect(next.chunks[0]).toMatchObject({ role: 'dialogue', speaker: 'Eve', voice: 'af_bella' })
  })

  it('persists engine-specific queue settings', async () => {
    const job: QueueJob = {
      ...makeJob('supertonic'),
      engine: 'supertonic',
      voice: 'F2',
      language: undefined,
      supertonicSteps: 7,
    }
    await saveJob(job)
    const retrieved = await getJob('supertonic')
    expect(retrieved!.engine).toBe('supertonic')
    expect(retrieved!.voice).toBe('F2')
    expect(retrieved!.supertonicSteps).toBe(7)
    expect(retrieved!.language).toBeUndefined()
  })
})
