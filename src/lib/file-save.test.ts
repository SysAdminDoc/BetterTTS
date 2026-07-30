import { describe, expect, it, vi } from 'vitest'
import { commitBlobToFile, FileSaveError, type WritableFileLike } from './file-save.ts'

function writable(overrides: Partial<WritableFileLike> = {}): WritableFileLike {
  return {
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('commitBlobToFile', () => {
  it('closes only after a successful write', async () => {
    const target = writable()
    await commitBlobToFile(async () => target, new Blob(['audio']))
    expect(target.write).toHaveBeenCalledOnce()
    expect(target.close).toHaveBeenCalledOnce()
    expect(target.abort).not.toHaveBeenCalled()
  })

  it('aborts instead of closing after a write failure', async () => {
    const target = writable({
      write: vi.fn(async () => { throw new Error('disk full') }),
    })
    await expect(commitBlobToFile(async () => target, new Blob(['audio']))).rejects.toMatchObject({
      name: 'FileSaveError',
      destinationChanged: false,
    })
    expect(target.abort).toHaveBeenCalledOnce()
    expect(target.close).not.toHaveBeenCalled()
  })

  it('reports an uncertain destination if rollback also fails', async () => {
    const target = writable({
      close: vi.fn(async () => { throw new Error('commit failed') }),
      abort: vi.fn(async () => { throw new Error('rollback failed') }),
    })
    let failure: FileSaveError | null = null
    try {
      await commitBlobToFile(async () => target, new Blob(['audio']))
    } catch (error) {
      failure = error as FileSaveError
    }
    expect(failure).toMatchObject({ destinationChanged: 'unknown' })
    expect(failure?.message).toContain('partial file')
  })
})
