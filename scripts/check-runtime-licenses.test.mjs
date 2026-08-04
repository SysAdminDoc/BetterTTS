import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXPECTED_LICENSES, findMissingRuntimeLicenses, validateLicenseTable } from './check-runtime-licenses.mjs'

describe('runtime license table', () => {
  it('covers every direct production dependency', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    expect(findMissingRuntimeLicenses(packageJson)).toEqual([])
  })

  it('fails when a new runtime dependency is absent from the table', () => {
    const packageJson = { dependencies: { 'known-runtime': '^1.0.0', 'new-runtime': '^2.0.0' } }
    const entries = [['known-runtime', 'MIT']]

    expect(findMissingRuntimeLicenses(packageJson, entries)).toEqual(['new-runtime'])
    expect(() => validateLicenseTable(packageJson, entries)).toThrow('new-runtime')
    expect(EXPECTED_LICENSES.length).toBeGreaterThan(0)
  })
})
