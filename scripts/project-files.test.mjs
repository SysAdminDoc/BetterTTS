import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  normalizeProjectPath,
  readProjectFile,
  validateProjectBytes,
  writeProjectFile,
} from '../electron/project-files.mjs'

describe('desktop project files', () => {
  it('atomically writes and reads a .bettertts archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bettertts-project-'))
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 5])
    const target = await writeProjectFile(join(root, 'Novel'), bytes)
    expect(target).toBe(join(root, 'Novel.bettertts'))
    expect([...await readProjectFile(target)]).toEqual([...bytes])
    expect([...readFileSync(target)]).toEqual([...bytes])
    const replacement = new Uint8Array([0x50, 0x4b, 9])
    await writeProjectFile(target, replacement)
    expect([...readFileSync(target)]).toEqual([...replacement])
  })

  it('rejects unsafe project payloads before replacing the target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bettertts-project-'))
    const target = join(root, 'Novel.bettertts')
    writeFileSync(target, new Uint8Array([0x50, 0x4b, 1]))
    await expect(writeProjectFile(target, new Uint8Array([1, 2, 3]))).rejects.toThrow('valid BetterTTS archive')
    expect([...readFileSync(target)]).toEqual([0x50, 0x4b, 1])
    expect(() => validateProjectBytes(new Uint8Array())).toThrow('between 1 byte and 512 MB')
  })

  it('normalizes only the project extension', () => {
    expect(normalizeProjectPath('book')).toBe('book.bettertts')
    expect(normalizeProjectPath('BOOK.BETTERTTS')).toBe('BOOK.BETTERTTS')
  })
})
