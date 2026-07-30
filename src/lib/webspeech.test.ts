// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { speakBrowser } from './webspeech.ts'

class FakeUtterance {
  rate = 1
  voice: SpeechSynthesisVoice | null = null
  onend: (() => void) | null = null
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null
  readonly text: string

  constructor(text: string) {
    this.text = text
  }
}

describe('browser speech playback', () => {
  const cancel = vi.fn()
  const removeEventListener = vi.fn()
  const addEventListener = vi.fn()
  const getVoices = vi.fn(() => [{ lang: 'en-US' }] as SpeechSynthesisVoice[])

  beforeEach(() => {
    vi.useFakeTimers()
    cancel.mockReset()
    removeEventListener.mockReset()
    addEventListener.mockReset()
    getVoices.mockClear()
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('rejects stalled playback instead of silently skipping text', async () => {
    const speak = vi.fn()
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { cancel, speak, getVoices, addEventListener, removeEventListener },
    })

    const pending = speakBrowser('This sentence never finishes.', 1)
    const rejection = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10_000)

    await rejection
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it('surfaces synchronous browser failures and clears the watchdog', async () => {
    const speak = vi.fn(() => {
      throw new Error('speech service unavailable')
    })
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { cancel, speak, getVoices, addEventListener, removeEventListener },
    })

    await expect(speakBrowser('Hello.', 1)).rejects.toThrow('speech service unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })
})
