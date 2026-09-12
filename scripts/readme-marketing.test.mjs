import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const heroPath = join(root, 'assets', 'marketing', 'social-preview.png')
const publicHeroPath = join(root, 'public', 'social-preview.png')
const selectionPath = join(root, 'assets', 'concepts', '2026-09-12-readme-hero', 'selection.json')

function pngDimensions(buffer) {
  expect(buffer.subarray(1, 4).toString('ascii')).toBe('PNG')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

describe('README marketing hero', () => {
  it('appears exactly once at the top of the README', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const reference = 'assets/marketing/social-preview.png'

    expect(readme.startsWith(`![BetterTTS private speech studio for local voice generation](${reference})\n`)).toBe(true)
    expect(readme.split(reference)).toHaveLength(2)
  })

  it('keeps the selected evergreen image identical across production copies', () => {
    const hero = readFileSync(heroPath)
    const publicHero = readFileSync(publicHeroPath)
    const selection = JSON.parse(readFileSync(selectionPath, 'utf8'))

    expect(pngDimensions(hero)).toEqual({ width: 1280, height: 640 })
    expect(sha256(hero)).toBe(selection.selectedSha256)
    expect(sha256(publicHero)).toBe(selection.selectedSha256)
    expect(selection.containsReleaseVersion).toBe(false)
  })
})
