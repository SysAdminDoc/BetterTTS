export type EngineId = 'kokoro' | 'supertonic' | 'kitten' | 'piper' | 'browser'

export type EngineDescriptor = {
  id: EngineId
  label: string
  queueable: boolean
  experimental: boolean
  firstLoad: 'default' | 'lazy'
}

export type EngineFlags = {
  piperPlus: boolean
}

export const EXPERIMENTAL_PIPER_STORAGE_KEY = 'bettertts-experimental-piper'

export const ENGINE_REGISTRY: EngineDescriptor[] = [
  { id: 'kokoro', label: 'Kokoro local', queueable: true, experimental: false, firstLoad: 'default' },
  { id: 'supertonic', label: 'Supertonic', queueable: true, experimental: false, firstLoad: 'lazy' },
  { id: 'kitten', label: 'KittenTTS', queueable: true, experimental: false, firstLoad: 'lazy' },
  { id: 'piper', label: 'Piper-plus', queueable: true, experimental: false, firstLoad: 'lazy' },
  { id: 'browser', label: 'Browser', queueable: false, experimental: false, firstLoad: 'default' },
]

export function visibleEngineDescriptors(flags: EngineFlags): EngineDescriptor[] {
  return ENGINE_REGISTRY.filter((engine) => engine.id !== 'piper' || flags.piperPlus)
}

export function engineQueueable(engineId: EngineId): boolean {
  return ENGINE_REGISTRY.find((engine) => engine.id === engineId)?.queueable === true
}
