import { describe, expect, it } from 'vitest'
import { validateOpenAiTtsRequest } from './openai-ipc.ts'

describe('OpenAI TTS IPC validation', () => {
  it('accepts status, bounded start ports, and stop', () => {
    expect(validateOpenAiTtsRequest({ action: 'status' })).toEqual({ action: 'status' })
    expect(validateOpenAiTtsRequest({ action: 'start', port: 8765 })).toEqual({ action: 'start', port: 8765 })
    expect(validateOpenAiTtsRequest({ action: 'start', port: 0 })).toEqual({ action: 'start', port: 0 })
    expect(validateOpenAiTtsRequest({ action: 'stop' })).toEqual({ action: 'stop' })
  })

  it('rejects malformed actions and unsafe ports', () => {
    expect(validateOpenAiTtsRequest({ action: 'start', port: -1 })).toBeNull()
    expect(validateOpenAiTtsRequest({ action: 'start', port: 65_536 })).toBeNull()
    expect(validateOpenAiTtsRequest({ action: 'start', port: 8765.5 })).toBeNull()
    expect(validateOpenAiTtsRequest({ action: 'erase' })).toBeNull()
    expect(validateOpenAiTtsRequest(null)).toBeNull()
  })
})
