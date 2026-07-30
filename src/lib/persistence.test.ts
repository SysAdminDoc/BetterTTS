import { describe, expect, it } from 'vitest'
import { getPersistenceOutcome, writePersistentSetting } from './persistence.ts'

describe('browser persistence outcomes', () => {
  it('verifies durable writes', () => {
    const values = new Map<string, string>()
    expect(writePersistentSetting({
      setItem: (key, value) => { values.set(key, value) },
      getItem: (key) => values.get(key) ?? null,
    }, 'theme', 'dark')).toEqual({ state: 'durable' })
  })

  it('reports degraded quota/policy writes while allowing in-memory use', () => {
    const outcome = writePersistentSetting({
      setItem: () => { throw new DOMException('full', 'QuotaExceededError') },
      getItem: () => null,
    }, 'draft', 'private text')
    expect(outcome).toMatchObject({ state: 'degraded', key: 'draft' })
    expect(outcome.reason).toContain('memory only')
    expect(getPersistenceOutcome()).toEqual(outcome)
  })

  it('reports missing and non-retaining storage as failed', () => {
    expect(writePersistentSetting(null, 'theme', 'light')).toMatchObject({ state: 'failed' })
    expect(writePersistentSetting({
      setItem: () => {},
      getItem: () => null,
    }, 'theme', 'light')).toMatchObject({ state: 'failed', reason: expect.stringContaining('retain') })
  })
})
