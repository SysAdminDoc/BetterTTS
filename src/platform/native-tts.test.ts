// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeTtsBridge } from './index.ts'

type FakeBridge = NativeTtsBridge & {
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
        const idx = listeners.indexOf(listener)
        if (idx >= 0) listeners.splice(idx, 1)
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
    nativeTts: bridge,
  }
  return bridge
}

const runtime = {
  runtime: 'onnxruntime-node',
  ep: 'cpu',
  ortVersion: '1.27.0',
  transformersVersion: '4.2.0',
  kokoroJsVersion: '1.2.1',
  node: '24.0.0',
  modelCacheDir: 'C:/cache',
}

async function loadModule() {
  // Module-level state (pending map, load promise) must reset per test.
  vi.resetModules()
  return import('./native-tts.ts')
}

beforeEach(() => {
  delete (window as unknown as { betterttsPlatform?: unknown }).betterttsPlatform
})

describe('native-tts client', () => {
  it('is unavailable without the desktop bridge', async () => {
    const mod = await loadModule()
    expect(mod.nativeTtsAvailable()).toBe(false)
    await expect(mod.generateNative('hi', 'af_heart', 1)).rejects.toThrow(/desktop app/)
  })

  it('resolves load with runtime info and memoizes the load promise', async () => {
    const bridge = installFakeBridge()
    const mod = await loadModule()

    const first = mod.loadNativeKokoro(() => {})
    const second = mod.loadNativeKokoro(() => {})
    expect(second).toBe(first)
    expect(bridge.sent).toEqual([{ type: 'load', dtype: 'q8' }])

    bridge.emit({ type: 'loaded', key: 'cpu:q8', runtime })
    await expect(first).resolves.toMatchObject({ ep: 'cpu', ortVersion: '1.27.0' })
    expect(mod.getNativeRuntimeInfo()?.ortVersion).toBe('1.27.0')
  })

  it('routes progress, resolves generates by id, and rejects failed ids', async () => {
    const bridge = installFakeBridge()
    const mod = await loadModule()

    const progress: unknown[] = []
    const load = mod.loadNativeKokoro((info) => progress.push(info))
    bridge.emit({ type: 'progress', info: { status: 'progress', file: 'model.onnx', progress: 50 } })
    bridge.emit({ type: 'loaded', key: 'cpu:q8', runtime })
    await load
    expect(progress).toHaveLength(1)

    const good = mod.generateNative('hello', 'af_heart', 1)
    const bad = mod.generateNative('world', 'af_heart', 1)
    const samples = new Float32Array([0.1, 0.2])
    bridge.emit({ type: 'generated', samples, id: 0 })
    bridge.emit({ type: 'generateError', message: 'boom', id: 1 })

    await expect(good).resolves.toEqual(samples)
    await expect(bad).rejects.toThrow('boom')
  })

  it('rejects everything pending when the host crashes and allows a fresh load', async () => {
    const bridge = installFakeBridge()
    const mod = await loadModule()

    const load = mod.loadNativeKokoro(() => {})
    const gen = mod.generateNative('hello', 'af_heart', 1)
    bridge.emit({ type: 'crashed' })

    await expect(load).rejects.toThrow(/crashed/)
    await expect(gen).rejects.toThrow(/crashed/)
    expect(mod.getNativeRuntimeInfo()).toBeNull()

    const retry = mod.loadNativeKokoro(() => {})
    bridge.emit({ type: 'loaded', key: 'cpu:q8', runtime })
    await expect(retry).resolves.toMatchObject({ ep: 'cpu' })
  })

  it('reset posts a reset message and clears cached runtime state', async () => {
    const bridge = installFakeBridge()
    const mod = await loadModule()

    const load = mod.loadNativeKokoro(() => {})
    bridge.emit({ type: 'loaded', key: 'cpu:q8', runtime })
    await load

    mod.resetNativeTts()
    expect(bridge.sent).toContainEqual({ type: 'reset' })
    expect(mod.getNativeRuntimeInfo()).toBeNull()
  })

  it('cancels an in-flight request with AbortError and asks main to stop the host', async () => {
    const bridge = installFakeBridge()
    const mod = await loadModule()
    const controller = new AbortController()
    const generation = mod.generateNative('hello', 'af_heart', 1, controller.signal)
    controller.abort()

    await expect(generation).rejects.toMatchObject({ name: 'AbortError' })
    expect(bridge.sent).toContainEqual({ type: 'cancel', id: 0 })
  })

  it('rejects all pending requests when global cancellation releases the host', async () => {
    const bridge = installFakeBridge()
    const mod = await loadModule()
    const generation = mod.generateNative('hello', 'af_heart', 1)
    mod.cancelNativeGeneration()
    mod.cancelNativeGeneration()

    await expect(generation).rejects.toMatchObject({ name: 'AbortError' })
    expect(bridge.sent.filter((message) => JSON.stringify(message) === '{"type":"cancel-all"}')).toHaveLength(2)
  })
})
