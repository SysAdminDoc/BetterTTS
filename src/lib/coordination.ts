export type StoreName = 'library' | 'queue'

export type StoreChange = {
  store: StoreName
  action: 'write' | 'delete' | 'clear' | 'restore'
  id?: string
  source: string
  at: number
}

const CHANNEL_NAME = 'bettertts-storage-v1'
const PULSE_KEY = 'bettertts-storage-pulse-v1'
const LEASE_DB_NAME = 'bettertts-coordination'
const LEASE_DB_VERSION = 1
const LEASE_STORE = 'leases'
const LEASE_TTL_MS = 15_000
const LEASE_RENEW_MS = 5_000
const LEASE_CLOCK_SKEW_MS = 60_000
let channel: BroadcastChannel | null = null
let fallbackId = ''
let leaseDbPromise: Promise<IDBDatabase> | null = null

function tabId(): string {
  if (typeof window === 'undefined') return 'server'
  try {
    const existing = window.sessionStorage.getItem('bettertts-tab-id')
    if (existing) return existing
    const id = crypto.randomUUID()
    window.sessionStorage.setItem('bettertts-tab-id', id)
    return id
  } catch {
    fallbackId ||= crypto.randomUUID()
    return fallbackId
  }
}

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null
  if (channel) return channel
  try {
    channel = new BroadcastChannel(CHANNEL_NAME)
    return channel
  } catch {
    return null
  }
}

export function publishStoreChange(
  store: StoreName,
  action: StoreChange['action'],
  id?: string,
): void {
  if (typeof window === 'undefined') return
  const change: StoreChange = { store, action, id, source: tabId(), at: Date.now() }
  getChannel()?.postMessage(change)
  try {
    window.localStorage.setItem(PULSE_KEY, JSON.stringify(change))
    window.localStorage.removeItem(PULSE_KEY)
  } catch {
    // BroadcastChannel remains the primary path when storage is unavailable.
  }
}

function isStoreChange(value: unknown): value is StoreChange {
  const change = value as Partial<StoreChange>
  return (
    (change.store === 'library' || change.store === 'queue')
    && ['write', 'delete', 'clear', 'restore'].includes(change.action ?? '')
    && typeof change.source === 'string'
    && typeof change.at === 'number'
  )
}

export function subscribeToStoreChanges(listener: (change: StoreChange) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const ownId = tabId()
  const receive = (value: unknown) => {
    if (isStoreChange(value) && value.source !== ownId) listener(value)
  }
  const activeChannel = getChannel()
  const onMessage = (event: MessageEvent<unknown>) => receive(event.data)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PULSE_KEY || !event.newValue) return
    try {
      receive(JSON.parse(event.newValue))
    } catch {
      // Ignore malformed cross-tab pulses.
    }
  }
  activeChannel?.addEventListener('message', onMessage)
  window.addEventListener('storage', onStorage)
  return () => {
    activeChannel?.removeEventListener('message', onMessage)
    window.removeEventListener('storage', onStorage)
  }
}

type LeaseResult<T> =
  | { acquired: true; value: T }
  | { acquired: false }

type StoredLease = {
  name: string
  owner: string
  token: string
  issuedAt: number
  expiresAt: number
}

function openLeaseDB(): Promise<IDBDatabase> {
  if (leaseDbPromise) return leaseDbPromise
  leaseDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LEASE_DB_NAME, LEASE_DB_VERSION)
    let settled = false
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(LEASE_STORE)) {
        request.result.createObjectStore(LEASE_STORE, { keyPath: 'name' })
      }
    }
    request.onblocked = () => {
      settled = true
      leaseDbPromise = null
      reject(new Error('Coordination database is blocked'))
    }
    request.onsuccess = () => {
      const db = request.result
      if (settled) {
        db.close()
        return
      }
      settled = true
      db.onversionchange = () => {
        db.close()
        leaseDbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => {
      settled = true
      leaseDbPromise = null
      reject(request.error)
    }
  })
  return leaseDbPromise
}

function isStoredLease(value: unknown): value is StoredLease {
  if (!value || typeof value !== 'object') return false
  const lease = value as Partial<StoredLease>
  return (
    typeof lease.name === 'string'
    && typeof lease.owner === 'string'
    && typeof lease.token === 'string'
    && typeof lease.issuedAt === 'number'
    && typeof lease.expiresAt === 'number'
  )
}

function leaseIsActive(lease: StoredLease, now: number): boolean {
  if (lease.expiresAt <= now) return false
  // If the wall clock moved backwards, a lease can appear valid forever.
  // Bound its believable lifetime and let a new contender repair it.
  return (
    lease.issuedAt <= now + LEASE_CLOCK_SKEW_MS
    && lease.expiresAt - now <= LEASE_TTL_MS + LEASE_CLOCK_SKEW_MS
  )
}

async function acquireFallbackLease(name: string, owner: string, token: string): Promise<boolean> {
  const db = await openLeaseDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LEASE_STORE, 'readwrite')
    const store = transaction.objectStore(LEASE_STORE)
    let acquired = false
    const request = store.get(name)
    request.onsuccess = () => {
      const now = Date.now()
      if (isStoredLease(request.result) && leaseIsActive(request.result, now)) return
      store.put({
        name,
        owner,
        token,
        issuedAt: now,
        expiresAt: now + LEASE_TTL_MS,
      } satisfies StoredLease)
      acquired = true
    }
    transaction.oncomplete = () => resolve(acquired)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })
}

async function renewFallbackLease(name: string, owner: string, token: string): Promise<boolean> {
  const db = await openLeaseDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LEASE_STORE, 'readwrite')
    const store = transaction.objectStore(LEASE_STORE)
    let renewed = false
    const request = store.get(name)
    request.onsuccess = () => {
      const current = request.result
      if (!isStoredLease(current) || current.owner !== owner || current.token !== token) return
      const now = Date.now()
      store.put({ ...current, issuedAt: now, expiresAt: now + LEASE_TTL_MS })
      renewed = true
    }
    transaction.oncomplete = () => resolve(renewed)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })
}

async function releaseFallbackLease(name: string, owner: string, token: string): Promise<void> {
  const db = await openLeaseDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LEASE_STORE, 'readwrite')
    const store = transaction.objectStore(LEASE_STORE)
    const request = store.get(name)
    request.onsuccess = () => {
      const current = request.result
      if (isStoredLease(current) && current.owner === owner && current.token === token) store.delete(name)
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })
}

async function withFallbackLease<T>(
  name: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<LeaseResult<T>> {
  const owner = tabId()
  const token = crypto.randomUUID()
  try {
    if (!await acquireFallbackLease(name, owner, token)) return { acquired: false }
  } catch {
    // IndexedDB-disabled browsers cannot coordinate a fallback lease safely.
    return { acquired: false }
  }

  const leaseController = new AbortController()
  let stopped = false
  let renewTimer: number | null = null
  let renewal: Promise<void> | null = null
  const scheduleRenewal = () => {
    renewTimer = window.setTimeout(() => {
      renewal = renewFallbackLease(name, owner, token)
        .then((renewed) => {
          if (!renewed) leaseController.abort(new DOMException('Queue lease lost', 'AbortError'))
        })
        .catch(() => leaseController.abort(new DOMException('Queue lease renewal failed', 'AbortError')))
        .finally(() => {
          renewal = null
          if (!stopped && !leaseController.signal.aborted) scheduleRenewal()
        })
    }, LEASE_RENEW_MS)
  }
  scheduleRenewal()

  try {
    return { acquired: true, value: await task(leaseController.signal) }
  } finally {
    stopped = true
    if (renewTimer !== null) window.clearTimeout(renewTimer)
    const pendingRenewal = renewal as Promise<void> | null
    if (pendingRenewal) await pendingRenewal.catch(() => {})
    try {
      await releaseFallbackLease(name, owner, token)
    } catch {
      // The lease expires naturally if IndexedDB becomes unavailable mid-task.
    }
  }
}

export async function withJobLease<T>(
  jobId: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<LeaseResult<T>> {
  const name = `bettertts-job:${jobId}`
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) return { acquired: false }
      return { acquired: true, value: await task(new AbortController().signal) }
    })
  }
  if (typeof window === 'undefined') return { acquired: true, value: await task(new AbortController().signal) }
  return withFallbackLease(name, task)
}
