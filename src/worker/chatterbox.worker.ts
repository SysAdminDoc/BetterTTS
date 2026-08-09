import type { ProgressInfo } from '../lib/kokoro.ts'
import {
  CHATTERBOX_DEFAULT_EXAGGERATION,
  CHATTERBOX_MAX_NEW_TOKENS,
  chatterboxModelId,
  type ChatterboxModelVariant,
} from '../lib/chatterbox-config.ts'
import { capabilityModel } from '../lib/capabilities.ts'
import {
  chatterboxVoiceLabModel,
  createVoiceProvenance,
  type VoiceProvenance,
} from '../lib/voice-lab.ts'

export type ChatterboxWorkerRequest =
  | { type: 'load'; model: ChatterboxModelVariant; device: 'webgpu' | 'wasm' }
  | {
      type: 'generate'
      id: number
      text: string
      exaggeration: number
      maxNewTokens: number
      provenance: [referenceId: string, referenceName: string, referenceDurationSeconds: number, acknowledgedAt?: string]
      referenceAudio?: Float32Array
    }
  | { type: 'cancel'; id: number }

export type ChatterboxWorkerResponse =
  | { type: 'progress'; info: ProgressInfo }
  | { type: 'loaded'; key: string }
  | { type: 'loadError'; key: string; message: string }
  | { type: 'generated'; id: number; samples: Float32Array; provenance: VoiceProvenance }
  | { type: 'generateError'; id: number; message: string }
  | { type: 'cancelled'; id: number }

type ChatterboxProcessorLike = {
  (text: string, audio?: Float32Array): Promise<Record<string, unknown>>
}

type ChatterboxModelLike = {
  encode_speech(audioValues: unknown): Promise<Record<string, unknown>>
  generate(params: Record<string, unknown>): Promise<unknown>
}

let processor: ChatterboxProcessorLike | null = null
let model: ChatterboxModelLike | null = null
let loadedKey = ''
let loadedModel: ChatterboxModelVariant | null = null
const cancelledIds = new Set<number>()
const speakerCache = new Map<string, Record<string, unknown>>()

function chatterboxModelRevision(variant: ChatterboxModelVariant): string {
  const modelId = variant === 'multilingual' ? 'chatterbox-multilingual' : 'chatterbox'
  const revision = capabilityModel(modelId)?.revision
  if (!revision) throw new Error(`Missing pinned Chatterbox revision for ${modelId}.`)
  return revision
}

function outputSamples(output: unknown): Float32Array | null {
  if (!output || typeof output !== 'object' || !('data' in output)) return null
  const data = (output as { data: unknown }).data
  if (data instanceof Float32Array) return data
  if (data instanceof Float64Array) return Float32Array.from(data)
  if (Array.isArray(data)) return Float32Array.from(data)
  return null
}

function cacheSpeaker(referenceId: string, speaker: Record<string, unknown>) {
  speakerCache.delete(referenceId)
  speakerCache.set(referenceId, speaker)
  while (speakerCache.size > 2) speakerCache.delete(speakerCache.keys().next().value as string)
}

self.addEventListener('message', async (event: MessageEvent<ChatterboxWorkerRequest>) => {
  const message = event.data
  if (message.type === 'cancel') {
    cancelledIds.add(message.id)
    return
  }

  if (message.type === 'load') {
    const key = `${chatterboxModelId(message.model)}:${message.device}`
    if (model && processor && loadedKey === key) {
      self.postMessage({ type: 'loaded', key } satisfies ChatterboxWorkerResponse)
      return
    }
    try {
      const { ChatterboxModel, ChatterboxProcessor } = await import('@huggingface/transformers')
      processor = (await ChatterboxProcessor.from_pretrained(chatterboxModelId(message.model), {
        revision: chatterboxModelRevision(message.model),
        progress_callback: (info: unknown) => self.postMessage({ type: 'progress', info: info as ProgressInfo } satisfies ChatterboxWorkerResponse),
      })) as unknown as ChatterboxProcessorLike
      model = (await ChatterboxModel.from_pretrained(chatterboxModelId(message.model), {
        revision: chatterboxModelRevision(message.model),
        device: message.device,
        dtype: {
          embed_tokens: 'fp32',
          speech_encoder: 'fp32',
          language_model: 'q4',
          conditional_decoder: 'fp32',
        },
        progress_callback: (info: unknown) => self.postMessage({ type: 'progress', info: info as ProgressInfo } satisfies ChatterboxWorkerResponse),
      })) as unknown as ChatterboxModelLike
      loadedKey = key
      loadedModel = message.model
      speakerCache.clear()
      self.postMessage({ type: 'loaded', key } satisfies ChatterboxWorkerResponse)
    } catch (error) {
      processor = null
      model = null
      loadedKey = ''
      self.postMessage({
        type: 'loadError',
        key,
        message: error instanceof Error ? error.message : 'Chatterbox model load failed.',
      } satisfies ChatterboxWorkerResponse)
    }
    return
  }

  if (message.type !== 'generate') return
  if (cancelledIds.delete(message.id)) {
    self.postMessage({ type: 'cancelled', id: message.id } satisfies ChatterboxWorkerResponse)
    return
  }
  if (!processor || !model) {
    self.postMessage({ type: 'generateError', id: message.id, message: 'Chatterbox model is not loaded.' } satisfies ChatterboxWorkerResponse)
    return
  }

  try {
    const [referenceId, referenceName, referenceDurationSeconds, at] = message.provenance
    if (!loadedModel) throw new Error('Chatterbox model is not loaded.')
    const cachedSpeaker = speakerCache.get(referenceId)
    const inputs = await processor(message.text, cachedSpeaker ? undefined : message.referenceAudio)
    let speakerData = cachedSpeaker
    if (!speakerData) {
      if (!message.referenceAudio) throw new Error('Reference audio is required for the first Chatterbox sentence.')
      speakerData = await model.encode_speech(inputs.input_values)
      cacheSpeaker(referenceId, speakerData)
    }
    if (cancelledIds.delete(message.id)) {
      self.postMessage({ type: 'cancelled', id: message.id } satisfies ChatterboxWorkerResponse)
      return
    }

    const output = await model.generate({
      ...speakerData,
      input_ids: inputs.input_ids,
      attention_mask: inputs.attention_mask,
      exaggeration: message.exaggeration ?? CHATTERBOX_DEFAULT_EXAGGERATION,
      max_new_tokens: message.maxNewTokens ?? CHATTERBOX_MAX_NEW_TOKENS,
      repetition_penalty: 1.2,
      do_sample: true,
      temperature: 0.2,
    })
    if (cancelledIds.delete(message.id)) {
      self.postMessage({ type: 'cancelled', id: message.id } satisfies ChatterboxWorkerResponse)
      return
    }
    const samples = outputSamples(output)
    if (!samples || samples.length === 0) throw new Error('Chatterbox produced no audio.')
    const provenance = createVoiceProvenance({
      referenceId,
      referenceName,
      referenceDurationSeconds,
      acknowledgedAt: at,
      model: chatterboxVoiceLabModel(loadedModel),
    })
    self.postMessage({ type: 'generated', id: message.id, samples, provenance } satisfies ChatterboxWorkerResponse, {
      transfer: [samples.buffer as ArrayBuffer],
    })
  } catch (error) {
    if (cancelledIds.delete(message.id)) {
      self.postMessage({ type: 'cancelled', id: message.id } satisfies ChatterboxWorkerResponse)
    } else {
      self.postMessage({
        type: 'generateError',
        id: message.id,
        message: error instanceof Error ? error.message : 'Chatterbox generation failed.',
      } satisfies ChatterboxWorkerResponse)
    }
  }
})
