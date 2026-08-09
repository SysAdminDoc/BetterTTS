import { useCallback, useReducer, useState, type SetStateAction } from 'react'
import type { M4bCapability } from '../lib/m4b.ts'
import type { QueueJob } from '../lib/queue.ts'
import { INITIAL_QUEUE_STATE, queueReducer } from '../lib/app-shell-state.ts'

export function useQueue() {
  const [queueState, dispatchQueue] = useReducer(queueReducer, INITIAL_QUEUE_STATE)
  const [regeneratingChunkKey, setRegeneratingChunkKey] = useState<string | null>(null)
  const [m4bExportingJobId, setM4bExportingJobId] = useState<string | null>(null)
  const [zipExportingJobId, setZipExportingJobId] = useState<string | null>(null)
  const [epubExportingJobId, setEpubExportingJobId] = useState<string | null>(null)
  const [m4bCapability, setM4bCapability] = useState<M4bCapability | null>(null)
  const setQueueJobs = useCallback((next: SetStateAction<QueueJob[]>) => {
    const jobs = typeof next === 'function' ? next(queueState.jobs) : next
    dispatchQueue({ type: 'replace', jobs })
  }, [queueState.jobs])
  const setActiveJobId = useCallback((jobId: string | null) => dispatchQueue({ type: 'activate', jobId }), [])
  return {
    queueJobs: queueState.jobs,
    setQueueJobs,
    activeJobId: queueState.activeJobId,
    setActiveJobId,
    regeneratingChunkKey,
    setRegeneratingChunkKey,
    m4bExportingJobId,
    setM4bExportingJobId,
    zipExportingJobId,
    setZipExportingJobId,
    epubExportingJobId,
    setEpubExportingJobId,
    m4bCapability,
    setM4bCapability,
    queueMutationJobId: queueState.mutationJobId,
    queueError: queueState.error,
    dispatchQueue,
  }
}
