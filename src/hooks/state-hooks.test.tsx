// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClipRecord } from '../lib/library.ts'
import type { QueueJob } from '../lib/queue.ts'
import { useLibrary } from './useLibrary.ts'
import { useQueue } from './useQueue.ts'

function QueueHarness({ capture }: { capture: (state: ReturnType<typeof useQueue>) => void }) {
  capture(useQueue())
  return null
}

function LibraryHarness({ capture }: { capture: (state: ReturnType<typeof useLibrary>) => void }) {
  capture(useLibrary())
  return null
}

const queueJob: QueueJob = {
  schemaVersion: 2,
  id: 'queue-hook-job',
  title: 'Queue hook job',
  createdAt: 1,
  engine: 'kokoro',
  voice: 'af_heart',
  speed: 1,
  format: 'wav',
  bitrate: 160,
  chunks: [],
}

const clip: ClipRecord = {
  id: 'library-hook-clip',
  filename: 'clip.wav',
  label: 'Library hook clip',
  voice: 'af_heart',
  speed: 1,
  createdAt: 1,
  size: 44,
  duration: '0:01',
}

describe('queue and library state hooks', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  it('owns queue state updates independently of the app shell', () => {
    const state: { current: ReturnType<typeof useQueue> | null } = { current: null }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(<QueueHarness capture={(next) => { state.current = next }} />))
    expect(state.current?.queueJobs).toEqual([])
    act(() => state.current?.setQueueJobs([queueJob]))
    expect(state.current?.queueJobs).toEqual([queueJob])
    act(() => state.current?.setActiveJobId(queueJob.id))
    expect(state.current?.activeJobId).toBe(queueJob.id)
  })

  it('owns library state updates independently of queue state', () => {
    const state: { current: ReturnType<typeof useLibrary> | null } = { current: null }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(<LibraryHarness capture={(next) => { state.current = next }} />))
    expect(state.current?.library).toEqual([])
    act(() => state.current?.setLibrary([clip]))
    expect(state.current?.library).toEqual([clip])
  })
})
