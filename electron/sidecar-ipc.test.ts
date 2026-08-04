import { describe, expect, it } from 'vitest'
import { validateSidecarRequest } from './sidecar-ipc.ts'

describe('Qwen3-TTS sidecar IPC validation', () => {
  it('accepts bounded status, setup, synthesis, and cancellation requests', () => {
    expect(validateSidecarRequest({ type: 'status', id: 1 })).toEqual({ type: 'status', id: 1 })
    expect(validateSidecarRequest({ type: 'setup', id: 2 })).toEqual({ type: 'setup', id: 2 })
    expect(validateSidecarRequest({
      type: 'synthesize',
      id: 3,
      text: 'Hello from Qwen.',
      language: 'English',
      speaker: 'Vivian',
      instruct: 'Warm and clear.',
      speed: 1,
    })).toMatchObject({ type: 'synthesize', language: 'English', speaker: 'Vivian' })
    expect(validateSidecarRequest({ type: 'cancel', id: 3 })).toEqual({ type: 'cancel', id: 3 })
  })

  it('rejects oversized, unsupported, and malformed requests', () => {
    expect(validateSidecarRequest({ type: 'status', id: -1 })).toBeNull()
    expect(validateSidecarRequest({ type: 'synthesize', id: 1, text: 'hi', language: 'Latin', speaker: 'Vivian', speed: 1 })).toBeNull()
    expect(validateSidecarRequest({ type: 'synthesize', id: 1, text: 'hi', language: 'English', speaker: 'Vivian', speed: 2 })).toBeNull()
    expect(validateSidecarRequest({ type: 'synthesize', id: 1, text: 'x'.repeat(5_001), language: 'English', speaker: 'Vivian', speed: 1 })).toBeNull()
  })
})
