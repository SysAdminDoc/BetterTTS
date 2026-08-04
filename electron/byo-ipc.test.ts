import { describe, expect, it } from 'vitest'
import { validateByoWeightsRequest } from './byo-ipc.ts'

describe('bring-your-own weights IPC', () => {
  it('accepts only a known model option', () => {
    expect(validateByoWeightsRequest({ modelId: 'f5-tts' })).toEqual({ modelId: 'f5-tts' })
    expect(validateByoWeightsRequest({ modelId: 'other' })).toEqual({ modelId: 'other' })
  })

  it('rejects malformed or unregistered requests', () => {
    expect(validateByoWeightsRequest(null)).toBeNull()
    expect(validateByoWeightsRequest({ modelId: 'qwen' })).toBeNull()
    expect(validateByoWeightsRequest({ modelId: '../weights' })).toBeNull()
    expect(validateByoWeightsRequest({})).toBeNull()
  })
})
