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
const LEASE_PREFIX = 'bettertts-job-lease:'
const LEASE_TTL_MS = 15_000
const LEASE_RENEW_MS = 5_000
let channel: BroadcastChannel | null = null
let fallbackId = ''

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
  owner: string
  expiresAt: number
}

function readStoredLease(key: string): StoredLease | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Partial<StoredLease> | null
    return parsed && typeof parsed.owner === 'string' && typeof parsed.expiresAt === 'number'
      ? parsed as StoredLease
      : null
  } catch {
    return null
  }
}

async function withFallbackLease<T>(name: string, task: () => Promise<T>): Promise<LeaseResult<T>> {
  const key = `${LEASE_PREFIX}${name}`
  const owner = tabId()
  const current = readStoredLease(key)
  if (current && current.owner !== owner && current.expiresAt > Date.now()) return { acquired: false }

  const writeLease = (): boolean => {
    try {
      window.localStorage.setItem(key, JSON.stringify({ owner, expiresAt: Date.now() + LEASE_TTL_MS }))
      return true
    } catch {
      return false
    }
  }
  if (!writeLease()) {
    // Storage-disabled browsers cannot coordinate a fallback lease safely.
    return { acquired: false }
  }
  if (readStoredLease(key)?.owner !== owner) return { acquired: false }

  const renew = window.setInterval(writeLease, LEASE_RENEW_MS)
  try {
    return { acquired: true, value: await task() }
  } finally {
    window.clearInterval(renew)
    try {
      if (readStoredLease(key)?.owner === owner) window.localStorage.removeItem(key)
    } catch {
      // The lease expires naturally if storage becomes unavailable mid-task.
    }
  }
}

export async function withJobLease<T>(jobId: string, task: () => Promise<T>): Promise<LeaseResult<T>> {
  const name = `bettertts-job:${jobId}`
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) return { acquired: false }
      return { acquired: true, value: await task() }
    })
  }
  if (typeof window === 'undefined') return { acquired: true, value: await task() }
  return withFallbackLease(name, task)
}
