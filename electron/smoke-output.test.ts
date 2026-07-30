import { describe, expect, it } from 'vitest'
import { dirname, join, resolve } from 'node:path'
import { resolveSmokeOutputDirectory } from './smoke-output.ts'

describe('Electron smoke output routing', () => {
  it('keeps development captures in the repository output directory', () => {
    expect(resolveSmokeOutputDirectory({
      appPath: join('C:', 'repo'),
      tempPath: join('C:', 'temp'),
      packaged: false,
    })).toBe(join('C:', 'repo', 'dist-electron'))
  })

  it('never writes packaged captures inside the read-only app.asar', () => {
    expect(resolveSmokeOutputDirectory({
      appPath: join('C:', 'app', 'resources', 'app.asar'),
      tempPath: join('C:', 'temp'),
      packaged: true,
    })).toBe(join('C:', 'temp', 'bettertts-smoke'))
  })

  it('co-locates captures with an explicit release report', () => {
    const report = join('reports', 'packaged.json')
    expect(resolveSmokeOutputDirectory({
      appPath: 'ignored',
      tempPath: 'ignored',
      packaged: true,
      reportPath: report,
    })).toBe(dirname(resolve(report)))
  })
})
