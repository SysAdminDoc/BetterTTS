// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidecarBridge } from './index.ts'

type FakeBridge = SidecarBridge & {
  sent: unknown[]
  emit: (message: unknown) => void
}

function installFakeBridge(): FakeBridge {
  const listeners: Array<(message: unknown) => void> = []
  const bridge: FakeBridge = {
    sent: [],
    post(message: unknown) {
      bridge.sent.push(message)
    },
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
  ;(window as unknown as { betterttsPlatform?: unknown }).betterttsPlatform = {
    isDesktop: true,
    kind: 'desktop',
    versions: { electron: '43.0.0', chrome: '150.0.0', node: '24.0.0' },
    sidecar: bridge,
  }
  return bridge
}

const status = {
  available: true,
  pythonPath: 'C:/BetterTTS/sidecar/venv/Scripts/python.exe',
  pythonVersion: '3.12.10',
  qwenInstalled: true,
  torchInstalled: true,
  modelReady: false,
  modelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
  message: 'Model weights will download on first use.',
  recovery: 'The model is user-managed.',
}

async function loadModule() {
  vi.resetModules()
  return import('./qwen.ts')
}

beforeEach(() => {
  delete (window as unknown as { betterttsPlatform?: unknown }).betterttsPlatform
})

describe('Qwen3-TTS sidecar client', () => {
  it('reports web mode as unavailable without touching a bridge', async () => {
    const mod = await loadModule()
    expect(mod.qwenSidecarAvailable()).toBe(false)
    await expect(mod.getQwenSidecarStatus()).resolves.toMatchObject({ available: false })
  })

  it('routes status, progress, and generated PCM through the desktop bridge', async () => {
    const bridge = installFakeBridge()
    const mod = await loadModule()
    const statusPromise = mod.getQwenSidecarStatus()
    expect(bridge.sent).toEqual([{ type: 'status', id: 0 }])
    bridge.emit({ type: 'status', id: 0, status })
    await expect(statusPromise).resolves.toMatchObject({ modelReady: false })

    const progress: Array<[number, string]> = []
    const generation = mod.synthesizeQwen('hello', { language: 'English', speaker: 'Vivian', speed: 1 }, undefined, (value, stage) => progress.push([value, stage]))
    expect(bridge.sent).toContainEqual({ type: 'synthesize', id: 1, text: 'hello', language: 'English', speaker: 'Vivian', speed: 1 })
    bridge.emit({ type: 'progress', id: 1, progress: 0.4, stage: 'Synthesizing' })
    const samples = new Float32Array([0.1, -0.2])
    bridge.emit({ type: 'generated', id: 1, samples, sampleRate: 24_000 })
    await expect(generation).resolves.toEqual({ samples, sampleRate: 24_000 })
    expect(progress).toEqual([[0.4, 'Synthesizing']])
  })

  it('cancels an in-flight generation and rejects pending work after a crash', async () => {
    const bridge = installFakeBridge()
    const mod = await loadModule()
    const controller = new AbortController()
    const generation = mod.synthesizeQwen('hello', { language: 'English', speaker: 'Vivian', speed: 1 }, controller.signal)
    controller.abort()
    await expect(generation).rejects.toMatchObject({ name: 'AbortError' })
    expect(bridge.sent).toContainEqual({ type: 'cancel', id: 0 })

    const pending = mod.synthesizeQwen('again', { language: 'English', speaker: 'Vivian', speed: 1 })
    bridge.emit({ type: 'crashed', message: 'sidecar stopped' })
    await expect(pending).rejects.toThrow('sidecar stopped')
  })
})
