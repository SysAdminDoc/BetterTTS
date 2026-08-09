import { describe, expect, it } from 'vitest'
import { BoundedAudioStreamScheduler } from './audio-stream-scheduler.ts'
import {
  BoundedPlaybackResourcePool,
  PlaybackChoppinessTracker,
  PLAYBACK_RESOURCE_LIMITS,
  waitForEncoderCapacity,
  withAbort,
} from './playback-resources.ts'

class FakeBuffer {
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number
  readonly duration: number
  private readonly samples: Float32Array

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels
    this.length = length
    this.sampleRate = sampleRate
    this.duration = length / sampleRate
    this.samples = new Float32Array(length)
  }

  getChannelData(): Float32Array {
    return this.samples
  }
}

class FakeSource {
  buffer: FakeBuffer | null = null
  onended: (() => void) | null = null
  startAt = 0
  stopped = false

  private readonly context: FakeContext

  constructor(context: FakeContext) {
    this.context = context
  }

  connect(): void {}

  disconnect(): void {}

  start(when: number): void {
    this.startAt = when
    this.context.sources.push(this)
  }

  stop(): void {
    this.stopped = true
  }
}

class FakeContext {
  currentTime = 0
  readonly destination = {}
  readonly sources: FakeSource[] = []
  closed = false

  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(1, length, sampleRate)
  }

  createBufferSource(): FakeSource {
    return new FakeSource(this)
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }

  advance(seconds: number): void {
    this.currentTime += seconds
    for (const source of this.sources.splice(0)) {
      if (!source.stopped && source.startAt + (source.buffer?.duration ?? 0) <= this.currentTime) source.onended?.()
      else this.sources.push(source)
    }
  }
}

describe('bounded playback resources', () => {
  it('evicts the least-recently-used unpinned resource and releases it once', () => {
    const pool = new BoundedPlaybackResourcePool(2)
    const released: string[] = []
    const first = pool.acquire('first', (reason) => released.push(`first:${reason}`))!
    const second = pool.acquire('second', (reason) => released.push(`second:${reason}`), () => true)!
    const third = pool.acquire('third', (reason) => released.push(`third:${reason}`))!

    expect(first.key).toBe('first')
    expect(second.key).toBe('second')
    expect(third.key).toBe('third')
    expect(pool.size).toBe(2)
    expect(released).toEqual(['first:evicted'])

    third.release()
    third.release('error')
    expect(released).toEqual(['first:evicted', 'third:released'])
  })

  it('refuses a new resource when every retained resource is pinned', () => {
    const pool = new BoundedPlaybackResourcePool(1)
    pool.acquire('active', () => {}, () => true)
    expect(pool.acquire('next', () => {})).toBeNull()
    expect(pool.size).toBe(1)
  })

  it('keeps streaming buffers bounded and applies backpressure until audio advances', async () => {
    const context = new FakeContext()
    const scheduler = new BoundedAudioStreamScheduler(context as never, 10, {
      maxAheadSeconds: 2,
      maxChunkSeconds: 1,
      leadInSeconds: 0,
    })
    const pending = scheduler.enqueue(new Float32Array(25))
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(context.sources).toHaveLength(2)
    expect(context.sources.every((source) => (source.buffer?.length ?? 0) <= 10)).toBe(true)
    let settled = false
    void pending.then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(settled).toBe(false)

    context.advance(1.1)
    await new Promise((resolve) => setTimeout(resolve, 35))
    expect(context.sources.length).toBeGreaterThanOrEqual(1)
    await pending
    expect(scheduler.pendingSeconds).toBeGreaterThan(0)
    await scheduler.dispose()
    expect(context.closed).toBe(true)
  })

  it('cancels a backpressured stream and closes its audio context', async () => {
    const context = new FakeContext()
    const controller = new AbortController()
    const scheduler = new BoundedAudioStreamScheduler(context as never, 10, {
      maxAheadSeconds: 1,
      maxChunkSeconds: 1,
      signal: controller.signal,
    })
    const pending = scheduler.enqueue(new Float32Array(30))
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(context.closed).toBe(true)
  })

  it('reports buffering ratio and distinguishes a choppy long session', () => {
    const tracker = new PlaybackChoppinessTracker()
    tracker.start(0)
    tracker.recordWaiting(1000)
    tracker.recordPlaying(4000)
    tracker.recordStalled(6000)
    const snapshot = tracker.finish(10_000)

    expect(snapshot.waitingEvents).toBe(1)
    expect(snapshot.stalledEvents).toBe(1)
    expect(snapshot.recoveries).toBe(1)
    expect(snapshot.bufferingSeconds).toBe(7)
    expect(snapshot.choppyRatio).toBeCloseTo(0.7)
    expect(snapshot.status).toBe('choppy')
    expect(PLAYBACK_RESOURCE_LIMITS.maxStreamAheadSeconds).toBe(8)
  })

  it('turns an abort into a deterministic AbortError while cleaning the listener', async () => {
    const controller = new AbortController()
    const pending = withAbort(new Promise<void>(() => {}), controller.signal, 'test cancelled')
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'test cancelled' })
  })

  it('waits for an encoder queue to drain before admitting more frames', async () => {
    const encoder = { encodeQueueSize: 6 }
    const pending = waitForEncoderCapacity(encoder)
    setTimeout(() => { encoder.encodeQueueSize = 0 }, 12)
    await pending
    expect(encoder.encodeQueueSize).toBe(0)
  })
})
