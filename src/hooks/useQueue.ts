import { useState } from 'react'
import type { M4bCapability } from '../lib/m4b.ts'
import type { QueueJob } from '../lib/queue.ts'

export function useQueue() {
  const [queueJobs, setQueueJobs] = useState<QueueJob[]>([])
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [regeneratingChunkKey, setRegeneratingChunkKey] = useState<string | null>(null)
  const [m4bExportingJobId, setM4bExportingJobId] = useState<string | null>(null)
  const [zipExportingJobId, setZipExportingJobId] = useState<string | null>(null)
  const [epubExportingJobId, setEpubExportingJobId] = useState<string | null>(null)
  const [m4bCapability, setM4bCapability] = useState<M4bCapability | null>(null)
  return {
    queueJobs,
    setQueueJobs,
    activeJobId,
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
  }
}
