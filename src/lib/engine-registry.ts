export type EngineId = 'kokoro' | 'supertonic' | 'kitten' | 'chatterbox' | 'piper' | 'browser'

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
}

export const EXPERIMENTAL_PIPER_STORAGE_KEY = 'bettertts-experimental-piper'
export const EXPERIMENTAL_CHATTERBOX_STORAGE_KEY = 'bettertts-chatterbox-consent'

export const ENGINE_REGISTRY: EngineDescriptor[] = [
  { id: 'kokoro', label: 'Kokoro local', queueable: true, experimental: false, firstLoad: 'default' },
  { id: 'supertonic', label: 'Supertonic', queueable: true, experimental: false, firstLoad: 'lazy' },
  { id: 'kitten', label: 'KittenTTS', queueable: true, experimental: false, firstLoad: 'lazy' },
  { id: 'chatterbox', label: 'Chatterbox', queueable: false, experimental: true, firstLoad: 'lazy' },
  { id: 'piper', label: 'Piper-plus', queueable: true, experimental: false, firstLoad: 'lazy' },
  { id: 'browser', label: 'Browser', queueable: false, experimental: false, firstLoad: 'default' },
]

export function visibleEngineDescriptors(flags: EngineFlags): EngineDescriptor[] {
  return ENGINE_REGISTRY.filter((engine) =>
    (engine.id !== 'piper' || flags.piperPlus)
    && (engine.id !== 'chatterbox' || flags.chatterbox === true),
  )
}

export function engineQueueable(engineId: EngineId): boolean {
  return ENGINE_REGISTRY.find((engine) => engine.id === engineId)?.queueable === true
}
