// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: MessageEvent | Event) => void

class FakeWorker {
  static instances: FakeWorker[] = []
  readonly posted: unknown[] = []
  terminated = false
  private listeners = new Map<string, Listener[]>()

  constructor() {
    FakeWorker.instances.push(this)
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  postMessage(message: unknown) {
    this.posted.push(message)
  }

  terminate() {
    this.terminated = true
  }
}

async function loadModule() {
  vi.resetModules()
  return import('./kokoro-worker.ts')
}

beforeEach(() => {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
})

describe('kokoro worker cancellation', () => {
  it('rejects a targeted request deterministically and notifies the worker', async () => {
    const mod = await loadModule()
    const controller = new AbortController()
    const generation = mod.generateWorker('hello', 'af_heart', 1, undefined, controller.signal)
    controller.abort()

    await expect(generation).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances[0].posted).toContainEqual({ type: 'cancel', id: 0 })
  })

  it('terminates inference and rejects every pending request on global cancel', async () => {
    const mod = await loadModule()
    const first = mod.generateWorker('one', 'af_heart', 1)
    const second = mod.generateWorker('two', 'af_heart', 1)
    mod.cancelWorkerGeneration()
    mod.cancelWorkerGeneration()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances[0].terminated).toBe(true)
  })
})
