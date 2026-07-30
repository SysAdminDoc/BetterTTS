// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RawLease = {
  name: string
  owner: string
  token: string
  issuedAt: number
  expiresAt: number
}

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

function leaseName(jobId: string) {
  return `bettertts-job:${jobId}`
}

async function openLeaseDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('bettertts-coordination', 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('leases')) {
        request.result.createObjectStore('leases', { keyPath: 'name' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function putRawLease(lease: RawLease): Promise<void> {
  const db = await openLeaseDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('leases', 'readwrite')
    transaction.objectStore('leases').put(lease)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

async function getRawLease(name: string): Promise<RawLease | undefined> {
  const db = await openLeaseDb()
  const value = await new Promise<RawLease | undefined>((resolve, reject) => {
    const request = db.transaction('leases', 'readonly').objectStore('leases').get(name)
    request.onsuccess = () => resolve(request.result as RawLease | undefined)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return value
}

beforeEach(async () => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  FakeBroadcastChannel.instances = []
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
  const db = await openLeaseDb()
  db.close()
})

describe('cross-tab coordination', () => {
  it('allows exactly one simultaneous fallback lease owner', async () => {
    const mod = await loadModule()
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstTask = vi.fn(async () => {
      await gate
      return 'first'
    })
    const secondTask = vi.fn(async () => 'second')

    const first = mod.withJobLease('simultaneous', firstTask)
    await vi.waitFor(() => expect(firstTask).toHaveBeenCalledOnce())
    const second = await mod.withJobLease('simultaneous', secondTask)

    expect(second).toEqual({ acquired: false })
    expect(secondTask).not.toHaveBeenCalled()
    releaseFirst()
    await expect(first).resolves.toEqual({ acquired: true, value: 'first' })
  })

  it('takes over an expired lease left by a crashed tab', async () => {
    const now = Date.now()
    await putRawLease({
      name: leaseName('expired'),
      owner: 'crashed-tab',
      token: 'crashed-token',
      issuedAt: now - 20_000,
      expiresAt: now - 1,
    })
    const mod = await loadModule()

    await expect(mod.withJobLease('expired', async () => 'resumed'))
      .resolves.toEqual({ acquired: true, value: 'resumed' })
    expect(await getRawLease(leaseName('expired'))).toBeUndefined()
  })

  it('renews a held lease and keeps contenders out', async () => {
    const mod = await loadModule()
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const first = mod.withJobLease('renewed', async () => {
      await gate
      return 'done'
    })
    await vi.waitFor(async () => {
      expect(await getRawLease(leaseName('renewed'))).toBeDefined()
    })
    const before = await getRawLease(leaseName('renewed'))

    await new Promise((resolve) => window.setTimeout(resolve, 5_200))
    expect((await getRawLease(leaseName('renewed')))?.issuedAt).toBeGreaterThan(before!.issuedAt)
    expect(await mod.withJobLease('renewed', async () => 'duplicate')).toEqual({ acquired: false })

    releaseFirst()
    await expect(first).resolves.toEqual({ acquired: true, value: 'done' })
  }, 8_000)

  it('repairs a lease made implausibly long-lived by backward clock skew', async () => {
    const now = Date.now()
    await putRawLease({
      name: leaseName('skewed'),
      owner: 'old-tab',
      token: 'old-token',
      issuedAt: now + 300_000,
      expiresAt: now + 315_000,
    })
    const mod = await loadModule()

    await expect(mod.withJobLease('skewed', async () => 'repaired'))
      .resolves.toEqual({ acquired: true, value: 'repaired' })
  })

  it('aborts a task that loses ownership and never releases the successor lease', async () => {
    const mod = await loadModule()
    let observedSignal!: AbortSignal
    let finishTask!: () => void
    const taskGate = new Promise<void>((resolve) => { finishTask = resolve })
    const first = mod.withJobLease('replaced', async (signal) => {
      observedSignal = signal
      await taskGate
      return 'old-owner'
    })
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    const now = Date.now()
    const successor: RawLease = {
      name: leaseName('replaced'),
      owner: 'new-tab',
      token: 'new-token',
      issuedAt: now,
      expiresAt: now + 15_000,
    }
    await putRawLease(successor)

    await new Promise((resolve) => window.setTimeout(resolve, 5_200))
    expect(observedSignal.aborted).toBe(true)
    finishTask()
    await expect(first).resolves.toEqual({ acquired: true, value: 'old-owner' })
    expect(await getRawLease(leaseName('replaced'))).toEqual(successor)
  }, 8_000)

  it('uses an available Web Lock and reports a held one as unavailable', async () => {
    const request = vi.fn(async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown>,
    ) => callback(request.mock.calls.length === 1 ? {} as Lock : null))
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
    const mod = await loadModule()

    expect(await mod.withJobLease('web-lock', async () => 3)).toEqual({ acquired: true, value: 3 })
    expect(await mod.withJobLease('web-lock', async () => 4)).toEqual({ acquired: false })
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
