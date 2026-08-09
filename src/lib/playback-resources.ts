export const PLAYBACK_RESOURCE_LIMITS = {
  maxLoadedChunkPlayers: 4,
  maxStreamAheadSeconds: 8,
  maxStreamChunkSeconds: 2,
  maxEncoderQueueSize: 4,
  choppinessWindowSeconds: 60,
  choppyRatio: 0.05,
} as const

export type PlaybackResourceReleaseReason = 'released' | 'evicted' | 'ended' | 'cancelled' | 'error'

export type PlaybackResourceLease = {
  readonly key: string
  readonly acquired: true
  release: (reason?: PlaybackResourceReleaseReason) => void
  touch: () => void
}

type ResourceEntry = {
  key: string
  sequence: number
  isPinned: () => boolean
  release: (reason: PlaybackResourceReleaseReason) => void
  released: boolean
}

export class BoundedPlaybackResourcePool {
  private readonly entries = new Map<string, ResourceEntry>()
  private readonly maxEntries: number
  private sequence = 0

  constructor(maxEntries: number = PLAYBACK_RESOURCE_LIMITS.maxLoadedChunkPlayers) {
    this.maxEntries = maxEntries
  }

  acquire(
    key: string,
    onRelease: (reason: PlaybackResourceReleaseReason) => void,
    isPinned: () => boolean = () => false,
  ): PlaybackResourceLease | null {
    const normalizedKey = key.trim()
    if (!normalizedKey || this.maxEntries <= 0) return null
    this.entries.get(normalizedKey)?.release('released')

    while (this.entries.size >= this.maxEntries) {
      const evictable = Array.from(this.entries.values())
        .filter((entry) => !safePinned(entry.isPinned))
        .sort((left, right) => left.sequence - right.sequence)[0]
      if (!evictable) return null
      evictable.release('evicted')
    }

    const entry: ResourceEntry = {
      key: normalizedKey,
      sequence: ++this.sequence,
      isPinned,
      release: () => {},
      released: false,
    }
    entry.release = (reason) => {
      if (entry.released) return
      entry.released = true
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
      onRelease(reason)
    }
    this.entries.set(normalizedKey, entry)
    return {
      key: normalizedKey,
      acquired: true,
      release: (reason = 'released') => entry.release(reason),
      touch: () => {
        if (!entry.released) entry.sequence = ++this.sequence
      },
    }
  }

  get size(): number {
    return this.entries.size
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  releaseAll(reason: PlaybackResourceReleaseReason = 'released'): void {
    for (const entry of Array.from(this.entries.values())) entry.release(reason)
  }
}

function safePinned(isPinned: () => boolean): boolean {
  try {
    return isPinned()
  } catch {
    return true
  }
}

export function releaseAudioElement(audio: HTMLAudioElement): void {
  try {
    audio.pause()
  } catch {
    // A detached or already-disposed media element is safe to ignore.
  }
  try {
    audio.removeAttribute('src')
  } catch {
    try {
      audio.src = ''
    } catch {
      // Ignore browsers that expose a read-only detached src.
    }
  }
  try {
    audio.srcObject = null
  } catch {
    // srcObject is not implemented by every test/browser audio element.
  }
  try {
    audio.load()
  } catch {
    // load() can throw after a media element has been detached.
  }
}

export async function playEphemeralAudio(audio: HTMLAudioElement): Promise<void> {
  let finish: (() => void) | null = null
  let fail: ((error: Error) => void) | null = null
  const ended = new Promise<void>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  const finishPlayback = () => {
    const resolver = finish
    if (resolver) resolver()
  }
  const onEnded = () => finishPlayback()
  const onError = () => fail?.(new Error('Audio playback failed.'))
  audio.addEventListener('ended', onEnded, { once: true })
  audio.addEventListener('error', onError, { once: true })
  try {
    await audio.play()
    if (audio.ended) finishPlayback()
    await ended
  } finally {
    audio.removeEventListener('ended', onEnded)
    audio.removeEventListener('error', onError)
    releaseAudioElement(audio)
  }
}

export function throwIfAborted(signal?: AbortSignal, message = 'Playback was cancelled.'): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  const isDefaultAbortReason = typeof DOMException !== 'undefined'
    && reason instanceof DOMException
    && reason.name === 'AbortError'
    && reason.message === 'This operation was aborted'
  if (reason instanceof Error && !isDefaultAbortReason) throw reason
  if (typeof DOMException !== 'undefined') throw new DOMException(message, 'AbortError')
  const error = new Error(message)
  error.name = 'AbortError'
  throw error
}

export function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  throwIfAborted(signal, message)
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      try {
        throwIfAborted(signal, message)
      } catch (error) {
        reject(error)
      }
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

type EncoderQueueProbe = {
  readonly encodeQueueSize?: number
}

export async function waitForEncoderCapacity(
  encoder: EncoderQueueProbe,
  signal?: AbortSignal,
  maxQueueSize = PLAYBACK_RESOURCE_LIMITS.maxEncoderQueueSize,
): Promise<void> {
  while ((encoder.encodeQueueSize ?? 0) > maxQueueSize) {
    throwIfAborted(signal, 'Audio encoding was cancelled.')
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        try {
          throwIfAborted(signal, 'Audio encoding was cancelled.')
        } catch (error) {
          reject(error)
        }
      }
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, 8)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  throwIfAborted(signal, 'Audio encoding was cancelled.')
}

export type PlaybackChoppinessSnapshot = {
  waitingEvents: number
  stalledEvents: number
  recoveries: number
  observedSeconds: number
  bufferingSeconds: number
  choppyRatio: number
  status: 'insufficient' | 'healthy' | 'choppy'
}

export class PlaybackChoppinessTracker {
  private startedAt: number | null = null
  private lastBufferingAt: number | null = null
  private bufferingMs = 0
  private waitingEvents = 0
  private stalledEvents = 0
  private recoveries = 0

  start(now = performance.now()): void {
    if (this.startedAt === null) this.startedAt = now
  }

  recordWaiting(now = performance.now()): void {
    this.start(now)
    this.waitingEvents += 1
    this.lastBufferingAt ??= now
  }

  recordStalled(now = performance.now()): void {
    this.start(now)
    this.stalledEvents += 1
    this.lastBufferingAt ??= now
  }

  recordPlaying(now = performance.now()): void {
    this.start(now)
    if (this.lastBufferingAt !== null) {
      this.bufferingMs += Math.max(0, now - this.lastBufferingAt)
      this.lastBufferingAt = null
      this.recoveries += 1
    }
  }

  finish(now = performance.now()): PlaybackChoppinessSnapshot {
    if (this.lastBufferingAt !== null) {
      this.bufferingMs += Math.max(0, now - this.lastBufferingAt)
      this.lastBufferingAt = null
    }
    return this.snapshot(now)
  }

  snapshot(now = performance.now()): PlaybackChoppinessSnapshot {
    const observedMs = this.startedAt === null ? 0 : Math.max(0, now - this.startedAt)
    const activeBufferingMs = this.lastBufferingAt === null ? 0 : Math.max(0, now - this.lastBufferingAt)
    const bufferingSeconds = (this.bufferingMs + activeBufferingMs) / 1000
    const observedSeconds = observedMs / 1000
    const choppyRatio = observedSeconds > 0 ? Math.min(1, bufferingSeconds / observedSeconds) : 0
    const status = observedSeconds < 1
      ? 'insufficient'
      : choppyRatio > PLAYBACK_RESOURCE_LIMITS.choppyRatio || this.stalledEvents >= 3
        ? 'choppy'
        : 'healthy'
    return {
      waitingEvents: this.waitingEvents,
      stalledEvents: this.stalledEvents,
      recoveries: this.recoveries,
      observedSeconds,
      bufferingSeconds,
      choppyRatio,
      status,
    }
  }
}
