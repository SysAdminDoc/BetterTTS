import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  extractInspectedZipEntries,
  inspectZipArchive,
  type ArchiveBudget,
} from './archive-budget.ts'

const budget: ArchiveBudget = {
  maxArchiveBytes: 1024 * 1024,
  maxEntries: 4,
  maxEntryBytes: 128,
  maxTotalBytes: 160,
  maxCompressionRatio: 20,
}

describe('archive budgets', () => {
  it('rejects entry-count and cumulative inflated-size overruns before extraction', () => {
    const tooMany = zipSync({
      '1.txt': new Uint8Array([1]),
      '2.txt': new Uint8Array([2]),
      '3.txt': new Uint8Array([3]),
      '4.txt': new Uint8Array([4]),
      '5.txt': new Uint8Array([5]),
    }, { level: 0 })
    expect(() => inspectZipArchive(tooMany, budget, 'Test ZIP')).toThrow('entry limit')

    const cumulative = zipSync({
      'a.bin': new Uint8Array(90),
      'b.bin': new Uint8Array(90),
    }, { level: 0 })
    const entries = inspectZipArchive(cumulative, budget, 'Test ZIP')
    expect(() => extractInspectedZipEntries(
      cumulative,
      entries,
      new Set(['a.bin', 'b.bin']),
      budget,
      'Test ZIP',
    )).toThrow('cumulative inflated-size')
  })

  it('rejects high-ratio selected entries and unsafe archive paths', () => {
    const compressed = zipSync({ 'bomb.txt': new Uint8Array(10_000) }, { level: 9 })
    const entries = inspectZipArchive(compressed, { ...budget, maxEntryBytes: 20_000, maxTotalBytes: 20_000 }, 'Test ZIP')
    expect(() => extractInspectedZipEntries(
      compressed,
      entries,
      new Set(['bomb.txt']),
      { ...budget, maxEntryBytes: 20_000, maxTotalBytes: 20_000 },
      'Test ZIP',
    )).toThrow('compression-ratio')

    const traversal = zipSync({ '../outside.txt': new Uint8Array([1]) }, { level: 0 })
    expect(() => inspectZipArchive(traversal, budget, 'Test ZIP')).toThrow('unsafe archive path')
  })

  it('does not inflate or ratio-check an unselected media payload', () => {
    const archive = zipSync({
      'chapter.xhtml': new TextEncoder().encode('<p>Readable.</p>'),
      'media/unused.bin': new Uint8Array(50_000),
    }, { level: 9 })
    const widerBudget = { ...budget, maxEntryBytes: 100_000, maxTotalBytes: 100_000 }
    const entries = inspectZipArchive(archive, widerBudget, 'Test ZIP')
    const files = extractInspectedZipEntries(
      archive,
      entries,
      new Set(['chapter.xhtml']),
      widerBudget,
      'Test ZIP',
    )
    expect(Object.keys(files)).toEqual(['chapter.xhtml'])
  })
})
