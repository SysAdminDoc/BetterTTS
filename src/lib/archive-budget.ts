import { unzipSync, type UnzipFileInfo } from 'fflate'

export type ArchiveBudget = {
  maxArchiveBytes: number
  maxEntries: number
  maxEntryBytes: number
  maxTotalBytes: number
  maxCompressionRatio: number
}

export type ArchiveEntry = {
  name: string
  normalizedName: string
  compressedBytes: number
  originalBytes: number
}

export class ArchiveBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveBudgetError'
  }
}

export function normalizeArchivePath(path: string): string {
  return path.replace(/^\/+/, '')
}

function validateEntryPath(name: string, label: string): string {
  const normalized = normalizeArchivePath(name)
  const parts = normalized.split('/')
  if (!normalized || name.includes('\\') || parts.some((part) => part === '.' || part === '..')) {
    throw new ArchiveBudgetError(`${label} contains an unsafe archive path: ${name || '(empty)'}.`)
  }
  return normalized
}

function toArchiveEntry(entry: UnzipFileInfo, label: string): ArchiveEntry {
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
    throw new ArchiveBudgetError(`${label} contains invalid ZIP size metadata for ${entry.name}.`)
  }
  return {
    name: entry.name,
    normalizedName: validateEntryPath(entry.name, label),
    compressedBytes: entry.size,
    originalBytes: entry.originalSize,
  }
}

export function inspectZipArchive(source: Uint8Array, budget: ArchiveBudget, label: string): ArchiveEntry[] {
  if (source.byteLength > budget.maxArchiveBytes) {
    throw new ArchiveBudgetError(`${label} archive is larger than the compressed-size limit.`)
  }

  const entries: ArchiveEntry[] = []
  unzipSync(source, {
    filter: (entry) => {
      entries.push(toArchiveEntry(entry, label))
      if (entries.length > budget.maxEntries) {
        throw new ArchiveBudgetError(`${label} exceeds the ${budget.maxEntries}-entry limit.`)
      }
      return false
    },
  })

  const paths = new Set<string>()
  for (const entry of entries) {
    if (paths.has(entry.normalizedName)) {
      throw new ArchiveBudgetError(`${label} contains a duplicate archive path: ${entry.normalizedName}.`)
    }
    paths.add(entry.normalizedName)
  }
  return entries
}

export function extractInspectedZipEntries(
  source: Uint8Array,
  entries: ArchiveEntry[],
  includedNames: ReadonlySet<string>,
  budget: ArchiveBudget,
  label: string,
): Record<string, Uint8Array> {
  const selected = entries.filter((entry) => includedNames.has(entry.normalizedName))
  if (selected.length > budget.maxEntries) {
    throw new ArchiveBudgetError(`${label} exceeds the ${budget.maxEntries}-entry extraction limit.`)
  }

  let totalBytes = 0
  for (const entry of selected) {
    if (entry.originalBytes > budget.maxEntryBytes) {
      throw new ArchiveBudgetError(`${label} entry ${entry.normalizedName} exceeds the per-entry inflated-size limit.`)
    }
    totalBytes += entry.originalBytes
    if (!Number.isSafeInteger(totalBytes) || totalBytes > budget.maxTotalBytes) {
      throw new ArchiveBudgetError(`${label} exceeds the cumulative inflated-size limit.`)
    }
    const ratio = entry.originalBytes === 0
      ? 1
      : entry.compressedBytes === 0
        ? Number.POSITIVE_INFINITY
        : entry.originalBytes / entry.compressedBytes
    if (ratio > budget.maxCompressionRatio) {
      throw new ArchiveBudgetError(`${label} entry ${entry.normalizedName} exceeds the compression-ratio limit.`)
    }
  }

  if (selected.length === 0) return {}
  const extracted = unzipSync(source, {
    filter: (entry) => includedNames.has(normalizeArchivePath(entry.name)),
  })
  const files: Record<string, Uint8Array> = {}
  for (const [name, bytes] of Object.entries(extracted)) {
    files[normalizeArchivePath(name)] = bytes
  }
  return files
}

export function assertArchivePayloadSizes(
  sizes: readonly number[],
  budget: Pick<ArchiveBudget, 'maxEntries' | 'maxEntryBytes' | 'maxTotalBytes'>,
  label: string,
): void {
  if (sizes.length > budget.maxEntries) {
    throw new ArchiveBudgetError(`${label} exceeds the ${budget.maxEntries}-entry limit.`)
  }
  let totalBytes = 0
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0 || size > budget.maxEntryBytes) {
      throw new ArchiveBudgetError(`${label} contains an entry larger than the allowed payload limit.`)
    }
    totalBytes += size
    if (!Number.isSafeInteger(totalBytes) || totalBytes > budget.maxTotalBytes) {
      throw new ArchiveBudgetError(`${label} exceeds the cumulative payload-size limit.`)
    }
  }
}
