import { formatMixFormula, type VoiceMixEntry } from '../lib/voice-mix.ts'
import type { EpubMappingChapter, EpubMappingVoiceMixEntry } from '../lib/epub-mapping.ts'
import './EpubMappingPanel.css'

export type EpubMappingVoiceOption = {
  id: string
  name: string
  gender?: string
}

export type EpubMappingPanelProps = {
  title: string
  chapters: readonly EpubMappingChapter[]
  defaultVoiceLabel: string
  voiceOptions: readonly EpubMappingVoiceOption[]
  blendVoiceOptions: readonly EpubMappingVoiceOption[]
  defaultMix: readonly EpubMappingVoiceMixEntry[]
  supportsVoice: boolean
  supportsBlend: boolean
  onRename: (chapterId: string, title: string) => void
  onInclude: (chapterId: string, included: boolean) => void
  onVoice: (chapterId: string, voice: string | undefined) => void
  onBlend: (chapterId: string, enabled: boolean) => void
  onMixVoice: (chapterId: string, entryIndex: number, voiceId: string) => void
  onMixWeight: (chapterId: string, entryIndex: number, weight: number) => void
  onAddMix: (chapterId: string) => void
  onRemoveMix: (chapterId: string, entryIndex: number) => void
  onSplit: (chapterId: string) => void
  onMerge: (chapterId: string) => void
  onMove: (chapterId: string, delta: -1 | 1) => void
  onQueue: () => void
  onQueueDefaults: () => void
  onCancel: () => void
}

export function EpubMappingPanel({
  title,
  chapters,
  defaultVoiceLabel,
  voiceOptions,
  blendVoiceOptions,
  defaultMix,
  supportsVoice,
  supportsBlend,
  onRename,
  onInclude,
  onVoice,
  onBlend,
  onMixVoice,
  onMixWeight,
  onAddMix,
  onRemoveMix,
  onSplit,
  onMerge,
  onMove,
  onQueue,
  onQueueDefaults,
  onCancel,
}: EpubMappingPanelProps) {
  const includedCount = chapters.filter((chapter) => chapter.included).length
  const blendOptions = blendVoiceOptions.length > 0 ? blendVoiceOptions : voiceOptions
  return (
    <section className="epub-mapping-panel" aria-labelledby="epub-mapping-heading">
      <div className="section-heading">
        <div>
          <h2 id="epub-mapping-heading">Review EPUB chapters</h2>
          <p className="section-kicker">{title} · {includedCount} of {chapters.length} included</p>
        </div>
        <span>Before queueing</span>
      </div>
      <p className="epub-mapping-intro">
        Confirm the reading order, chapter names, and voice assignments. Excluded chapters stay available here but will not enter the queue or any export.
      </p>
      <div className="epub-mapping-list">
        {chapters.map((chapter, index) => {
          const chapterLabel = `Chapter ${index + 1}`
          const hasBlend = Boolean(chapter.voiceMix?.length)
          return (
            <article className={chapter.included ? 'epub-mapping-row' : 'epub-mapping-row excluded'} key={chapter.id}>
              <div className="epub-mapping-row-head">
                <span className="epub-mapping-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <label className="epub-mapping-title-field">
                  <span className="sr-only">Title for {chapterLabel}</span>
                  <input
                    type="text"
                    value={chapter.title}
                    maxLength={500}
                    aria-label={`Title for ${chapterLabel}`}
                    onChange={(event) => onRename(chapter.id, event.target.value)}
                  />
                </label>
                <span className="epub-mapping-size">{chapter.text.length.toLocaleString()} chars</span>
              </div>
              <div className="epub-mapping-row-controls">
                <label className="check-label epub-mapping-include">
                  <input
                    type="checkbox"
                    checked={chapter.included}
                    aria-label={`Include ${chapterLabel}`}
                    onChange={(event) => onInclude(chapter.id, event.target.checked)}
                  />
                  Include
                </label>
                {supportsVoice ? (
                  <label className="epub-mapping-voice-field">
                    <span>Voice</span>
                    <select
                      value={chapter.voice ?? ''}
                      aria-label={`Voice for ${chapterLabel}`}
                      onChange={(event) => onVoice(chapter.id, event.target.value || undefined)}
                    >
                      <option value="">Default ({defaultVoiceLabel})</option>
                      {chapter.voice && !voiceOptions.some((voice) => voice.id === chapter.voice) ? <option value={chapter.voice}>{chapter.voice}</option> : null}
                      {voiceOptions.map((voice) => (
                        <option value={voice.id} key={voice.id}>{voice.name}{voice.gender ? ` (${voice.gender})` : ''}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span className="epub-mapping-engine-note">The selected engine uses one voice for the whole book.</span>
                )}
                {supportsBlend ? (
                  <label className="check-label epub-mapping-blend-toggle">
                    <input
                      type="checkbox"
                      checked={hasBlend}
                      aria-label={`Blend voices for ${chapterLabel}`}
                      onChange={(event) => onBlend(chapter.id, event.target.checked)}
                    />
                    Blend voices
                  </label>
                ) : null}
              </div>
              {supportsBlend && hasBlend ? (
                <div className="epub-mapping-mix" aria-label={`${chapterLabel} blend voices`}>
                  {chapter.voiceMix?.map((entry, entryIndex) => (
                    <div className="epub-mapping-mix-entry" key={`${chapter.id}-mix-${entryIndex}`}>
                      <select
                        value={entry.voiceId}
                        aria-label={`${chapterLabel} blend voice ${entryIndex + 1}`}
                        onChange={(event) => onMixVoice(chapter.id, entryIndex, event.target.value)}
                      >
                        {blendOptions.map((voice) => <option value={voice.id} key={voice.id}>{voice.name}</option>)}
                      </select>
                      <input
                        type="number"
                        min={0.05}
                        max={100}
                        step={0.05}
                        value={entry.weight}
                        aria-label={`${chapterLabel} blend weight ${entryIndex + 1}`}
                        onChange={(event) => onMixWeight(chapter.id, entryIndex, Math.max(0.05, Math.min(100, Number(event.target.value) || 1)))}
                      />
                      {chapter.voiceMix && chapter.voiceMix.length > 2 ? (
                        <button type="button" onClick={() => onRemoveMix(chapter.id, entryIndex)} aria-label={`Remove ${chapterLabel} blend voice ${entryIndex + 1}`}>×</button>
                      ) : null}
                    </div>
                  ))}
                  {chapter.voiceMix && chapter.voiceMix.length < 4 ? (
                    <button type="button" className="epub-mapping-add-mix" onClick={() => onAddMix(chapter.id)}>+ Add voice</button>
                  ) : null}
                  <small>{chapter.voiceMix && chapter.voiceMix.length > 0 ? formatMixFormula(chapter.voiceMix as VoiceMixEntry[]) : formatMixFormula(defaultMix as VoiceMixEntry[])}</small>
                </div>
              ) : null}
              <div className="epub-mapping-row-actions">
                <button type="button" onClick={() => onMove(chapter.id, -1)} disabled={index === 0} aria-label={`Move ${chapterLabel} up`}>↑</button>
                <button type="button" onClick={() => onMove(chapter.id, 1)} disabled={index === chapters.length - 1} aria-label={`Move ${chapterLabel} down`}>↓</button>
                <button type="button" onClick={() => onSplit(chapter.id)} disabled={!chapter.text.trim() || chapters.length >= 2_000}>Split</button>
                <button type="button" onClick={() => onMerge(chapter.id)} disabled={index === chapters.length - 1}>Merge next</button>
              </div>
            </article>
          )
        })}
      </div>
      <div className="epub-mapping-footer">
        <button type="button" className="subtle-button" onClick={onCancel}>Keep reading</button>
        <span className="epub-mapping-footer-spacer" />
        <button type="button" className="subtle-button" onClick={onQueueDefaults}>Queue with defaults</button>
        <button type="button" className="primary-button" onClick={onQueue} disabled={includedCount === 0}>Queue mapped EPUB</button>
      </div>
    </section>
  )
}
