import { encodeWav } from './wav.ts'
import type { LongFormQualityOptions } from './long-form-quality.ts'
import type { WhisperLanguage } from './whisper.ts'
import { transcribeWhisper } from '../platform/whisper.ts'

export async function createLongFormQualityGate(
  enabled: boolean,
  whisperAvailable: boolean,
  whisperLanguage: WhisperLanguage,
  onProgress: (message: string) => void,
): Promise<LongFormQualityOptions | undefined> {
  if (!enabled) return undefined
  const transcribe = whisperAvailable
    ? async (samples: Float32Array, sampleRate: number, signal?: AbortSignal) => {
      const alignment = await transcribeWhisper(
        new Uint8Array(encodeWav(samples, sampleRate)),
        whisperLanguage,
        (progress) => onProgress(`Verifying local audio (${Math.round(progress)}%)`),
        signal,
      )
      return {
        text: alignment.words.map((word) => word.text).join(' '),
        cues: alignment.words.map((word) => ({ startSec: word.startSec, endSec: word.endSec, text: word.text })),
      }
    }
    : undefined
  return {
    enabled: true,
    maxRetries: 1,
    transcriptionScope: 'job',
    ...(transcribe ? { transcribe } : {}),
  }
}
