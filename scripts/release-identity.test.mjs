import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertVersionMetadata, readReleaseIdentity, writePagesReleaseManifest } from './release-identity.mjs'

const temporaryRoots = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createFixture(version = '1.2.3') {
  const root = mkdtempSync(join(tmpdir(), 'bettertts-release-identity-'))
  temporaryRoots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bettertts', version }))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    name: 'bettertts',
    version,
    lockfileVersion: 3,
    packages: { '': { name: 'bettertts', version } },
  }))
  writeFileSync(join(root, 'README.md'), `[![Version](https://img.shields.io/badge/version-${version}-blue.svg)](#)\n`)
  writeFileSync(join(root, 'CHANGELOG.md'), `# Changelog\n\n## v${version} - 2026-08-03\n`)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'App.tsx'), `const APP_VERSION = '${version}'\n`)
  return root
}

function initializeGit(root) {
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' })
}

describe('release identity', () => {
  it('requires synchronized version metadata and an annotated tag at HEAD', () => {
    const root = createFixture()
    initializeGit(root)
    execFileSync('git', ['tag', '-a', 'v1.2.3', '-m', 'v1.2.3'], { cwd: root })

    const identity = readReleaseIdentity(root)
    expect(identity).toMatchObject({ version: '1.2.3', tag: 'v1.2.3' })
    expect(identity.sourceSha).toMatch(/^[a-f0-9]{40}$/)
  })

  it('rejects a stale application version before any release work starts', () => {
    const root = createFixture()
    writeFileSync(join(root, 'src', 'App.tsx'), "const APP_VERSION = '1.2.2'\n")
    expect(() => assertVersionMetadata(root)).toThrow('src/App.tsx APP_VERSION')
  })

  it('writes a Pages manifest containing the exact source identity', () => {
    const root = createFixture()
    const dist = join(root, 'dist')
    mkdirSync(dist)
    const manifestPath = writePagesReleaseManifest(dist, {
      app: 'BetterTTS',
      version: '1.2.3',
      tag: 'v1.2.3',
      sourceSha: '0123456789abcdef0123456789abcdef01234567',
    })
    expect(manifestPath).toBe(join(dist, 'release.json'))
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
      version: '1.2.3',
      tag: 'v1.2.3',
      sourceSha: '0123456789abcdef0123456789abcdef01234567',
    })
  })
})
