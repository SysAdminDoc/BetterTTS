import type { QueueJob } from './queue.ts'

export type GenerationStats = {
  elapsed: number
  chars: number
  audioDuration: number
  timeToFirstAudioMs: number | null
}

export type GenerationPhase = 'idle' | 'starting' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'

export type GenerationState = {
  phase: GenerationPhase
  progress: number | null
  status: string
  stats: GenerationStats | null
  runId: string | null
  error: string | null
  partialOutput: boolean
}

export const INITIAL_GENERATION_STATE: GenerationState = {
  phase: 'idle',
  progress: null,
  status: 'Ready',
  stats: null,
  runId: null,
  error: null,
  partialOutput: false,
}

export type GenerationEvent =
  | { type: 'start'; runId: string; status?: string }
  | { type: 'progress'; value: number | null; status?: string }
  | { type: 'cancel-requested' }
  | { type: 'complete'; status?: string; stats?: GenerationStats | null; partialOutput?: boolean }
  | { type: 'cancelled'; status?: string; stats?: GenerationStats | null; partialOutput: boolean }
  | { type: 'fail'; message: string; status?: string }
  | { type: 'reset' }
  | { type: 'set-progress'; value: number | null }
  | { type: 'set-status'; value: string }
  | { type: 'set-stats'; value: GenerationStats | null }
  | { type: 'set-busy'; value: boolean }

function boundedProgress(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

export function generationReducer(state: GenerationState, event: GenerationEvent): GenerationState {
  switch (event.type) {
    case 'start':
      return {
        ...state,
        phase: 'starting',
        progress: 0,
        status: event.status ?? 'Starting',
        runId: event.runId,
        error: null,
        partialOutput: false,
      }
    case 'progress':
      return {
        ...state,
        phase: state.phase === 'starting' ? 'running' : state.phase,
        progress: boundedProgress(event.value),
        ...(event.status === undefined ? {} : { status: event.status }),
      }
    case 'cancel-requested':
      return state.phase === 'idle' || state.phase === 'completed' || state.phase === 'cancelled' || state.phase === 'failed'
        ? state
        : { ...state, phase: 'cancelling', status: 'Cancelling…' }
    case 'complete':
      return {
        ...state,
        phase: 'completed',
        progress: 100,
        status: event.status ?? 'Complete',
        stats: event.stats === undefined ? state.stats : event.stats,
        error: null,
        partialOutput: event.partialOutput ?? false,
      }
    case 'cancelled':
      return {
        ...state,
        phase: 'cancelled',
        progress: event.partialOutput ? state.progress : 100,
        status: event.status ?? (event.partialOutput ? 'Cancelled. The partial output was kept.' : 'Cancelled'),
        stats: event.stats === undefined ? state.stats : event.stats,
        error: null,
        partialOutput: event.partialOutput,
      }
    case 'fail':
      return {
        ...state,
        phase: 'failed',
        progress: null,
        status: event.status ?? 'Generation failed',
        error: event.message,
        partialOutput: false,
      }
    case 'reset':
      return INITIAL_GENERATION_STATE
    case 'set-progress':
      return { ...state, progress: boundedProgress(event.value) }
    case 'set-status': {
      const status = event.value
      if (/^cancel(?:led|ling)/iu.test(status)) {
        return { ...state, status, phase: status.toLowerCase().startsWith('cancelling') ? 'cancelling' : 'cancelled' }
      }
      if (/failed|error/iu.test(status)) return { ...state, status, phase: 'failed' }
      if (/ready|complete|local audio ready|browser playback complete/iu.test(status) && !state.runId) {
        return { ...state, status, phase: 'idle' }
      }
      return { ...state, status }
    }
    case 'set-stats':
      return { ...state, stats: event.value }
    case 'set-busy':
      if (event.value) {
        return {
          ...state,
          phase: state.phase === 'cancelling' ? 'cancelling' : state.phase === 'starting' ? 'starting' : 'running',
        }
      }
      if (state.phase === 'starting' || state.phase === 'running' || state.phase === 'cancelling') {
        const phase = /cancel/iu.test(state.status)
          ? 'cancelled'
          : /failed|error/iu.test(state.status)
            ? 'failed'
            : /ready|complete|local audio ready|browser playback complete/iu.test(state.status)
              ? 'completed'
              : 'idle'
        return { ...state, phase, runId: phase === 'idle' ? null : state.runId }
      }
      return state
  }
}

export type QueueDomainState = {
  jobs: QueueJob[]
  activeJobId: string | null
  mutationJobId: string | null
  error: string | null
}

export const INITIAL_QUEUE_STATE: QueueDomainState = {
  jobs: [],
  activeJobId: null,
  mutationJobId: null,
  error: null,
}

export type QueueEvent =
  | { type: 'replace'; jobs: QueueJob[] }
  | { type: 'add'; job: QueueJob }
  | { type: 'update'; job: QueueJob }
  | { type: 'remove'; jobId: string }
  | { type: 'activate'; jobId: string | null }
  | { type: 'mutation-start'; jobId: string }
  | { type: 'mutation-end' }
  | { type: 'error'; message: string }
  | { type: 'clear-error' }

export function queueReducer(state: QueueDomainState, event: QueueEvent): QueueDomainState {
  switch (event.type) {
    case 'replace':
      return { ...state, jobs: [...event.jobs], activeJobId: state.activeJobId && event.jobs.some((job) => job.id === state.activeJobId) ? state.activeJobId : null, error: null }
    case 'add':
      return { ...state, jobs: [event.job, ...state.jobs.filter((job) => job.id !== event.job.id)], error: null }
    case 'update':
      return { ...state, jobs: state.jobs.map((job) => job.id === event.job.id ? event.job : job), error: null }
    case 'remove':
      return { ...state, jobs: state.jobs.filter((job) => job.id !== event.jobId), activeJobId: state.activeJobId === event.jobId ? null : state.activeJobId, mutationJobId: state.mutationJobId === event.jobId ? null : state.mutationJobId }
    case 'activate':
      return { ...state, activeJobId: event.jobId && state.jobs.some((job) => job.id === event.jobId) ? event.jobId : null }
    case 'mutation-start':
      return { ...state, mutationJobId: event.jobId, error: null }
    case 'mutation-end':
      return { ...state, mutationJobId: null }
    case 'error':
      return { ...state, mutationJobId: null, error: event.message }
    case 'clear-error':
      return { ...state, error: null }
  }
}

export type ProjectDomainState = {
  name: string | null
  dirty: boolean
  revision: number
  savedRevision: number
  status: 'closed' | 'saved' | 'saving' | 'dirty' | 'failed'
  error: string | null
}

export const INITIAL_PROJECT_STATE: ProjectDomainState = {
  name: null,
  dirty: false,
  revision: 0,
  savedRevision: 0,
  status: 'closed',
  error: null,
}

export type ProjectEvent =
  | { type: 'open'; name: string; revision?: number }
  | { type: 'edit' }
  | { type: 'save-start' }
  | { type: 'save-success'; name?: string; revision: number }
  | { type: 'save-failure'; message: string }
  | { type: 'close' }

export function projectReducer(state: ProjectDomainState, event: ProjectEvent): ProjectDomainState {
  switch (event.type) {
    case 'open': {
      const revision = event.revision ?? 0
      return { name: event.name, dirty: false, revision, savedRevision: revision, status: 'saved', error: null }
    }
    case 'edit':
      return { ...state, dirty: true, revision: state.revision + 1, status: 'dirty', error: null }
    case 'save-start':
      return { ...state, status: 'saving', error: null }
    case 'save-success':
      return {
        ...state,
        name: event.name ?? state.name,
        dirty: event.revision !== state.revision,
        savedRevision: event.revision,
        status: event.revision === state.revision ? 'saved' : 'dirty',
        error: null,
      }
    case 'save-failure':
      return { ...state, dirty: true, status: 'failed', error: event.message }
    case 'close':
      return INITIAL_PROJECT_STATE
  }
}

export type ReaderDomainState = {
  documentId: string | null
  open: boolean
  status: 'empty' | 'importing' | 'ready' | 'failed'
  error: string | null
}

export const INITIAL_READER_STATE: ReaderDomainState = {
  documentId: null,
  open: false,
  status: 'empty',
  error: null,
}

export type ReaderEvent =
  | { type: 'import-start' }
  | { type: 'import-success'; documentId: string; open?: boolean }
  | { type: 'import-failure'; message: string }
  | { type: 'toggle'; open?: boolean }
  | { type: 'clear' }

export function readerReducer(state: ReaderDomainState, event: ReaderEvent): ReaderDomainState {
  switch (event.type) {
    case 'import-start':
      return { ...state, status: 'importing', error: null }
    case 'import-success':
      return { documentId: event.documentId, open: event.open ?? true, status: 'ready', error: null }
    case 'import-failure':
      return { ...state, status: 'failed', error: event.message }
    case 'toggle':
      return { ...state, open: event.open ?? !state.open }
    case 'clear':
      return INITIAL_READER_STATE
  }
}

export type PersistenceDomainState = {
  state: 'unknown' | 'durable' | 'degraded' | 'unavailable'
  pendingWrites: number
  warningShown: boolean
  lastError: string | null
}

export const INITIAL_PERSISTENCE_STATE: PersistenceDomainState = {
  state: 'unknown',
  pendingWrites: 0,
  warningShown: false,
  lastError: null,
}

export type PersistenceEvent =
  | { type: 'write-start' }
  | { type: 'write-success'; durable: boolean }
  | { type: 'write-failure'; message: string; unavailable?: boolean }
  | { type: 'warning-shown' }

export function persistenceReducer(state: PersistenceDomainState, event: PersistenceEvent): PersistenceDomainState {
  switch (event.type) {
    case 'write-start':
      return { ...state, pendingWrites: state.pendingWrites + 1 }
    case 'write-success':
      return { ...state, state: event.durable ? 'durable' : 'degraded', pendingWrites: Math.max(0, state.pendingWrites - 1), lastError: null }
    case 'write-failure':
      return { ...state, state: event.unavailable ? 'unavailable' : 'degraded', pendingWrites: Math.max(0, state.pendingWrites - 1), lastError: event.message }
    case 'warning-shown':
      return { ...state, warningShown: true }
  }
}

export type PlaybackDomainState = {
  key: string | null
  playing: boolean
  currentTime: number
  duration: number
  resumed: boolean
}

export const INITIAL_PLAYBACK_STATE: PlaybackDomainState = {
  key: null,
  playing: false,
  currentTime: 0,
  duration: 0,
  resumed: false,
}

export type PlaybackEvent =
  | { type: 'load'; key: string; duration?: number; currentTime?: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'time'; currentTime: number; duration?: number }
  | { type: 'ended' }
  | { type: 'clear' }

export function playbackReducer(state: PlaybackDomainState, event: PlaybackEvent): PlaybackDomainState {
  switch (event.type) {
    case 'load':
      return { key: event.key, playing: false, currentTime: Math.max(0, event.currentTime ?? 0), duration: Math.max(0, event.duration ?? 0), resumed: (event.currentTime ?? 0) > 0 }
    case 'play':
      return { ...state, playing: true }
    case 'pause':
      return { ...state, playing: false }
    case 'time':
      return { ...state, currentTime: Math.max(0, event.currentTime), duration: Math.max(0, event.duration ?? state.duration) }
    case 'ended':
      return { ...state, playing: false, currentTime: state.duration }
    case 'clear':
      return INITIAL_PLAYBACK_STATE
  }
}

export type DiagnosticsDomainState = {
  recentEventCount: number
  lastEvent: string | null
  bundleStatus: 'idle' | 'collecting' | 'ready' | 'failed'
  lastBundleAt: string | null
  error: string | null
}

export const INITIAL_DIAGNOSTICS_STATE: DiagnosticsDomainState = {
  recentEventCount: 0,
  lastEvent: null,
  bundleStatus: 'idle',
  lastBundleAt: null,
  error: null,
}

export type DiagnosticsEvent =
  | { type: 'record'; message: string; count: number }
  | { type: 'collect-start' }
  | { type: 'collect-success'; generatedAt: string }
  | { type: 'collect-failure'; message: string }

export function diagnosticsReducer(state: DiagnosticsDomainState, event: DiagnosticsEvent): DiagnosticsDomainState {
  switch (event.type) {
    case 'record':
      return { ...state, recentEventCount: Math.max(0, event.count), lastEvent: event.message }
    case 'collect-start':
      return { ...state, bundleStatus: 'collecting', error: null }
    case 'collect-success':
      return { ...state, bundleStatus: 'ready', lastBundleAt: event.generatedAt, error: null }
    case 'collect-failure':
      return { ...state, bundleStatus: 'failed', error: event.message }
  }
}

export type AppShellDomainState = {
  generation: GenerationState
  queue: QueueDomainState
  project: ProjectDomainState
  reader: ReaderDomainState
  persistence: PersistenceDomainState
  playback: PlaybackDomainState
  diagnostics: DiagnosticsDomainState
}

export const INITIAL_APP_SHELL_STATE: AppShellDomainState = {
  generation: INITIAL_GENERATION_STATE,
  queue: INITIAL_QUEUE_STATE,
  project: INITIAL_PROJECT_STATE,
  reader: INITIAL_READER_STATE,
  persistence: INITIAL_PERSISTENCE_STATE,
  playback: INITIAL_PLAYBACK_STATE,
  diagnostics: INITIAL_DIAGNOSTICS_STATE,
}

export type AppShellEvent =
  | { domain: 'generation'; event: GenerationEvent }
  | { domain: 'queue'; event: QueueEvent }
  | { domain: 'project'; event: ProjectEvent }
  | { domain: 'reader'; event: ReaderEvent }
  | { domain: 'persistence'; event: PersistenceEvent }
  | { domain: 'playback'; event: PlaybackEvent }
  | { domain: 'diagnostics'; event: DiagnosticsEvent }

export function appShellReducer(state: AppShellDomainState, event: AppShellEvent): AppShellDomainState {
  switch (event.domain) {
    case 'generation': return { ...state, generation: generationReducer(state.generation, event.event) }
    case 'queue': return { ...state, queue: queueReducer(state.queue, event.event) }
    case 'project': return { ...state, project: projectReducer(state.project, event.event) }
    case 'reader': return { ...state, reader: readerReducer(state.reader, event.event) }
    case 'persistence': return { ...state, persistence: persistenceReducer(state.persistence, event.event) }
    case 'playback': return { ...state, playback: playbackReducer(state.playback, event.event) }
    case 'diagnostics': return { ...state, diagnostics: diagnosticsReducer(state.diagnostics, event.event) }
  }
}
