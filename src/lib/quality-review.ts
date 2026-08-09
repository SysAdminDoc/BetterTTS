import type { LongFormQualityIssue, LongFormQualityIssueCode, LongFormQualityReview, LongFormQualityStoredReview } from './long-form-quality.ts'

export type { LongFormQualityStoredReview }

const QUALITY_ISSUE_CODES: readonly LongFormQualityIssueCode[] = [
  'empty-audio',
  'short-audio',
  'duration-mismatch',
  'clipped-output',
  'repeated-tail',
  'cue-mismatch',
  'alignment-drift',
  'pronunciation-failure',
]

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isQualityIssueCode(value: unknown): value is LongFormQualityIssueCode {
  return typeof value === 'string' && QUALITY_ISSUE_CODES.includes(value as LongFormQualityIssueCode)
}

function migrateQualityIssue(value: unknown): LongFormQualityIssue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const issue = value as Partial<LongFormQualityIssue>
  if (!isQualityIssueCode(issue.code) || (issue.severity !== 'warning' && issue.severity !== 'error') || typeof issue.message !== 'string' || !issue.message) return null
  const observed = issue.observed === undefined ? undefined : finite(issue.observed, Number.NaN)
  const expected = issue.expected === undefined ? undefined : finite(issue.expected, Number.NaN)
  if ((observed !== undefined && !Number.isFinite(observed)) || (expected !== undefined && !Number.isFinite(expected))) return null
  return {
    code: issue.code,
    severity: issue.severity,
    message: issue.message.slice(0, 500),
    ...(observed === undefined ? {} : { observed }),
    ...(expected === undefined ? {} : { expected }),
  }
}

export function migrateLongFormQualityReviews(value: unknown): LongFormQualityStoredReview[] | undefined {
  if (!Array.isArray(value)) return undefined
  const reviews = value.slice(0, 32).flatMap((entry): LongFormQualityStoredReview[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const review = entry as Partial<LongFormQualityStoredReview>
    if (review.scope !== 'segment' && review.scope !== 'job') return []
    const attempts = Number(review.attempts)
    const durationSeconds = Number(review.durationSeconds)
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 4 || !Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 86_400) return []
    const issues = Array.isArray(review.issues)
      ? review.issues.slice(0, 16).flatMap((issue) => {
          const migrated = migrateQualityIssue(issue)
          return migrated ? [migrated] : []
        })
      : []
    if (issues.length === 0) return []
    const verification = review.verification === 'verified' || review.verification === 'unavailable'
      ? review.verification
      : 'not-requested'
    const verificationError = typeof review.verificationError === 'string' && review.verificationError
      ? review.verificationError.slice(0, 500)
      : undefined
    return [{
      scope: review.scope,
      attempts,
      issues,
      durationSeconds,
      verification,
      ...(verificationError ? { verificationError } : {}),
    }]
  })
  return reviews.length > 0 ? reviews : undefined
}

export function qualityReviewsForStorage(reviews: readonly LongFormQualityReview[]): LongFormQualityStoredReview[] {
  return migrateLongFormQualityReviews(reviews) ?? []
}

export function summarizeQualityIssues(issues: readonly Pick<LongFormQualityIssue, 'code'>[]): string {
  return [...new Set(issues.map((issue) => issue.code))].join(', ')
}
