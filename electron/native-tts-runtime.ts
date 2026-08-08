/** Runtime guards shared by the native TTS host and its Electron supervisor. */

export const NATIVE_GENERATION_WATCHDOG_MS = 120_000
export const NATIVE_CANCEL_GRACE_MS = 1_000
export const MAX_NATIVE_PCM_BYTES = 512 * 1024 * 1024
export const MAX_NATIVE_PCM_SAMPLES = MAX_NATIVE_PCM_BYTES / Float32Array.BYTES_PER_ELEMENT

export function startNativeGenerationWatchdog(onTimeout: () => void, timeoutMs = NATIVE_GENERATION_WATCHDOG_MS): () => void {
  let active = true
  const timer = setTimeout(() => {
    if (!active) return
    active = false
    onTimeout()
  }, timeoutMs)
  return () => {
    active = false
    clearTimeout(timer)
  }
}

export type NativeGenerationStart = 'started' | 'cancelled' | 'busy'

/** One native host owns at most one inference request at a time. */
export class NativeGenerationCoordinator {
  private activeId: number | null = null
  private readonly cancelledIds = new Set<number>()

  start(id: number): NativeGenerationStart {
    if (this.cancelledIds.delete(id)) return 'cancelled'
    if (this.activeId !== null) return 'busy'
    this.activeId = id
    return 'started'
  }

  cancel(id: number): boolean {
    this.cancelledIds.add(id)
    return this.activeId === id
  }

  cancelAll(): number | null {
    if (this.activeId !== null) this.cancelledIds.add(this.activeId)
    return this.activeId
  }

  isCancelled(id: number): boolean {
    return this.cancelledIds.has(id)
  }

  finish(id: number): void {
    this.cancelledIds.delete(id)
    if (this.activeId === id) this.activeId = null
  }

  get activeRequestId(): number | null {
    return this.activeId
  }
}

export class NativePcmBudget {
  private reservedBytes = 0

  constructor(readonly maxBytes = MAX_NATIVE_PCM_BYTES) {}

  reserve(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Native PCM allocation is invalid.')
    if (this.reservedBytes + bytes > this.maxBytes) {
      throw new Error(`Native PCM output exceeds the ${Math.round(this.maxBytes / 1024 / 1024)} MiB memory limit.`)
    }
    this.reservedBytes += bytes
  }

  release(bytes: number): void {
    this.reservedBytes = Math.max(0, this.reservedBytes - Math.max(0, bytes))
  }

  get activeBytes(): number {
    return this.reservedBytes
  }
}

export function validateNativePcm(samples: unknown, sampleRate: unknown): { samples: Float32Array; sampleRate: number; bytes: number } {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new Error('Native inference produced no audio.')
  }
  if (samples.length > MAX_NATIVE_PCM_SAMPLES || samples.byteLength > MAX_NATIVE_PCM_BYTES) {
    throw new Error(`Native PCM output exceeds the ${Math.round(MAX_NATIVE_PCM_BYTES / 1024 / 1024)} MiB memory limit.`)
  }
  if (!Number.isFinite(sampleRate) || Number(sampleRate) <= 0 || Number(sampleRate) > 192_000) {
    throw new Error('Native inference returned an invalid sample rate.')
  }
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error('Native inference returned invalid audio samples.')
  }
  return { samples, sampleRate: Number(sampleRate), bytes: samples.byteLength }
}
