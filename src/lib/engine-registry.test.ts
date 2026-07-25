import { describe, expect, it } from 'vitest'
import {
  engineQueueable,
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
  })

  it('makes Piper-plus queueable when its platform flag exposes it', () => {
    expect(engineQueueable('kokoro')).toBe(true)
    expect(engineQueueable('supertonic')).toBe(true)
    expect(engineQueueable('kitten')).toBe(true)
    expect(engineQueueable('piper')).toBe(true)
    expect(engineQueueable('browser')).toBe(false)
  })
})
