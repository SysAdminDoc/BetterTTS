import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildStaticUpdateMetadata,
  readDesktopUpdateArtifacts,
  verifyMetadataChecksum,
} from './desktop-update-feed.mjs'

const metadata = `version: 0.20.0
files:
  - url: BetterTTS Setup 0.20.0.exe
    sha512: checksum
    size: 42
path: BetterTTS Setup 0.20.0.exe
sha512: checksum
releaseDate: '2026-07-25T00:00:00.000Z'
`

describe('desktop update feed', () => {
  it('points generic-provider metadata at an absolute GitHub Release asset', () => {
    const result = buildStaticUpdateMetadata(metadata, {
      tag: 'v0.20.0',
      installerName: 'BetterTTS Setup 0.20.0.exe',
    })
    expect(result.assetUrl).toBe(
      'https://github.com/SysAdminDoc/BetterTTS/releases/download/v0.20.0/BetterTTS%20Setup%200.20.0.exe',
    )
    expect(result.metadata).toContain(`- url: ${result.assetUrl}`)
    expect(result.metadata).toContain(`path: ${result.assetUrl}`)
  })

  it('rejects stale metadata and unsafe artifact paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'bettertts-update-feed-'))
    mkdirSync(join(root, 'release'))
    writeFileSync(join(root, 'package.json'), '{"version":"0.20.1"}')
    writeFileSync(join(root, 'release', 'latest.yml'), metadata)
    expect(() => readDesktopUpdateArtifacts(root)).toThrow('does not match package 0.20.1')
    writeFileSync(join(root, 'package.json'), '{"version":"0.20.0"}')
    writeFileSync(join(root, 'release', 'latest.yml'), metadata.replaceAll('BetterTTS Setup 0.20.0.exe', '../escape.exe'))
    expect(() => readDesktopUpdateArtifacts(root)).toThrow('safe Windows installer path')
  })

  it('verifies the installer checksum before upload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bettertts-update-checksum-'))
    const installerPath = join(root, 'installer.exe')
    writeFileSync(installerPath, 'verified artifact')
    const checksum = 'KFOV8cFYSoRix4wH2gDVOF4OEmSQkpgbrWPGslxGOexCxqUrmNlrpiJu9ZSXn5IwSFw7/vCXGV12sBGwIex2xw=='
    await expect(verifyMetadataChecksum(`sha512: ${checksum}`, installerPath)).resolves.toBeUndefined()
    await expect(verifyMetadataChecksum('sha512: invalid', installerPath)).rejects.toThrow('does not match')
  })
})
