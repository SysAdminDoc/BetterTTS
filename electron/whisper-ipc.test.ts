import { describe, expect, it } from 'vitest'
import { MAX_WHISPER_AUDIO_BYTES } from '../src/lib/whisper.ts'
import { validateWhisperRequest } from './whisper-ipc.ts'

describe('whisper caption IPC validation', () => {
  it('accepts bounded status, transcription, and cancellation requests', () => {
    expect(validateWhisperRequest({ type: 'status', id: 1 })).toEqual({ type: 'status', id: 1 })
    expect(validateWhisperRequest({ type: 'transcribe', id: 2, language: 'ES', audio: new Uint8Array([1, 2, 3]) }))
      .toMatchObject({ type: 'transcribe', id: 2, language: 'es' })
    expect(validateWhisperRequest({ type: 'cancel', id: 2 })).toEqual({ type: 'cancel', id: 2 })
  })

  it('rejects malformed, unknown-language, and oversized payloads', () => {
    expect(validateWhisperRequest({ type: 'status', id: -1 })).toBeNull()
    expect(validateWhisperRequest({ type: 'transcribe', id: 1, language: 'not a language', audio: new Uint8Array([1]) })).toBeNull()
    expect(validateWhisperRequest({ type: 'transcribe', id: 1, language: 'en', audio: new Uint8Array(MAX_WHISPER_AUDIO_BYTES + 1) })).toBeNull()
    expect(validateWhisperRequest({ type: 'transcribe', id: 1, language: 'en', audio: [1, 2, 3] })).toBeNull()
  })
})
