export const MOBILE_LISTENING_CONTRACT_VERSION = 1 as const
export const MOBILE_MIN_TOUCH_TARGET_PX = 44

export const MOBILE_LISTENING_CONTRACT = {
  schemaVersion: MOBILE_LISTENING_CONTRACT_VERSION,
  minTouchTargetPx: MOBILE_MIN_TOUCH_TARGET_PX,
  persistence: {
    readerResumePrefix: 'bettertts-reader-v1:',
    playbackResumeKey: 'bettertts-playback-v1',
    queueDatabase: 'bettertts-queue',
  },
  offline: {
    controlledShellRequired: true,
    cachedReadyModelRequiredForSynthesis: true,
  },
  share: {
    preferredRoute: 'post-file',
    fallbackRoutes: ['open-file', 'get-text-url', 'paste'],
  },
} as const

export type MobileConnectivity = 'online' | 'offline' | 'unknown'
export type MobileLifecycleSnapshot = {
  foreground: boolean
  connectivity: MobileConnectivity
}
export type MobileSynthesisPhase = 'idle' | 'starting' | 'running' | 'cancelling' | 'interrupted' | 'completed' | 'cancelled' | 'failed'
export type MobileSynthesisKind = 'direct' | 'queue'
export type MobileShareRoute = 'post-file' | 'open-file' | 'get-text-url' | 'paste'
export type MobileIssueCode =
  | 'shell-not-ready'
  | 'offline-shell-unavailable'
  | 'offline-model-unavailable'
  | 'synthesis-interrupted'
  | 'reader-resume-missing'
  | 'playback-resume-missing'
  | 'queue-storage-unavailable'
  | 'queue-touch-target-too-small'

export type MobileListeningInput = {
  foreground: boolean
  connectivity: MobileConnectivity
  shell: {
    ready: boolean
    serviceWorkerControlled: boolean
  }
  model: {
    available?: boolean
    ready: boolean
    cached: boolean
    offlineCapable: boolean
  }
  synthesis: {
    phase: MobileSynthesisPhase
    kind?: MobileSynthesisKind
    queueJobId?: string | null
  }
  reader: {
    documentId?: string | null
    persisted: boolean
    chapterIndex?: number
    timeSec?: number
  }
  playback: {
    key?: string | null
    persisted: boolean
    timeSec?: number
    durationSec?: number
  }
  queue: {
    durable: boolean
    pendingJobCount: number
    touchTargetPx?: number
  }
  share: {
    postFile: boolean
    openFile: boolean
    getTextUrl: boolean
  }
}

export type MobileListeningIssue = {
  code: MobileIssueCode
  message: string
}

export type MobileListeningContractResult = {
  schemaVersion: typeof MOBILE_LISTENING_CONTRACT_VERSION
  valid: boolean
  lifecycle: {
    foreground: boolean
    connectivity: MobileConnectivity
    offlineShellReady: boolean
  }
  readiness: {
    shell: 'ready' | 'blocked'
    model: 'ready' | 'load-required' | 'offline-cache-missing' | 'unsupported'
    synthesis: 'ready' | 'load-model' | 'offline-model-required' | 'blocked'
    listening: 'ready' | 'shell-only' | 'blocked'
    offlineSynthesisReady: boolean
  }
  recovery: {
    synthesis: 'none' | 'wait-for-foreground' | 'resume-queue' | 'restart-direct' | 'resume-required'
    reader: 'persisted' | 'not-persisted'
    playback: 'persisted' | 'not-persisted'
    queue: 'ready' | 'not-needed' | 'storage-unavailable' | 'touch-unsafe'
  }
  share: {
    routes: MobileShareRoute[]
    primaryRoute: MobileShareRoute
  }
  issues: MobileListeningIssue[]
}

const ACTIVE_SYNTHESIS_PHASES = new Set<MobileSynthesisPhase>(['starting', 'running', 'cancelling', 'interrupted'])

export function readMobileLifecycleSnapshot(environment: { visibilityState?: string; onLine?: boolean } = {}): MobileLifecycleSnapshot {
  const visibilityState = environment.visibilityState ?? (typeof document === 'undefined' ? 'visible' : document.visibilityState)
  const onLine = environment.onLine ?? (typeof navigator === 'undefined' ? undefined : navigator.onLine)
  return {
    foreground: visibilityState !== 'hidden',
    connectivity: onLine === undefined ? 'unknown' : onLine ? 'online' : 'offline',
  }
}

function finiteNonNegative(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value >= 0)
}

function validReaderResume(input: MobileListeningInput['reader']): boolean {
  return Boolean(input.documentId?.trim())
    && input.persisted
    && Number.isSafeInteger(input.chapterIndex)
    && (input.chapterIndex ?? -1) >= 0
    && finiteNonNegative(input.timeSec)
}

function validPlaybackResume(input: MobileListeningInput['playback']): boolean {
  return Boolean(input.key?.trim())
    && input.persisted
    && Number.isFinite(input.timeSec)
    && (input.timeSec ?? -1) >= 0
    && finiteNonNegative(input.durationSec)
}

function shareRoutes(input: MobileListeningInput['share']): MobileShareRoute[] {
  const routes: MobileShareRoute[] = []
  if (input.postFile) routes.push('post-file')
  if (input.openFile) routes.push('open-file')
  if (input.getTextUrl) routes.push('get-text-url')
  routes.push('paste')
  return routes
}

export function evaluateMobileListeningContract(input: MobileListeningInput): MobileListeningContractResult {
  const modelAvailable = input.model.available !== false
  const offlineShellReady = input.shell.ready && input.shell.serviceWorkerControlled
  const offlineModelReady = modelAvailable && input.model.ready && input.model.cached && input.model.offlineCapable
  const modelReadiness = !modelAvailable
    ? 'unsupported' as const
    : input.model.ready
      ? 'ready' as const
      : input.connectivity === 'offline' && !input.model.cached
        ? 'offline-cache-missing' as const
        : 'load-required' as const
  const readerPersisted = validReaderResume(input.reader)
  const playbackPersisted = validPlaybackResume(input.playback)
  const touchTargetPx = Number.isFinite(input.queue.touchTargetPx) ? Math.max(0, input.queue.touchTargetPx ?? 0) : 0
  const pendingJobCount = Number.isFinite(input.queue.pendingJobCount) ? Math.max(0, Math.floor(input.queue.pendingJobCount)) : 0
  const activeSynthesis = ACTIVE_SYNTHESIS_PHASES.has(input.synthesis.phase)
  const interruptedSynthesis = input.synthesis.phase === 'interrupted' || (activeSynthesis && !input.foreground)
  const queueCanRecover = input.queue.durable && pendingJobCount > 0 && (input.synthesis.kind === 'queue' || Boolean(input.synthesis.queueJobId))
  const synthesisRecovery = !interruptedSynthesis
    ? 'none' as const
    : queueCanRecover
      ? 'resume-queue' as const
      : input.synthesis.kind === 'direct'
        ? 'restart-direct' as const
        : input.foreground
          ? 'resume-required' as const
          : 'wait-for-foreground' as const
  const synthesisReadiness = !input.shell.ready || !modelAvailable
    ? 'blocked' as const
    : input.connectivity === 'offline' && !offlineModelReady
      ? 'offline-model-required' as const
      : !input.model.ready
        ? 'load-model' as const
        : 'ready' as const
  const listeningReadiness = !input.shell.ready || (input.connectivity === 'offline' && !offlineShellReady)
    ? 'blocked' as const
    : input.model.ready || readerPersisted || playbackPersisted
      ? 'ready' as const
      : 'shell-only' as const
  const queueRecovery = !input.queue.durable
    ? 'storage-unavailable' as const
    : touchTargetPx < MOBILE_MIN_TOUCH_TARGET_PX
      ? 'touch-unsafe' as const
      : pendingJobCount > 0
        ? 'ready' as const
        : 'not-needed' as const
  const issues: MobileListeningIssue[] = []
  if (!input.shell.ready) issues.push({ code: 'shell-not-ready', message: 'The app shell must be ready before mobile listening or synthesis starts.' })
  if (input.connectivity === 'offline' && !offlineShellReady) issues.push({ code: 'offline-shell-unavailable', message: 'Offline listening requires a controlled, ready app shell.' })
  if (input.connectivity === 'offline' && !offlineModelReady) issues.push({ code: 'offline-model-unavailable', message: 'Offline synthesis requires a cached, ready model with offline capability.' })
  if (interruptedSynthesis) issues.push({ code: 'synthesis-interrupted', message: synthesisRecovery === 'resume-queue' ? 'Foreground the app to resume the durable queue job.' : 'The interrupted direct run must be restarted in the foreground.' })
  if (input.reader.documentId?.trim() && !readerPersisted) issues.push({ code: 'reader-resume-missing', message: 'An open reader document must persist a bounded chapter and sentence/time position.' })
  if (input.playback.key?.trim() && !playbackPersisted) issues.push({ code: 'playback-resume-missing', message: 'An active audio item must persist a bounded playback position.' })
  if (!input.queue.durable) issues.push({ code: 'queue-storage-unavailable', message: 'Mobile queue recovery requires durable queue storage.' })
  if (touchTargetPx < MOBILE_MIN_TOUCH_TARGET_PX) issues.push({ code: 'queue-touch-target-too-small', message: `Queue actions must expose at least ${MOBILE_MIN_TOUCH_TARGET_PX}px touch targets.` })
  const routes = shareRoutes(input.share)

  return {
    schemaVersion: MOBILE_LISTENING_CONTRACT_VERSION,
    valid: issues.length === 0,
    lifecycle: {
      foreground: input.foreground,
      connectivity: input.connectivity,
      offlineShellReady,
    },
    readiness: {
      shell: input.shell.ready ? 'ready' : 'blocked',
      model: modelReadiness,
      synthesis: synthesisReadiness,
      listening: listeningReadiness,
      offlineSynthesisReady: offlineShellReady && offlineModelReady,
    },
    recovery: {
      synthesis: synthesisRecovery,
      reader: readerPersisted ? 'persisted' : 'not-persisted',
      playback: playbackPersisted ? 'persisted' : 'not-persisted',
      queue: queueRecovery,
    },
    share: {
      routes,
      primaryRoute: routes[0] ?? 'paste',
    },
    issues,
  }
}
