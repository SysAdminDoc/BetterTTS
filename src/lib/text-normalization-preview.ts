import {
  applyPunctuationPauses,
  type CleanupOptions,
  cleanupText,
  DEFAULT_PUNCTUATION_PAUSES,
  reflowPdfText,
  type PunctuationPauseSettings,
} from './text.ts'

export type TextNormalizationRuleId = keyof CleanupOptions | 'pauses'

export type TextNormalizationDiffGroup = {
  id: TextNormalizationRuleId
  label: string
  before: string
  after: string
}

export type TextNormalizationPreview = {
  input: string
  output: string
  groups: TextNormalizationDiffGroup[]
  changed: boolean
  emptyOutput: boolean
}

const RULE_IDS = ['markdown', 'metadata', 'pageArtifacts', 'footnotes', 'urls', 'citations', 'numbers', 'acronyms', 'pdfReflow'] as const
const CLEANUP_DISABLED: CleanupOptions = {
  citations: false,
  urls: false,
  acronyms: false,
  markdown: false,
  footnotes: false,
  pageArtifacts: false,
  pdfReflow: false,
  numbers: false,
  metadata: false,
}

function ruleLabel(id: keyof CleanupOptions): string {
  if (id === 'metadata') return 'Book metadata'
  if (id === 'pageArtifacts') return 'Page artifacts'
  if (id === 'pdfReflow') return 'PDF line reflow'
  return id[0].toUpperCase() + id.slice(1)
}

/** Computes the ordered, reversible cleanup changes shown before synthesis. */
export function previewTextNormalization(
  input: string,
  options: CleanupOptions,
  punctuationPauses: PunctuationPauseSettings = DEFAULT_PUNCTUATION_PAUSES,
  context: { pdf?: boolean } = {},
): TextNormalizationPreview {
  let current = input
  const groups: TextNormalizationDiffGroup[] = []

  for (const ruleId of RULE_IDS) {
    if (!options[ruleId]) continue
    if (ruleId === 'pdfReflow') {
      if (!context.pdf) continue
      const next = reflowPdfText(current)
      if (next !== current) groups.push({ id: ruleId, label: ruleLabel(ruleId), before: current, after: next })
      current = next
      continue
    }
    const next = cleanupText(current, { ...CLEANUP_DISABLED, [ruleId]: true })
    if (next !== current) groups.push({ id: ruleId, label: ruleLabel(ruleId), before: current, after: next })
    current = next
  }

  if (Object.values(punctuationPauses).some((value) => Number.isFinite(value) && value > 0)) {
    const next = applyPunctuationPauses(current, punctuationPauses)
    if (next !== current) groups.push({ id: 'pauses', label: 'Punctuation pauses', before: current, after: next })
    current = next
  }

  return { input, output: current, groups, changed: current !== input, emptyOutput: !current.trim() }
}
