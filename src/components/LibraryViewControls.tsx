import { formatBytes } from '../lib/text.ts'
import { libraryEngineLabel, type LibraryCueFilter, type LibrarySort, type LibraryStorageSummary } from '../lib/library-view.ts'

type LibraryViewControlsProps = {
  storage: LibraryStorageSummary
  totalCount: number
  visibleCount: number
  query: string
  voice: string
  engine: string
  cues: LibraryCueFilter
  sort: LibrarySort
  voices: string[]
  engines: string[]
  onQueryChange: (value: string) => void
  onVoiceChange: (value: string) => void
  onEngineChange: (value: string) => void
  onCuesChange: (value: LibraryCueFilter) => void
  onSortChange: (value: LibrarySort) => void
}

export function LibraryViewControls({
  storage,
  totalCount,
  visibleCount,
  query,
  voice,
  engine,
  cues,
  sort,
  voices,
  engines,
  onQueryChange,
  onVoiceChange,
  onEngineChange,
  onCuesChange,
  onSortChange,
}: LibraryViewControlsProps) {
  return (
    <>
      <div className="library-storage-card" aria-label="Library storage usage">
        <div className="library-storage-heading">
          <strong>Clip storage</strong>
          <span>{formatBytes(storage.totalBytes)} / {formatBytes(storage.capBytes)}</span>
        </div>
        <div
          className="library-storage-bar"
          role="progressbar"
          aria-label="Clip library storage used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(storage.percentUsed)}
        >
          <span style={{ width: `${storage.percentUsed}%` }} />
        </div>
        <small>
          {storage.overCap
            ? 'Over the 200 MB cap. The oldest saved clips are evicted first after a new save.'
            : `${formatBytes(storage.remainingBytes)} available. New saves evict the oldest clips if this cap is exceeded.`}
        </small>
      </div>
      <div className="library-toolbar" role="search" aria-label="Search and filter saved clips">
        <label className="library-search-field">
          <span>Search saved clips</span>
          <input
            type="search"
            aria-label="Search saved clips"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Label or filename"
          />
        </label>
        <label>
          <span>Voice</span>
          <select aria-label="Filter saved clips by voice" value={voice} onChange={(event) => onVoiceChange(event.target.value)}>
            <option value="all">All voices</option>
            {voices.map((option) => <option value={option} key={option}>{option}</option>)}
          </select>
        </label>
        <label>
          <span>Engine</span>
          <select aria-label="Filter saved clips by engine" value={engine} onChange={(event) => onEngineChange(event.target.value)}>
            <option value="all">All engines</option>
            {engines.map((option) => <option value={option} key={option}>{libraryEngineLabel(option)}</option>)}
          </select>
        </label>
        <label>
          <span>Cues</span>
          <select aria-label="Filter saved clips by cue state" value={cues} onChange={(event) => onCuesChange(event.target.value as LibraryCueFilter)}>
            <option value="all">Any cue state</option>
            <option value="with-cues">Has cues</option>
            <option value="without-cues">No cues</option>
          </select>
        </label>
        <label>
          <span>Sort</span>
          <select aria-label="Sort saved clips" value={sort} onChange={(event) => onSortChange(event.target.value as LibrarySort)}>
            <option value="created-desc">Newest first</option>
            <option value="created-asc">Oldest first</option>
            <option value="duration-desc">Longest first</option>
            <option value="duration-asc">Shortest first</option>
            <option value="size-desc">Largest first</option>
            <option value="size-asc">Smallest first</option>
          </select>
        </label>
      </div>
      <small className="sr-only">Showing {visibleCount} of {totalCount} saved clips.</small>
    </>
  )
}
