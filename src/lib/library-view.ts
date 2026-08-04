import type { ClipRecord } from './library.ts'

export type LibraryCueFilter = 'all' | 'with-cues' | 'without-cues'
export type LibrarySort =
  | 'created-desc'
  | 'created-asc'
  | 'duration-desc'
  | 'duration-asc'
  | 'size-desc'
  | 'size-asc'

export type LibraryFilterState = {
  query: string
  voice: string
  engine: string
  cues: LibraryCueFilter
}

export type LibraryStorageSummary = {
  clipCount: number
  totalBytes: number
  capBytes: number
  remainingBytes: number
  percentUsed: number
  overCap: boolean
  oldestClipId: string | null
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilterState = {
  query: '',
  voice: 'all',
  engine: 'all',
  cues: 'all',
}

export const DEFAULT_LIBRARY_SORT: LibrarySort = 'created-desc'

export function libraryEngineId(clip: Pick<ClipRecord, 'engine' | 'generationProvenance'>): string {
  const id = clip.engine ?? clip.generationProvenance?.engine.id
  return typeof id === 'string' && id.trim() && id !== 'unknown' ? id : 'unknown'
}

export function libraryEngineLabel(engineId: string): string {
  const labels: Record<string, string> = {
    browser: 'Browser speech',
    chatterbox: 'Chatterbox',
    kitten: 'KittenTTS',
    kokoro: 'Kokoro',
    melo: 'MeloTTS',
    piper: 'Piper-plus',
    qwen: 'Qwen3-TTS',
    supertonic: 'Supertonic',
    unknown: 'Legacy / unknown',
  }
  return labels[engineId] ?? engineId
}

export function parseDurationSeconds(value: string): number | null {
  const input = value.trim().toLocaleLowerCase()
  if (!input) return null

  if (input.includes(':')) {
    const parts = input.split(':').map(Number)
    if (parts.some((part) => !Number.isFinite(part) || part < 0) || parts.length < 2 || parts.length > 3) return null
    if (parts.length === 2) return parts[0] * 60 + parts[1]
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  }

  const match = input.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/u)
  if (!match || match.slice(1).every((part) => part === undefined)) {
    const numeric = Number(input)
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null
  }
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2] ?? 0)
  const seconds = Number(match[3] ?? 0)
  return Number.isFinite(hours) && Number.isFinite(minutes) && Number.isFinite(seconds)
    ? hours * 3600 + minutes * 60 + seconds
    : null
}

function compareValues(left: number | null, right: number | null, direction: 1 | -1): number {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return (left - right) * direction
}

function compareClips(left: ClipRecord, right: ClipRecord, sort: LibrarySort): number {
  const [field, direction] = sort.split('-') as ['created' | 'duration' | 'size', 'asc' | 'desc']
  const multiplier = direction === 'asc' ? 1 : -1
  const leftValue = field === 'created'
    ? left.createdAt
    : field === 'size'
      ? left.size
      : parseDurationSeconds(left.duration)
  const rightValue = field === 'created'
    ? right.createdAt
    : field === 'size'
      ? right.size
      : parseDurationSeconds(right.duration)
  const result = compareValues(leftValue, rightValue, multiplier)
  if (result !== 0) return result
  return right.createdAt - left.createdAt || left.id.localeCompare(right.id)
}

export function selectLibraryClips(
  clips: readonly ClipRecord[],
  filters: LibraryFilterState = DEFAULT_LIBRARY_FILTERS,
  sort: LibrarySort = DEFAULT_LIBRARY_SORT,
): ClipRecord[] {
  const query = filters.query.trim().toLocaleLowerCase()
  return clips
    .filter((clip) => {
      if (query && !`${clip.label} ${clip.filename}`.toLocaleLowerCase().includes(query)) return false
      if (filters.voice !== 'all' && clip.voice !== filters.voice) return false
      if (filters.engine !== 'all' && libraryEngineId(clip) !== filters.engine) return false
      if (filters.cues === 'with-cues' && !clip.cues?.length) return false
      if (filters.cues === 'without-cues' && clip.cues?.length) return false
      return true
    })
    .slice()
    .sort((left, right) => compareClips(left, right, sort))
}

export function summarizeLibraryStorage(clips: readonly ClipRecord[], capBytes: number): LibraryStorageSummary {
  const totalBytes = clips.reduce((total, clip) => total + Math.max(0, Number.isFinite(clip.size) ? clip.size : 0), 0)
  const safeCap = Math.max(0, Number.isFinite(capBytes) ? capBytes : 0)
  const oldest = clips.slice().sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0]
  return {
    clipCount: clips.length,
    totalBytes,
    capBytes: safeCap,
    remainingBytes: Math.max(0, safeCap - totalBytes),
    percentUsed: safeCap > 0 ? Math.min(100, (totalBytes / safeCap) * 100) : totalBytes > 0 ? 100 : 0,
    overCap: totalBytes > safeCap,
    oldestClipId: oldest?.id ?? null,
  }
}
