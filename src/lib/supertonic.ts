import type { ProgressInfo } from './kokoro.ts'
import { CORE_SUPERTONIC_MODEL_REVISION } from './capabilities-core.ts'

export const SUPERTONIC_MODEL_ID = 'onnx-community/Supertonic-TTS-ONNX'
export const SUPERTONIC_MODEL_REVISION = CORE_SUPERTONIC_MODEL_REVISION
export const SUPERTONIC_SAMPLE_RATE = 44100
export const SUPERTONIC_DEFAULT_STEPS = 5

export type SupertonicVoiceId = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'M1' | 'M2' | 'M3' | 'M4' | 'M5'

export type SupertonicVoice = {
  id: SupertonicVoiceId
  name: string
  gender: 'Female' | 'Male'
}

export const SUPERTONIC_VOICES: SupertonicVoice[] = [
  { id: 'F1', name: 'F1', gender: 'Female' },
  { id: 'F2', name: 'F2', gender: 'Female' },
  { id: 'F3', name: 'F3', gender: 'Female' },
  { id: 'F4', name: 'F4', gender: 'Female' },
  { id: 'F5', name: 'F5', gender: 'Female' },
  { id: 'M1', name: 'M1', gender: 'Male' },
  { id: 'M2', name: 'M2', gender: 'Male' },
  { id: 'M3', name: 'M3', gender: 'Male' },
  { id: 'M4', name: 'M4', gender: 'Male' },
  { id: 'M5', name: 'M5', gender: 'Male' },
]

type SupertonicPipelineOutput = {
  audio?: Float32Array
  sampling_rate?: number
}

type SupertonicPipeline = (
  text: string,
  options: {
    speaker_embeddings: string
    num_inference_steps: number
    speed: number
  },
) => Promise<SupertonicPipelineOutput>

export type SupertonicSynthesizedAudio = {
  samples: Float32Array
  sampleRate: number
}

let supertonicPromise: Promise<SupertonicPipeline> | null = null

export function supertonicVoiceUrl(voiceId: SupertonicVoiceId): string {
  return `https://huggingface.co/${SUPERTONIC_MODEL_ID}/resolve/${SUPERTONIC_MODEL_REVISION}/voices/${voiceId}.bin`
}

export function clampSupertonicSpeed(speed: number): number {
  return Math.min(1.2, Math.max(0.8, speed))
}

export function clampSupertonicSteps(steps: number): number {
  return Math.min(10, Math.max(1, Math.round(steps)))
}

export async function loadSupertonic(onProgress: (info: ProgressInfo) => void): Promise<SupertonicPipeline> {
  if (supertonicPromise) return supertonicPromise

  const { pipeline } = await import('@huggingface/transformers')
  const createPipeline = pipeline as unknown as (
    task: 'text-to-speech',
    model: string,
    options: { progress_callback: (info: unknown) => void; revision: string },
  ) => Promise<SupertonicPipeline>
  supertonicPromise = createPipeline('text-to-speech', SUPERTONIC_MODEL_ID, {
    revision: SUPERTONIC_MODEL_REVISION,
    progress_callback: (info: unknown) => onProgress(info as ProgressInfo),
  })

  try {
    return await supertonicPromise
  } catch (err) {
    supertonicPromise = null
    throw err
  }
}

export async function synthesizeSupertonic(
  tts: SupertonicPipeline,
  text: string,
  voiceId: SupertonicVoiceId,
  speed: number,
  steps = SUPERTONIC_DEFAULT_STEPS,
): Promise<SupertonicSynthesizedAudio | null> {
  const audio = await tts(text, {
    speaker_embeddings: supertonicVoiceUrl(voiceId),
    num_inference_steps: clampSupertonicSteps(steps),
    speed: clampSupertonicSpeed(speed),
  })
  if (!audio.audio) return null
  return { samples: audio.audio, sampleRate: audio.sampling_rate ?? SUPERTONIC_SAMPLE_RATE }
}

export function resetSupertonicSession() {
  supertonicPromise = null
}
