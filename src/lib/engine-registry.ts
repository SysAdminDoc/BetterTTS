import type { ByoModelOptionId } from './byo-models.ts'

export type EngineId = 'kokoro' | 'supertonic' | 'kitten' | 'chatterbox' | 'piper' | 'qwen' | 'browser'

export type PostStageId = 'rvc'

export type PostStageDescriptor = {
  id: PostStageId
  label: string
  desktopOnly: boolean
  consentRequired: boolean
}

export const POST_STAGE_REGISTRY: PostStageDescriptor[] = [
  { id: 'rvc', label: 'RVC voice conversion', desktopOnly: true, consentRequired: true },
]

export type EngineDescriptor = {
  id: EngineId
  label: string
  queueable: boolean
  experimental: boolean
  firstLoad: 'default' | 'lazy'
}

export type EngineFlags = {
  piperPlus: boolean
  chatterbox?: boolean
  qwen?: boolean
}

export const EXPERIMENTAL_PIPER_STORAGE_KEY = 'bettertts-experimental-piper'
export const EXPERIMENTAL_CHATTERBOX_STORAGE_KEY = 'bettertts-chatterbox-consent'

export const ENGINE_REGISTRY: EngineDescriptor[] = [
  { id: 'kokoro', label: 'Kokoro local', queueable: true, experimental: false, firstLoad: 'default' },
  { id: 'supertonic', label: 'Supertonic', queueable: true, experimental: false, firstLoad: 'lazy' },
  { id: 'kitten', label: 'KittenTTS', queueable: true, experimental: false, firstLoad: 'lazy' },
  { id: 'chatterbox', label: 'Chatterbox', queueable: false, experimental: true, firstLoad: 'lazy' },
  { id: 'piper', label: 'Piper-plus', queueable: true, experimental: false, firstLoad: 'lazy' },
  { id: 'qwen', label: 'Qwen3-TTS', queueable: false, experimental: true, firstLoad: 'lazy' },
  { id: 'browser', label: 'Browser', queueable: false, experimental: false, firstLoad: 'default' },
]

export function visibleEngineDescriptors(flags: EngineFlags): EngineDescriptor[] {
  return ENGINE_REGISTRY.filter((engine) =>
    (engine.id !== 'piper' || flags.piperPlus)
    && (engine.id !== 'chatterbox' || flags.chatterbox === true)
    && (engine.id !== 'qwen' || flags.qwen === true),
  )
}

export function engineQueueable(engineId: EngineId): boolean {
  return ENGINE_REGISTRY.find((engine) => engine.id === engineId)?.queueable === true
}

export function engineSupportsPostStage(engineId: EngineId, stage: PostStageId): boolean {
  return stage === 'rvc' && engineId !== 'browser'
}

/** Restricted engines are cataloged only after the user has acknowledged the
 * license gate and registered a local weight location. */
export function visibleUserSuppliedEngines(consent: boolean, modelIds: readonly ByoModelOptionId[]): ByoModelOptionId[] {
  return consent ? [...new Set(modelIds)] : []
}
