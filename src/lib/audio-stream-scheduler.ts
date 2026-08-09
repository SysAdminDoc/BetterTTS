import { PLAYBACK_RESOURCE_LIMITS, throwIfAborted } from './playback-resources.ts'

export type AudioStreamContext = Pick<AudioContext, 'currentTime' | 'destination' | 'createBuffer' | 'createBufferSource' | 'close'>

type StreamSource = Pick<AudioBufferSourceNode, 'connect' | 'start' | 'stop' | 'disconnect'> & {
  buffer: AudioBuffer | null
  onended: (() => void) | null
}

export class BoundedAudioStreamScheduler {
  private readonly context: AudioStreamContext
  private readonly sampleRate: number
  private readonly sources = new Set<StreamSource>()
  private readonly waiters = new Set<() => void>()
  private readonly signal?: AbortSignal
  private readonly onAbort = () => {
    void this.dispose('cancelled')
  }
  private nextStart: number
  private closed = false
  private closeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly maxAheadSeconds: number
  private readonly maxChunkSeconds: number

  constructor(
    context: AudioStreamContext,
    sampleRate: number,
    options: {
      maxAheadSeconds?: number
      maxChunkSeconds?: number
      leadInSeconds?: number
      signal?: AbortSignal
    } = {},
  ) {
    this.context = context
    this.sampleRate = sampleRate
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Audio stream sample rate must be positive.')
    this.maxAheadSeconds = Math.max(0.25, options.maxAheadSeconds ?? PLAYBACK_RESOURCE_LIMITS.maxStreamAheadSeconds)
    this.maxChunkSeconds = Math.max(0.05, options.maxChunkSeconds ?? PLAYBACK_RESOURCE_LIMITS.maxStreamChunkSeconds)
    this.signal = options.signal
    this.nextStart = context.currentTime + Math.max(0, options.leadInSeconds ?? 0.05)
    this.signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  async enqueue(samples: Float32Array): Promise<void> {
    throwIfAborted(this.signal)
    if (samples.length === 0) return
    const chunkSamples = Math.max(1, Math.floor(this.sampleRate * this.maxChunkSeconds))
    for (let offset = 0; offset < samples.length; offset += chunkSamples) {
      const end = Math.min(samples.length, offset + chunkSamples)
      const part = samples.subarray(offset, end)
      const duration = part.length / this.sampleRate
      await this.waitForRoom(duration)
      throwIfAborted(this.signal)
      if (this.closed) throw new Error('Audio playback resources have been released.')
      const buffer = this.context.createBuffer(1, part.length, this.sampleRate)
      buffer.getChannelData(0).set(part)
      const source = this.context.createBufferSource() as StreamSource
      source.buffer = buffer
      source.connect(this.context.destination)
      source.onended = () => {
        this.sources.delete(source)
        try {
          source.disconnect()
        } catch {
          // Already-disconnected sources are safe to ignore.
        }
        source.buffer = null
        this.notifyProgress()
      }
      this.sources.add(source)
      const start = Math.max(this.nextStart, this.context.currentTime)
      source.start(start)
      this.nextStart = start + duration
    }
  }

  get pendingSeconds(): number {
    return Math.max(0, this.nextStart - this.context.currentTime)
  }

  closeWhenDrained(graceMs = 200): void {
    if (this.closed || this.closeTimer !== null) return
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null
      void this.dispose('released')
    }, Math.max(0, Math.ceil(this.pendingSeconds * 1000) + graceMs))
  }

  async dispose(reason: 'released' | 'cancelled' | 'error' = 'released'): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.closeTimer !== null) clearTimeout(this.closeTimer)
    this.closeTimer = null
    this.signal?.removeEventListener('abort', this.onAbort)
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // A source that already ended cannot be stopped again.
      }
      try {
        source.disconnect()
      } catch {
        // Ignore already-disconnected sources.
      }
      source.buffer = null
    }
    this.sources.clear()
    const waiters = Array.from(this.waiters)
    this.waiters.clear()
    for (const notify of waiters) notify()
    await this.context.close().catch(() => undefined)
    void reason
  }

  private async waitForRoom(duration: number): Promise<void> {
    while (this.pendingSeconds + duration > this.maxAheadSeconds) {
      throwIfAborted(this.signal)
      if (this.closed) throw new Error('Audio playback resources have been released.')
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const cleanup = () => {
          if (timer !== null) clearTimeout(timer)
          timer = null
          this.waiters.delete(notify)
          this.signal?.removeEventListener('abort', onAbort)
        }
        const notify = () => {
          cleanup()
          resolve()
        }
        const onAbort = () => {
          cleanup()
          try {
            throwIfAborted(this.signal)
          } catch (error) {
            reject(error)
          }
        }
        timer = setTimeout(() => {
          cleanup()
          resolve()
        }, 25)
        this.waiters.add(notify)
        this.signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }

  private notifyProgress(): void {
    for (const notify of Array.from(this.waiters)) notify()
  }
}
