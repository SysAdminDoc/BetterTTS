import { describe, expect, it } from 'vitest'
import {
  MOBILE_LISTENING_CONTRACT,
  MOBILE_MIN_TOUCH_TARGET_PX,
  evaluateMobileListeningContract,
  readMobileLifecycleSnapshot,
  type MobileListeningInput,
} from './mobile-listening-contract.ts'

const readyInput: MobileListeningInput = {
  foreground: true,
  connectivity: 'online',
  shell: { ready: true, serviceWorkerControlled: true },
  model: { available: true, ready: true, cached: true, offlineCapable: true },
  synthesis: { phase: 'idle' },
  reader: { documentId: 'reader-1', persisted: true, chapterIndex: 0, timeSec: 12.5 },
  playback: { key: 'reader:reader-1', persisted: true, timeSec: 12.5, durationSec: 120 },
  queue: { durable: true, pendingJobCount: 2, touchTargetPx: MOBILE_MIN_TOUCH_TARGET_PX },
  share: { postFile: true, openFile: true, getTextUrl: true },
}

describe('mobile foreground/offline listening contract', () => {
  it('defines durable storage, offline, touch, and share boundaries', () => {
    expect(MOBILE_LISTENING_CONTRACT.schemaVersion).toBe(1)
    expect(MOBILE_LISTENING_CONTRACT.persistence).toMatchObject({
      readerResumePrefix: 'bettertts-reader-v1:',
      playbackResumeKey: 'bettertts-playback-v1',
      queueDatabase: 'bettertts-queue',
    })
    expect(MOBILE_LISTENING_CONTRACT.offline.cachedReadyModelRequiredForSynthesis).toBe(true)
    expect(MOBILE_LISTENING_CONTRACT.share.fallbackRoutes).toEqual(['open-file', 'get-text-url', 'paste'])
  })

  it('normalizes foreground and connectivity lifecycle events without side effects', () => {
    expect(readMobileLifecycleSnapshot({ visibilityState: 'hidden', onLine: false })).toEqual({ foreground: false, connectivity: 'offline' })
    expect(readMobileLifecycleSnapshot({ visibilityState: 'visible', onLine: true })).toEqual({ foreground: true, connectivity: 'online' })
    expect(readMobileLifecycleSnapshot({ visibilityState: 'visible' })).toEqual({ foreground: true, connectivity: 'unknown' })
  })

  it('accepts an online listening surface with persisted positions and resumable queue work', () => {
    const result = evaluateMobileListeningContract(readyInput)
    expect(result).toMatchObject({
      schemaVersion: 1,
      valid: true,
      readiness: { shell: 'ready', model: 'ready', synthesis: 'ready', listening: 'ready' },
      recovery: { reader: 'persisted', playback: 'persisted', queue: 'ready' },
      share: { primaryRoute: 'post-file' },
    })
    expect(result.issues).toEqual([])
  })

  it('requires a controlled shell and cached ready model for offline synthesis', () => {
    const result = evaluateMobileListeningContract({
      ...readyInput,
      connectivity: 'offline',
      shell: { ready: true, serviceWorkerControlled: false },
      model: { available: true, ready: false, cached: false, offlineCapable: true },
    })
    expect(result.readiness).toMatchObject({ listening: 'blocked', model: 'offline-cache-missing', synthesis: 'offline-model-required', offlineSynthesisReady: false })
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['offline-shell-unavailable', 'offline-model-unavailable']))
  })

  it('makes background interruption explicit for queue and direct synthesis', () => {
    const queue = evaluateMobileListeningContract({
      ...readyInput,
      foreground: false,
      synthesis: { phase: 'running', kind: 'queue', queueJobId: 'job-1' },
    })
    expect(queue.recovery.synthesis).toBe('resume-queue')
    expect(queue.issues).toContainEqual(expect.objectContaining({ code: 'synthesis-interrupted' }))

    const direct = evaluateMobileListeningContract({
      ...readyInput,
      foreground: false,
      synthesis: { phase: 'running', kind: 'direct' },
    })
    expect(direct.recovery.synthesis).toBe('restart-direct')
  })

  it('rejects unsafe queue recovery and missing reader/playback positions', () => {
    const result = evaluateMobileListeningContract({
      ...readyInput,
      reader: { documentId: 'reader-1', persisted: false, chapterIndex: 0 },
      playback: { key: 'reader:reader-1', persisted: false, timeSec: -1, durationSec: 120 },
      queue: { durable: false, pendingJobCount: 1, touchTargetPx: 32 },
      share: { postFile: false, openFile: false, getTextUrl: false },
    })
    expect(result.recovery).toMatchObject({ reader: 'not-persisted', playback: 'not-persisted', queue: 'storage-unavailable' })
    expect(result.share.routes).toEqual(['paste'])
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'reader-resume-missing',
      'playback-resume-missing',
      'queue-storage-unavailable',
      'queue-touch-target-too-small',
    ]))
  })
})
