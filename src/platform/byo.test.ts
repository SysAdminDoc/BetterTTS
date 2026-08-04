// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { byoWeightsAvailable, chooseByoWeights } from './byo.ts'

afterEach(() => {
  delete window.betterttsPlatform
})

describe('bring-your-own weights platform bridge', () => {
  it('stays unavailable in the web build', async () => {
    expect(byoWeightsAvailable()).toBe(false)
    await expect(chooseByoWeights('f5-tts')).resolves.toEqual({ canceled: true })
  })

  it('delegates a desktop selection without downloading or copying files', async () => {
    const selected = { canceled: false, path: 'C:\\Models\\f5-tts', name: 'f5-tts', kind: 'directory' as const }
    window.betterttsPlatform = {
      isDesktop: true,
      kind: 'desktop',
      versions: { electron: '43', chrome: '134', node: '22' },
      byoWeights: { choose: async (modelId) => modelId === 'f5-tts' ? selected : { canceled: true } },
    }
    expect(byoWeightsAvailable()).toBe(true)
    await expect(chooseByoWeights('f5-tts')).resolves.toEqual(selected)
  })
})
