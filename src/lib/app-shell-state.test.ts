import { describe, expect, it } from 'vitest'
import {
  appShellReducer,
  generationReducer,
  INITIAL_APP_SHELL_STATE,
  INITIAL_GENERATION_STATE,
  INITIAL_PROJECT_STATE,
  INITIAL_QUEUE_STATE,
  INITIAL_READER_STATE,
  persistenceReducer,
  projectReducer,
  queueReducer,
  readerReducer,
} from './app-shell-state.ts'
import type { QueueJob } from './queue.ts'

const job: QueueJob = {
  schemaVersion: 2,
  id: 'job-1',
  title: 'Test job',
  createdAt: 1,
  engine: 'kokoro',
  voice: 'af_heart',
  speed: 1,
  format: 'wav',
  bitrate: 160,
  chunks: [],
}

describe('AppShell domain contracts', () => {
  it('keeps generation cancellation terminal and preserves partial output', () => {
    let state = generationReducer(INITIAL_GENERATION_STATE, { type: 'start', runId: 'run-1' })
    state = generationReducer(state, { type: 'progress', value: 45, status: 'Generated 1 / 2' })
    state = generationReducer(state, { type: 'cancel-requested' })
    expect(state.phase).toBe('cancelling')
    state = generationReducer(state, { type: 'cancelled', partialOutput: true })
    state = generationReducer(state, { type: 'set-busy', value: false })
    expect(state.phase).toBe('cancelled')
    expect(state.partialOutput).toBe(true)
    expect(state.status).toContain('partial output')
  })

  it('records complete and failed generation terminal states', () => {
    const started = generationReducer(INITIAL_GENERATION_STATE, { type: 'start', runId: 'run-2' })
    const completed = generationReducer(started, { type: 'set-status', value: 'Local audio ready' })
    expect(generationReducer(completed, { type: 'set-busy', value: false }).phase).toBe('completed')
    const failed = generationReducer(started, { type: 'fail', message: 'model unavailable' })
    expect(generationReducer(failed, { type: 'set-busy', value: false })).toMatchObject({ phase: 'failed', error: 'model unavailable' })
  })

  it('keeps a project dirty when an autosave finishes for an older revision', () => {
    let state = projectReducer(INITIAL_PROJECT_STATE, { type: 'open', name: 'book.bettertts' })
    state = projectReducer(state, { type: 'edit' })
    const requestedRevision = state.revision
    state = projectReducer(state, { type: 'edit' })
    state = projectReducer(state, { type: 'save-start' })
    state = projectReducer(state, { type: 'save-success', revision: requestedRevision })
    expect(state.dirty).toBe(true)
    expect(state.status).toBe('dirty')
    state = projectReducer(state, { type: 'save-failure', message: 'external change' })
    expect(state.error).toBe('external change')
  })

  it('models import failure and later reader recovery', () => {
    let state = readerReducer(INITIAL_READER_STATE, { type: 'import-start' })
    state = readerReducer(state, { type: 'import-failure', message: 'Unsupported document' })
    expect(state.status).toBe('failed')
    state = readerReducer(state, { type: 'import-success', documentId: 'doc-1' })
    expect(state).toMatchObject({ documentId: 'doc-1', open: true, status: 'ready', error: null })
  })

  it('makes persistence degradation visible without dropping the in-memory write contract', () => {
    let state = persistenceReducer({ state: 'unknown', pendingWrites: 0, warningShown: false, lastError: null }, { type: 'write-start' })
    expect(state.pendingWrites).toBe(1)
    state = persistenceReducer(state, { type: 'write-failure', message: 'Storage blocked' })
    state = persistenceReducer(state, { type: 'warning-shown' })
    expect(state).toMatchObject({ state: 'degraded', pendingWrites: 0, warningShown: true, lastError: 'Storage blocked' })
  })

  it('updates queue jobs atomically and clears stale active/mutation identities', () => {
    let state = queueReducer(INITIAL_QUEUE_STATE, { type: 'add', job })
    state = queueReducer(state, { type: 'activate', jobId: job.id })
    state = queueReducer(state, { type: 'mutation-start', jobId: job.id })
    expect(state).toMatchObject({ activeJobId: job.id, mutationJobId: job.id })
    state = queueReducer(state, { type: 'remove', jobId: job.id })
    expect(state).toMatchObject({ jobs: [], activeJobId: null, mutationJobId: null })
  })

  it('routes domain events without allowing one boundary to mutate another', () => {
    const next = appShellReducer(INITIAL_APP_SHELL_STATE, { domain: 'reader', event: { type: 'import-success', documentId: 'doc-1' } })
    expect(next.reader.documentId).toBe('doc-1')
    expect(next.generation).toEqual(INITIAL_GENERATION_STATE)
    expect(next.queue).toEqual(INITIAL_QUEUE_STATE)
  })
})
