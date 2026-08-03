import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readSherpaPackStatus,
  sherpaKokoroSpeakerId,
  sherpaModelPaths,
  SHERPA_KOKORO_PACK,
  SHERPA_PIPER_PACK,
  validateArchiveEntry,
  validateSherpaModelPack,
} from './sherpa-models.ts'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bettertts-sherpa-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Sherpa model packs', () => {
  it('keeps both runtime packs immutable and exposes addon-ready paths', () => {
    expect(() => validateSherpaModelPack(SHERPA_KOKORO_PACK)).not.toThrow()
    expect(() => validateSherpaModelPack(SHERPA_PIPER_PACK)).not.toThrow()

    const paths = sherpaModelPaths(root, SHERPA_KOKORO_PACK)
    expect(paths.model).toMatch(/model\.int8\.onnx$/)
    expect(paths.voices).toMatch(/voices\.bin$/)
    expect(paths.lexicon).toContain('lexicon-us-en.txt')
    expect(SHERPA_KOKORO_PACK.archive.sha256).toHaveLength(64)
    expect(SHERPA_PIPER_PACK.archive.sha256).toHaveLength(64)
  })

  it('maps the existing Kokoro voice ids and falls back safely', () => {
    expect(sherpaKokoroSpeakerId('af_heart')).toBe(3)
    expect(sherpaKokoroSpeakerId('bm_lewis')).toBe(27)
    expect(sherpaKokoroSpeakerId('unknown')).toBe(3)
  })

  it('normalizes safe tar entries and rejects traversal', () => {
    expect(validateArchiveEntry('./model/file.onnx')).toBe('model/file.onnx')
    expect(validateArchiveEntry('model/')).toBe('model')
    expect(() => validateArchiveEntry('../outside')).toThrow(/Unsafe Sherpa archive entry/)
    expect(() => validateArchiveEntry('model/./outside')).toThrow(/Unsafe Sherpa archive entry/)
    expect(() => validateArchiveEntry('C:/outside')).toThrow(/Unsafe Sherpa archive entry/)
    expect(() => validateArchiveEntry('/outside')).toThrow(/Unsafe Sherpa archive entry/)
  })

  it('reports an uninstalled pack without touching the network', async () => {
    const status = await readSherpaPackStatus(root, SHERPA_PIPER_PACK)
    expect(status.installed).toBe(false)
    expect(status.verified).toBe(false)
    expect(status.files[0]).toMatchObject({
      path: SHERPA_PIPER_PACK.archive.fileName,
      state: 'missing',
      expectedBytes: SHERPA_PIPER_PACK.archive.size,
    })
    expect(status.sourceSha256).toBe(SHERPA_PIPER_PACK.archive.sha256)
  })
})
