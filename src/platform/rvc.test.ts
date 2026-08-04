// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RvcBridge, RvcWeightsBridge } from './index.ts'
import type { RvcInferencePlan } from '../lib/rvc.ts'

type FakeBridge = RvcBridge & {
  sent: unknown[]
  emit: (message: unknown) => void
}

function installFakeBridge(): FakeBridge {
  const listeners: Array<(message: unknown) => void> = []
  const bridge: FakeBridge = {
    sent: [],
    post(message: unknown) { bridge.sent.push(message) },
    onMessage(listener: (message: unknown) => void) {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    emit(message: unknown) {
      for (const listener of [...listeners]) listener(message)
    },
  }
  const weights: RvcWeightsBridge = {
    chooseModel: async () => ({ canceled: false, path: 'C:\\Models\\voice.pth', name: 'voice.pth' }),
    chooseIndex: async () => ({ canceled: false, path: 'C:\\Models\\voice.index', name: 'voice.index' }),
  }
  ;(window as unknown as { betterttsPlatform?: unknown }).betterttsPlatform = {
    isDesktop: true,
    kind: 'desktop',
    versions: { electron: '43.0.0', chrome: '150.0.0', node: '24.0.0' },
    rvc: bridge,
    rvcWeights: weights,
  }
  return bridge
}

const plan = {
  primary: {
    id: 'a', modelName: 'A', modelPath: 'C:\\Models\\a.pth', license: 'MIT', provenance: 'Local', acknowledgedAt: '2026-08-03T12:00:00.000Z', addedAt: '2026-08-03T12:00:00.000Z',
  },
  blendRatio: 0.5,
  pitchSemitones: 0,
  indexRate: 0.5,
} satisfies RvcInferencePlan

async function loadModule() {
  vi.resetModules()
  return import('./rvc.ts')
}

beforeEach(() => {
  delete (window as unknown as { betterttsPlatform?: unknown }).betterttsPlatform
})
describe('RVC desktop bridge client', () => {
  it('reports web mode unavailable and returns canceled picker results', async () => {
    const mod = await loadModule()
    expect(mod.rvcAvailable()).toBe(false)
    await expect(mod.getRvcRuntimeStatus()).resolves.toMatchObject({ available: false })
    await expect(mod.chooseRvcModel()).resolves.toEqual({ canceled: true })
  })

  it('routes status, conversion progress, and generated PCM', async () => {
    const bridge = installFakeBridge()
    const mod = await loadModule()
    const statusPromise = mod.getRvcRuntimeStatus()
    expect(bridge.sent).toEqual([{ type: 'status', id: 0 }])
    bridge.emit({ type: 'status', id: 0, status: { available: true, rvcInstalled: true, torchInstalled: true, message: 'ready', recovery: 'local' } })
    await expect(statusPromise).resolves.toMatchObject({ available: true })

    const progress: Array<[number, string]> = []
    const generation = mod.convertRvcAudio(new Float32Array([0.1, -0.2]), 24_000, plan, undefined, (value, stage) => progress.push([value, stage]))
    expect(bridge.sent).toContainEqual(expect.objectContaining({ type: 'convert', modelPath: plan.primary.modelPath }))
    bridge.emit({ type: 'progress', id: 1, progress: 0.6, stage: 'Converting' })
    const samples = new Float32Array([0.2, -0.1])
    bridge.emit({ type: 'generated', id: 1, samples, sampleRate: 24_000 })
    await expect(generation).resolves.toEqual({ samples, sampleRate: 24_000 })
    expect(progress).toEqual([[0.6, 'Converting']])
  })

  it('cancels an in-flight conversion and rejects pending work after a crash', async () => {
    const bridge = installFakeBridge()
    const mod = await loadModule()
    const controller = new AbortController()
    const generation = mod.convertRvcAudio(new Float32Array([0.1]), 24_000, plan, controller.signal)
    controller.abort()
    await expect(generation).rejects.toMatchObject({ name: 'AbortError' })
    expect(bridge.sent).toContainEqual(expect.objectContaining({ type: 'cancel' }))

    const pending = mod.convertRvcAudio(new Float32Array([0.1]), 24_000, plan)
    bridge.emit({ type: 'crashed', message: 'RVC host stopped' })
    await expect(pending).rejects.toThrow('RVC host stopped')
  })
})
