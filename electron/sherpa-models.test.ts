import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readSherpaPackStatus,
  sherpaKokoroSpeakerId,
  sherpaModelPaths,
  SHERPA_KOKORO_PACK,
  SHERPA_MELO_PACK,
  SHERPA_PIPER_PACK,
  validateArchiveEntry,
  validateArchiveEntries,
  validateArchiveEntryType,
  validateArchiveListingTypes,
  recoverInterruptedSherpaExtraction,
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
    expect(() => validateSherpaModelPack(SHERPA_MELO_PACK)).not.toThrow()
    expect(() => validateSherpaModelPack(SHERPA_PIPER_PACK)).not.toThrow()

    const paths = sherpaModelPaths(root, SHERPA_KOKORO_PACK)
    expect(paths.model).toMatch(/model\.int8\.onnx$/)
    expect(paths.voices).toMatch(/voices\.bin$/)
    expect(paths.lexicon).toContain('lexicon-us-en.txt')
    expect(SHERPA_KOKORO_PACK.archive.sha256).toHaveLength(64)
    const meloPaths = sherpaModelPaths(root, SHERPA_MELO_PACK)
    expect(meloPaths.model).toMatch(/model\.onnx$/)
    expect(meloPaths.dataDir).toBeUndefined()
    expect(meloPaths.lexicon).toMatch(/lexicon\.txt$/)
    expect(SHERPA_MELO_PACK.archive.sha256).toHaveLength(64)
    expect(SHERPA_PIPER_PACK.archive.sha256).toHaveLength(64)
  })

  it('maps the existing Kokoro voice ids and falls back safely', () => {
    expect(sherpaKokoroSpeakerId('af_heart')).toBe(3)
    expect(sherpaKokoroSpeakerId('bm_lewis')).toBe(27)
    expect(sherpaKokoroSpeakerId('jf_alpha')).toBe(37)
    expect(sherpaKokoroSpeakerId('zm_yunyang')).toBe(52)
    expect(sherpaKokoroSpeakerId('unknown')).toBe(3)
  })

  it('normalizes safe tar entries and rejects traversal', () => {
    expect(validateArchiveEntry('./model/file.onnx')).toBe('model/file.onnx')
    expect(validateArchiveEntry('model/')).toBe('model')
    expect(() => validateArchiveEntry('../outside')).toThrow(/Unsafe Sherpa archive entry/)
    expect(() => validateArchiveEntry('model/./outside')).toThrow(/Unsafe Sherpa archive entry/)
    expect(() => validateArchiveEntry('C:/outside')).toThrow(/Unsafe Sherpa archive entry/)
    expect(() => validateArchiveEntry('/outside')).toThrow(/Unsafe Sherpa archive entry/)
    expect(() => validateArchiveEntry(`model/${'x'.repeat(4097)}`)).toThrow(/Unsafe Sherpa archive entry/)
    expect(() => validateArchiveEntry('model/\u0000unsafe')).toThrow(/Unsafe Sherpa archive entry/)
  })

  it('rejects duplicate entries after archive path normalization and Windows case folding', () => {
    expect(() => validateArchiveEntries(['model/file.onnx', './model/file.onnx'])).toThrow(/Duplicate Sherpa archive entry/)
    expect(() => validateArchiveEntries(['model/File.onnx', 'model/file.onnx'])).toThrow(/Duplicate Sherpa archive entry/)
  })

  it('permits only regular files and directories in verbose tar listings', () => {
    expect(validateArchiveEntryType('-rw-r--r-- 0/0 10 2026-08-08 12:00 model/file.onnx')).toBe('file')
    expect(validateArchiveEntryType('drwxr-xr-x 0/0 0 2026-08-08 12:00 model')).toBe('directory')
    for (const type of ['lrwxrwxrwx', 'hrw-r--r--', 'crw-r--r--', 'prw-r--r--', 'srwxr-xr-x']) {
      expect(() => validateArchiveEntryType(`${type} 0/0 0 2026-08-08 12:00 model/unsafe`)).toThrow(/Unsupported Sherpa archive entry type/)
    }
  })

  it('rejects verbose archive listings whose entry count changes between preflight passes', () => {
    const file = '-rw-r--r-- 0/0 10 2026-08-08 12:00 model/file.onnx'
    expect(() => validateArchiveListingTypes(file, 2)).toThrow(/listing mismatch/)
    expect(() => validateArchiveListingTypes(`${file}\n${file}`, 2)).not.toThrow()
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

  it('recovers a previous model when staging was interrupted before the swap', () => {
    const packDir = join(root, 'sherpa-packs', `${SHERPA_PIPER_PACK.id}@${SHERPA_PIPER_PACK.revision.slice(0, 12)}`)
    mkdirSync(join(packDir, 'model.previous'), { recursive: true })
    writeFileSync(join(packDir, 'model.previous', 'tokens.txt'), 'restored')
    mkdirSync(join(packDir, '.extract-crashed'), { recursive: true })
    mkdirSync(join(packDir, 'model.staged'), { recursive: true })

    recoverInterruptedSherpaExtraction(root, SHERPA_PIPER_PACK)

    expect(existsSync(join(packDir, 'model', 'tokens.txt'))).toBe(true)
    expect(existsSync(join(packDir, 'model.previous'))).toBe(false)
    expect(existsSync(join(packDir, 'model.staged'))).toBe(false)
    expect(existsSync(join(packDir, '.extract-crashed'))).toBe(false)
  })
})
