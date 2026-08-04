import type { CleanupOptions } from '../lib/text.ts'
import type { TextNormalizationPreview, TextNormalizationRuleId } from '../lib/text-normalization-preview.ts'
import type { ReaderSourceKind } from '../lib/reader.ts'

const NORMALIZATION_RULES = [
  { id: 'markdown', label: 'Markdown', hint: 'Remove formatting markers while keeping readable link text.' },
  { id: 'metadata', label: 'Book metadata', hint: 'Remove ISBN, DOI, and cataloging lines.' },
  { id: 'pageArtifacts', label: 'Page artifacts', hint: 'Remove repeated headers, footers, and page numbers.' },
  { id: 'footnotes', label: 'Footnotes', hint: 'Remove note markers and reference lines.' },
  { id: 'urls', label: 'URLs', hint: 'Replace web addresses with “link”.' },
  { id: 'citations', label: 'Citations', hint: 'Remove [12]-style reference markers.' },
  { id: 'numbers', label: 'Numbers', hint: 'Spell currency, decimals, units, and percentages.' },
  { id: 'acronyms', label: 'Acronyms', hint: 'Spell vowel-less acronyms letter by letter.' },
  { id: 'pdfReflow', label: 'PDF line reflow', hint: 'Join wrapped PDF lines and repair end-of-line hyphenation.' },
  { id: 'pauses', label: 'Punctuation pauses', hint: 'Insert the selected silence tags after punctuation.' },
] as const

export type NormalizationPreviewViewState = {
  sourceKind?: ReaderSourceKind
  options: CleanupOptions
  includePauses: boolean
  preview: TextNormalizationPreview
}

type NormalizationPreviewProps = {
  state: NormalizationPreviewViewState
  undoAvailable: boolean
  onRuleToggle: (id: TextNormalizationRuleId, enabled: boolean) => void
  onApply: () => void
  onClose: () => void
  onUndo: () => void
}

function compactNormalizationText(value: string, max = 240): string {
  const normalized = value.replace(/\r\n?/g, '\n')
  if (normalized.length <= max) return normalized
  const side = Math.max(24, Math.floor((max - 5) / 2))
  return `${normalized.slice(0, side).trimEnd()} … ${normalized.slice(-side).trimStart()}`
}

export function NormalizationPreview({ state, undoAvailable, onRuleToggle, onApply, onClose, onUndo }: NormalizationPreviewProps) {
  return (
    <section className="normalization-preview" aria-label="Text normalization preview">
      <div className="normalization-preview-heading">
        <div>
          <h3>Text normalization preview</h3>
          <small>Review the reversible before/after changes. Generated audio records the exact applied text snapshot.</small>
        </div>
        <span className="normalization-count" role="status">
          {state.preview.groups.length} change{state.preview.groups.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="normalization-rule-list" role="group" aria-label="Normalization rules">
        {NORMALIZATION_RULES
          .filter((rule) => rule.id !== 'pdfReflow' || state.sourceKind === 'pdf')
          .map((rule) => {
            const enabled = rule.id === 'pauses' ? state.includePauses : state.options[rule.id]
            const group = state.preview.groups.find((candidate) => candidate.id === rule.id)
            return (
              <label className="normalization-rule" key={rule.id} htmlFor={`normalization-rule-${rule.id}`}>
                <input
                  id={`normalization-rule-${rule.id}`}
                  type="checkbox"
                  aria-label={`Enable ${rule.label} normalization`}
                  checked={enabled}
                  onChange={(event) => onRuleToggle(rule.id, event.target.checked)}
                />
                <span>
                  <strong>{rule.label}</strong>
                  <small>{group ? 'Changes shown below.' : rule.hint}</small>
                </span>
              </label>
            )
          })}
      </div>
      {state.preview.groups.length > 0 ? (
        <div className="normalization-diff-list" aria-label="Normalization changes">
          {state.preview.groups.map((group) => (
            <article className="normalization-diff" key={group.id}>
              <strong>{group.label}</strong>
              <div className="normalization-diff-columns">
                <div>
                  <span>Before</span>
                  <del>{compactNormalizationText(group.before)}</del>
                </div>
                <div>
                  <span>After</span>
                  <ins>{compactNormalizationText(group.after)}</ins>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="normalization-empty" role="status">No selected rules change this text.</p>
      )}
      {state.preview.emptyOutput ? (
        <p className="normalization-warning" role="alert">The selected rules remove all text. Turn off a rule or restore the original before applying.</p>
      ) : null}
      <div className="normalization-preview-actions">
        <button type="button" className="primary-action" onClick={onApply} disabled={!state.preview.changed || state.preview.emptyOutput}>Apply normalization</button>
        <button type="button" onClick={onClose}>Close preview</button>
        {undoAvailable ? <button type="button" onClick={onUndo}>Undo last apply</button> : null}
      </div>
    </section>
  )
}
