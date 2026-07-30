export type PersistenceOutcome = {
  state: 'durable' | 'degraded' | 'failed'
  reason?: string
  key?: string
}

let lastOutcome: PersistenceOutcome = { state: 'durable' }

export function writePersistentSetting(
  storage: Pick<Storage, 'setItem' | 'getItem'> | null | undefined,
  key: string,
  value: string,
): PersistenceOutcome {
  if (!storage) {
    lastOutcome = { state: 'failed', key, reason: 'Browser storage is unavailable.' }
    return lastOutcome
  }
  try {
    storage.setItem(key, value)
    if (storage.getItem(key) !== value) {
      lastOutcome = { state: 'failed', key, reason: 'The browser did not retain the written value.' }
      return lastOutcome
    }
    lastOutcome = { state: 'durable' }
    return lastOutcome
  } catch (error) {
    const detail = error instanceof Error && error.name ? error.name : 'write rejected'
    lastOutcome = {
      state: 'degraded',
      key,
      reason: `Browser storage ${detail}; this session continues in memory only.`,
    }
    return lastOutcome
  }
}

export function getPersistenceOutcome(): PersistenceOutcome {
  return { ...lastOutcome }
}
