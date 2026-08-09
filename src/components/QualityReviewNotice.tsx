import { Info } from 'lucide-react'
import type { LongFormQualityIssue } from '../lib/long-form-quality.ts'

export function QualityReviewNotice({ issues }: { issues: readonly LongFormQualityIssue[] }) {
  const codes = [...new Set(issues.map((issue) => issue.code))].join(', ')
  return (
    <div className="capability-strip warn" role="status">
      <Info size={15} aria-hidden="true" />
      <span>Needs review: {codes}. Audio is available, but inspect this output before sharing.</span>
    </div>
  )
}
