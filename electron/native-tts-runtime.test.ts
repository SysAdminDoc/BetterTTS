import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NativeGenerationCoordinator,
  NativePcmBudget,
  startNativeGenerationWatchdog,
  validateNativePcm,
} from './native-tts-runtime.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('native TTS generation coordination', () => {
  it('owns one request, handles cancel-one/cancel-all, and permits retry after finish', () => {
    const coordinator = new NativeGenerationCoordinator()

    expect(coordinator.start(10)).toBe('started')
    expect(coordinator.start(11)).toBe('busy')
    expect(coordinator.cancel(10)).toBe(true)
    expect(coordinator.isCancelled(10)).toBe(true)
    expect(coordinator.cancelAll()).toBe(10)
    coordinator.finish(10)

    expect(coordinator.activeRequestId).toBeNull()
    expect(coordinator.start(11)).toBe('started')
    coordinator.finish(11)

    expect(coordinator.cancel(12)).toBe(false)
    expect(coordinator.start(12)).toBe('cancelled')
    expect(coordinator.start(12)).toBe('started')
  })
})

describe('native TTS PCM bounds', () => {
  it('accepts finite audio and rejects malformed or oversized output', () => {
    const samples = new Float32Array([0, 0.25, -0.5])
    expect(validateNativePcm(samples, 24_000)).toMatchObject({ samples, sampleRate: 24_000, bytes: 12 })
    expect(() => validateNativePcm(new Float32Array([Number.NaN]), 24_000)).toThrow(/invalid audio samples/)
    expect(() => validateNativePcm(samples, 0)).toThrow(/invalid sample rate/)
    expect(() => validateNativePcm(new Uint8Array([1]), 24_000)).toThrow(/no audio/)
  })

  it('accounts for reserved output bytes and releases them after transport', () => {
    const budget = new NativePcmBudget(16)
    budget.reserve(8)
    expect(budget.activeBytes).toBe(8)
    expect(() => budget.reserve(9)).toThrow(/memory limit/)
    budget.release(8)
    expect(budget.activeBytes).toBe(0)
    budget.reserve(16)
    budget.release(99)
    expect(budget.activeBytes).toBe(0)
  })
})

describe('native TTS watchdog', () => {
  it('fires once for a hung request and can be disarmed for a normal response', () => {
    vi.useFakeTimers()
    const timedOut = vi.fn()
    startNativeGenerationWatchdog(timedOut, 50)
    vi.advanceTimersByTime(50)
    vi.advanceTimersByTime(50)
    expect(timedOut).toHaveBeenCalledOnce()

    const cancelled = vi.fn()
    const disarm = startNativeGenerationWatchdog(cancelled, 50)
    disarm()
    vi.advanceTimersByTime(50)
    expect(cancelled).not.toHaveBeenCalled()
  })
})
