import { describe, expect, it } from 'vitest'
import { validateNativeTtsRequest } from './native-ipc.ts'

describe('native TTS IPC validation', () => {
  it('accepts the bounded renderer protocol', () => {
    expect(validateNativeTtsRequest({ type: 'load', dtype: 'q8' })).toEqual({ type: 'load', dtype: 'q8' })
    expect(validateNativeTtsRequest({ type: 'generate', text: 'Hello', voice: 'af_heart', speed: 1, id: 7 }))
      .toEqual({ type: 'generate', text: 'Hello', voice: 'af_heart', speed: 1, id: 7 })
    expect(validateNativeTtsRequest({ type: 'cancel', id: 7 })).toEqual({ type: 'cancel', id: 7 })
  })

  it('rejects unknown, oversized, and non-finite host payloads', () => {
    expect(validateNativeTtsRequest({ type: 'load', dtype: 'fp32' })).toBeNull()
    expect(validateNativeTtsRequest({ type: 'generate', text: 'x'.repeat(10_001), voice: 'af_heart', speed: 1, id: 1 })).toBeNull()
    expect(validateNativeTtsRequest({ type: 'generate', text: 'Hello', voice: 'af_heart', speed: Number.POSITIVE_INFINITY, id: 1 })).toBeNull()
    expect(validateNativeTtsRequest({ type: 'generate', text: 'Hello', voice: 'af_heart', speed: 1, id: -1 })).toBeNull()
    expect(validateNativeTtsRequest({ type: 'erase-cache' })).toBeNull()
  })
})
