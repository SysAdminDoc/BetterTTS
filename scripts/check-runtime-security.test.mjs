import { describe, expect, it } from 'vitest'
import { evaluateAudit, validateExceptions } from './check-runtime-security.mjs'

const now = new Date('2026-07-25T12:00:00Z')

describe('runtime security gate', () => {
  it('rejects incomplete and expired exceptions', () => {
    expect(() => validateExceptions({ schemaVersion: 1, exceptions: [{ package: 'sharp' }] }, now)).toThrow('must include')
    expect(() => validateExceptions({
      schemaVersion: 1,
      exceptions: [{
        package: 'sharp',
        advisory: 'GHSA-example',
        owner: 'release',
        expires: '2026-07-24',
        rationale: 'Compatibility work in progress.',
      }],
    }, now)).toThrow('expired')
  })

  it('requires an active package-and-advisory match', () => {
    const audit = {
      vulnerabilities: {
        sharp: {
          name: 'sharp',
          severity: 'high',
          range: '<0.35.0',
          via: [{ source: 1234, url: 'https://github.com/advisories/GHSA-example' }],
        },
      },
    }
    const active = validateExceptions({
      schemaVersion: 1,
      exceptions: [{
        package: 'sharp',
        advisory: 'GHSA-example',
        owner: 'SysAdminDoc',
        expires: '2026-08-01',
        rationale: 'Pinned upstream compatibility test is pending.',
      }],
    }, now)

    expect(evaluateAudit(audit, [])).toEqual([{
      package: 'sharp',
      severity: 'high',
      range: '<0.35.0',
      advisories: ['1234', 'GHSA-example'],
    }])
    expect(evaluateAudit(audit, active)).toEqual([])
  })
})
