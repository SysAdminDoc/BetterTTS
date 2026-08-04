import { Download } from 'lucide-react'
import { useMemo, useState } from 'react'
import { LIBRARY_MAX_BYTES, type ClipRecord, type ClipSnapshot } from '../lib/library.ts'
import {
  DEFAULT_LIBRARY_FILTERS,
  DEFAULT_LIBRARY_SORT,
  libraryEngineId,
  libraryEngineLabel,
  selectLibraryClips,
  summarizeLibraryStorage,
  type LibraryCueFilter,
  type LibrarySort,
} from '../lib/library-view.ts'
import type { ProvenanceReplayContext } from '../lib/provenance.ts'
import { LibraryClipRow, type LibraryClipRowProps, type LibraryNotice } from './LibraryClipRow.tsx'
import { LibraryViewControls } from './LibraryViewControls.tsx'

type LibraryPanelProps = {
  active: boolean
  library: ClipRecord[]
  onClear: () => void | Promise<void>
  onClipDeleted: (snapshot: ClipSnapshot) => void
  onNotice: (notice: LibraryNotice) => void
  replayContext?: ProvenanceReplayContext
  playbackAudio: LibraryClipRowProps['playbackAudio']
}

export function LibraryPanel({ active, library, onClear, onClipDeleted, onNotice, replayContext, playbackAudio }: LibraryPanelProps) {
  const [filters, setFilters] = useState(DEFAULT_LIBRARY_FILTERS)
  const [sort, setSort] = useState<LibrarySort>(DEFAULT_LIBRARY_SORT)
  const filteredLibrary = useMemo(() => selectLibraryClips(library, filters, sort), [filters, library, sort])
  const storage = useMemo(() => summarizeLibraryStorage(library, LIBRARY_MAX_BYTES), [library])
  const voices = useMemo(() => [...new Set(library.map((clip) => clip.voice))].sort((left, right) => left.localeCompare(right)), [library])
  const engines = useMemo(
    () => [...new Set(library.map(libraryEngineId))].sort((left, right) => libraryEngineLabel(left).localeCompare(libraryEngineLabel(right))),
    [library],
  )

  return (
    <section className={`output-panel library-panel workspace-panel ${active ? 'active' : ''}`} id="library-panel" role="tabpanel" aria-labelledby="library-panel-tab library-heading" tabIndex={-1}>
      <div className="section-heading library-heading">
        <div>
          <h3 id="library-heading">Clip library ({library.length})</h3>
          <small className="library-filter-status" role="status" aria-live="polite">
            {filteredLibrary.length} of {library.length} clip{library.length === 1 ? '' : 's'} shown
          </small>
        </div>
        <button type="button" className="heading-action" onClick={onClear} disabled={library.length === 0}>
          Clear library
        </button>
      </div>
      <LibraryViewControls
        storage={storage}
        totalCount={library.length}
        visibleCount={filteredLibrary.length}
        query={filters.query}
        voice={filters.voice}
        engine={filters.engine}
        cues={filters.cues}
        sort={sort}
        voices={voices}
        engines={engines}
        onQueryChange={(query) => setFilters((current) => ({ ...current, query }))}
        onVoiceChange={(voice) => setFilters((current) => ({ ...current, voice }))}
        onEngineChange={(engine) => setFilters((current) => ({ ...current, engine }))}
        onCuesChange={(cues: LibraryCueFilter) => setFilters((current) => ({ ...current, cues }))}
        onSortChange={setSort}
      />
      {library.length === 0 ? (
        <div className="compact-empty">
          <Download size={28} aria-hidden="true" />
          <strong>No saved clips</strong>
          <span>Generated clips saved on this device appear here with playback and export controls.</span>
        </div>
      ) : filteredLibrary.length === 0 ? (
        <div className="compact-empty library-no-match">
          <Download size={28} aria-hidden="true" />
          <strong>No clips match these filters</strong>
          <span>Try a different search, voice, engine, or cue filter.</span>
          <button type="button" onClick={() => { setFilters(DEFAULT_LIBRARY_FILTERS); setSort(DEFAULT_LIBRARY_SORT) }}>
            Clear filters
          </button>
        </div>
      ) : (
        <ul className="result-list" aria-label="Saved clips">
          {filteredLibrary.map((clip) => (
            <li key={clip.id}>
              <LibraryClipRow
                clip={clip}
                playbackAudio={playbackAudio}
                onDeleted={onClipDeleted}
                onNotice={onNotice}
                replayContext={replayContext}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
