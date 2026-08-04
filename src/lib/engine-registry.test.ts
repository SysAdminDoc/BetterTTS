import { describe, expect, it } from 'vitest'
import {
  engineQueueable,
  engineSupportsPostStage,
  visibleUserSuppliedEngines,
  visibleEngineDescriptors,
} from './engine-registry.ts'

describe('engine registry', () => {
  it('hides Piper-plus until the experimental flag is enabled', () => {
    expect(visibleEngineDescriptors({ piperPlus: false }).map((engine) => engine.id)).toEqual([
      'kokoro',
      'supertonic',
      'kitten',
      'browser',
    ])

    expect(visibleEngineDescriptors({ piperPlus: true }).map((engine) => engine.id)).toContain('piper')
    expect(visibleEngineDescriptors({ piperPlus: true, chatterbox: true }).map((engine) => engine.id)).toContain('chatterbox')
    expect(visibleEngineDescriptors({ piperPlus: true, qwen: true }).map((engine) => engine.id)).toContain('qwen')
    expect(visibleEngineDescriptors({ piperPlus: false, melo: true }).map((engine) => engine.id)).toContain('melo')
  })

  it('makes Piper-plus queueable when its platform flag exposes it', () => {
    expect(engineQueueable('kokoro')).toBe(true)
    expect(engineQueueable('supertonic')).toBe(true)
    expect(engineQueueable('kitten')).toBe(true)
    expect(engineQueueable('piper')).toBe(true)
    expect(engineQueueable('melo')).toBe(true)
    expect(engineQueueable('chatterbox')).toBe(false)
    expect(engineQueueable('browser')).toBe(false)
  })

  it('keeps registered non-commercial engines hidden until consent', () => {
    expect(visibleUserSuppliedEngines(false, ['f5-tts', 'xtts-v2'])).toEqual([])
    expect(visibleUserSuppliedEngines(true, ['f5-tts', 'f5-tts', 'xtts-v2'])).toEqual(['f5-tts', 'xtts-v2'])
  })

  it('allows RVC after native audio generation, never browser playback', () => {
    expect(engineSupportsPostStage('kokoro', 'rvc')).toBe(true)
    expect(engineSupportsPostStage('qwen', 'rvc')).toBe(true)
    expect(engineSupportsPostStage('browser', 'rvc')).toBe(false)
  })
})
