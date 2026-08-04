import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { EXTENSION_FILES, buildExtensionArchive } from './build-extension.mjs'

const temporaryRoots = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('BetterTTS browser extension', () => {
  it('uses temporary active-tab access without host permissions', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'extension', 'manifest.json'), 'utf8'))
    expect(manifest.permissions).toEqual(expect.arrayContaining(['activeTab', 'contextMenus', 'scripting']))
    expect(manifest).not.toHaveProperty('host_permissions')
    expect(manifest).not.toHaveProperty('content_scripts')
  })

  it('builds a self-contained installable archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'bettertts-extension-'))
    temporaryRoots.push(root)
    const outputPath = buildExtensionArchive(process.cwd(), join(root, 'bettertts-extension.zip'))
    const archive = unzipSync(new Uint8Array(readFileSync(outputPath)))

    expect(Object.keys(archive).sort()).toEqual([...EXTENSION_FILES].sort())
    expect(JSON.parse(new TextDecoder().decode(archive['manifest.json']))).toMatchObject({ manifest_version: 3, name: 'Listen in BetterTTS' })
    expect(archive['background.js'].length).toBeGreaterThan(500)
    expect(archive['icon-192.png'].length).toBeGreaterThan(1000)
  })
})
