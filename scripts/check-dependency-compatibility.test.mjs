import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matchesVersionLine, parseVersion, readCompatibilityConfig, validateCompatibility } from './check-dependency-compatibility.mjs'

describe('dependency compatibility policy', () => {
  it('parses stable and prerelease versions against explicit compatibility lines', () => {
    expect(parseVersion('1.26.0-dev.20260416-b7804b056c')).toEqual([1, 26, 0])
    expect(matchesVersionLine('43.1.0', '43.x')).toBe(true)
    expect(matchesVersionLine('19.2.7', '19.2.x')).toBe(true)
    expect(matchesVersionLine('1.26.0-dev.20260416-b7804b056c', '1.x')).toBe(true)
    expect(matchesVersionLine('4.3.0', '4.2.x')).toBe(false)
  })

  it('accepts the repository lock and reports explicit deferred holds', () => {
    const report = validateCompatibility()
    expect(report.packages.find((row) => row.name === '@huggingface/transformers')?.lockedVersion).toBe('4.2.0')
    expect(report.holds).toEqual(expect.arrayContaining([
      expect.objectContaining({ package: 'typescript', candidate: '7.x', status: 'deferred' }),
      expect.objectContaining({ package: '@huggingface/transformers', status: 'deferred' }),
    ]))
  })

  it('rejects a package spec drift even when the lock version is unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'bettertts-compat-'))
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { demo: '^1.0.0' } }))
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {
      '': { dependencies: { demo: '^1.1.0' } },
      'node_modules/demo': { version: '1.0.0' },
    } }))
    const config = {
      schemaVersion: 1,
      gates: ['test'],
      packages: [{ id: 'demo', label: 'Demo', packages: [{ name: 'demo', spec: '^1.1.0', lockedVersion: '1.0.0', line: '1.x' }] }],
      holds: [],
    }

    expect(() => validateCompatibility({ root, config, checkInstalled: false })).toThrow(/package\.json spec/)
  })

  it('rejects an unrecorded lock update outside the reviewed version', () => {
    const root = mkdtempSync(join(tmpdir(), 'bettertts-compat-'))
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { demo: '^1.0.0' } }))
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {
      '': { dependencies: { demo: '^1.0.0' } },
      'node_modules/demo': { version: '1.0.1' },
    } }))
    const config = {
      schemaVersion: 1,
      gates: ['test'],
      packages: [{ id: 'demo', label: 'Demo', packages: [{ name: 'demo', spec: '^1.0.0', lockedVersion: '1.0.0', line: '1.0.x' }] }],
      holds: [],
    }

    expect(() => validateCompatibility({ root, config, checkInstalled: false })).toThrow(/reviewed 1\.0\.0/)
  })

  it('keeps the full gate list separate from the lightweight policy check', () => {
    const config = readCompatibilityConfig()
    expect(config.gates).toEqual(['test', 'lint', 'typecheck', 'build', 'smoke', 'license:runtime', 'sbom:check', 'capabilities:check'])
  })
})
