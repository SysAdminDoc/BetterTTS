import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  normalizeProjectPath,
  ProjectConflictError,
  readProjectSnapshot,
  readProjectFile,
  validateProjectBytes,
  writeProjectFile,
} from '../electron/project-files.mjs'

describe('desktop project files', () => {
  it('atomically writes and reads a .bettertts archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bettertts-project-'))
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 5])
    const first = await writeProjectFile(join(root, 'Novel'), bytes)
    expect(first.path).toBe(join(root, 'Novel.bettertts'))
    expect(first.identity.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect([...await readProjectFile(first.path)]).toEqual([...bytes])
    expect([...readFileSync(first.path)]).toEqual([...bytes])
    const replacement = new Uint8Array([0x50, 0x4b, 9])
    const second = await writeProjectFile(first.path, replacement, { expectedIdentity: first.identity })
    expect(second.identity.revision).not.toBe(first.identity.revision)
    expect([...readFileSync(first.path)]).toEqual([...replacement])
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

  it('detects external changes and permits only an explicit overwrite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bettertts-project-'))
    const target = join(root, 'Novel.bettertts')
    const first = await writeProjectFile(target, new Uint8Array([0x50, 0x4b, 1]))
    writeFileSync(target, new Uint8Array([0x50, 0x4b, 2]))

    await expect(writeProjectFile(
      target,
      new Uint8Array([0x50, 0x4b, 3]),
      { expectedIdentity: first.identity },
    )).rejects.toBeInstanceOf(ProjectConflictError)
    expect([...readFileSync(target)]).toEqual([0x50, 0x4b, 2])

    const external = await readProjectSnapshot(target)
    await writeProjectFile(target, new Uint8Array([0x50, 0x4b, 3]), {
      expectedIdentity: external.identity,
    })
    expect([...readFileSync(target)]).toEqual([0x50, 0x4b, 3])
  })

  it('preserves the previous project when commit fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bettertts-project-'))
    const target = join(root, 'Novel.bettertts')
    const first = await writeProjectFile(target, new Uint8Array([0x50, 0x4b, 1]))

    await expect(writeProjectFile(target, new Uint8Array([0x50, 0x4b, 2]), {
      expectedIdentity: first.identity,
      beforeCommit: () => { throw new Error('injected commit failure') },
    })).rejects.toThrow('injected commit failure')
    expect([...readFileSync(target)]).toEqual([0x50, 0x4b, 1])
  })
})
