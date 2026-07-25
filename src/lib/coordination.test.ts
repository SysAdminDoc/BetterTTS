// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = []
  readonly posted: unknown[] = []
  private listeners: Array<(event: MessageEvent<unknown>) => void> = []

  constructor() {
    FakeBroadcastChannel.instances.push(this)
  }

  postMessage(value: unknown) {
    this.posted.push(value)
  }

  addEventListener(_type: string, listener: EventListener) {
    this.listeners.push(listener as (event: MessageEvent<unknown>) => void)
  }

  removeEventListener(_type: string, listener: EventListener) {
    this.listeners = this.listeners.filter((entry) => entry !== listener)
  }

  emit(value: unknown) {
    for (const listener of this.listeners) listener({ data: value } as MessageEvent<unknown>)
  }
}

async function loadModule() {
  vi.resetModules()
  return import('./coordination.ts')
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  FakeBroadcastChannel.instances = []
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
})

describe('cross-tab coordination', () => {
  it('recovers an expired fallback lease', async () => {
    const mod = await loadModule()
    window.localStorage.setItem('bettertts-job-lease:bettertts-job:job-1', JSON.stringify({
      owner: 'crashed-tab',
      expiresAt: Date.now() - 1,
    }))

    const result = await mod.withJobLease('job-1', async () => 'resumed')
    expect(result).toEqual({ acquired: true, value: 'resumed' })
    expect(window.localStorage.getItem('bettertts-job-lease:bettertts-job:job-1')).toBeNull()
  })

  it('refuses a live fallback lease owned by another tab', async () => {
    const mod = await loadModule()
    window.localStorage.setItem('bettertts-job-lease:bettertts-job:job-2', JSON.stringify({
      owner: 'other-tab',
      expiresAt: Date.now() + 10_000,
    }))

    const task = vi.fn(async () => 'duplicate')
    expect(await mod.withJobLease('job-2', task)).toEqual({ acquired: false })
    expect(task).not.toHaveBeenCalled()
  })

  it('uses an available Web Lock and reports a held one as unavailable', async () => {
    const request = vi.fn(async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown>,
    ) => callback(request.mock.calls.length === 1 ? {} as Lock : null))
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
    const mod = await loadModule()

    expect(await mod.withJobLease('job-3', async () => 3)).toEqual({ acquired: true, value: 3 })
    expect(await mod.withJobLease('job-3', async () => 4)).toEqual({ acquired: false })
  })

  it('delivers another tab storage change and ignores this tab source', async () => {
    const mod = await loadModule()
    const changes: unknown[] = []
    const unsubscribe = mod.subscribeToStoreChanges((change) => changes.push(change))
    const fake = FakeBroadcastChannel.instances[0]
    const ownSource = window.sessionStorage.getItem('bettertts-tab-id')

    fake.emit({ store: 'queue', action: 'write', id: 'job', source: 'other-tab', at: 1 })
    fake.emit({ store: 'library', action: 'clear', source: ownSource, at: 2 })
    expect(changes).toEqual([{ store: 'queue', action: 'write', id: 'job', source: 'other-tab', at: 1 }])
    unsubscribe()
  })
})
