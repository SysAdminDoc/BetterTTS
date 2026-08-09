export type LongFormQualityIssueCode =
  | 'empty-audio'
  | 'short-audio'
  | 'duration-mismatch'
  | 'clipped-output'
  | 'repeated-tail'
  | 'cue-mismatch'
  | 'alignment-drift'
  | 'pronunciation-failure'

export type LongFormQualityIssue = {
  code: LongFormQualityIssueCode
  severity: 'warning' | 'error'
  message: string
  observed?: number
  expected?: number
}

export type LongFormQualityCue = {
  startSec: number
  endSec: number
  text: string
}

export type LongFormQualityTranscript = {
  text: string
  cues?: readonly LongFormQualityCue[]
  confidence?: number
}

export type LongFormQualityTranscribe = (
  samples: Float32Array,
  sampleRate: number,
  signal?: AbortSignal,
) => Promise<LongFormQualityTranscript>

export type LongFormQualityOptions = {
  enabled?: boolean
  maxRetries?: number
  transcriptionScope?: 'segment' | 'job'
  transcribe?: LongFormQualityTranscribe
  durationToleranceSeconds?: number
  minSpeakableChars?: number
  maxCharsPerSecond?: number
  clipThreshold?: number
  clipRatio?: number
  repeatedTailWindowSeconds?: number
  repeatedTailSimilarity?: number
  cueToleranceSeconds?: number
  alignmentDriftRatio?: number
  maxWordErrorRate?: number
}

export type LongFormQualityInput = {
  text: string
  samples: Float32Array
  sampleRate: number
  speed: number
  expectedDurationSeconds?: number
  cues?: readonly LongFormQualityCue[]
  signal?: AbortSignal
}

export type LongFormQualityAssessment = {
  status: 'pass' | 'needs-review'
  verification: 'not-requested' | 'verified' | 'unavailable'
  issues: LongFormQualityIssue[]
  durationSeconds: number
  peak: number
  clippedRatio: number
  wordErrorRate?: number
  verificationError?: string
}

export type LongFormQualityReview = {
  scope: 'segment' | 'job'
  text: string
  attempts: number
  issues: LongFormQualityIssue[]
  durationSeconds: number
  verification: LongFormQualityAssessment['verification']
  verificationError?: string
}

/** Persisted review metadata intentionally omits source text. */
export type LongFormQualityStoredReview = Omit<LongFormQualityReview, 'text'>

export { migrateLongFormQualityReviews, qualityReviewsForStorage, summarizeQualityIssues } from './quality-review.ts'

const DEFAULT_DURATION_TOLERANCE_SECONDS = 0.18
const DEFAULT_MIN_SPEAKABLE_CHARS = 24
const DEFAULT_MAX_CHARS_PER_SECOND = 45
const DEFAULT_CLIP_THRESHOLD = 0.9995
const DEFAULT_CLIP_RATIO = 0.005
const DEFAULT_REPEATED_TAIL_WINDOW_SECONDS = 0.35
const DEFAULT_REPEATED_TAIL_SIMILARITY = 0.995
const DEFAULT_CUE_TOLERANCE_SECONDS = 0.12
const DEFAULT_ALIGNMENT_DRIFT_RATIO = 0.25
const DEFAULT_MAX_WORD_ERROR_RATE = 0.35

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, finite(value, fallback)))
}

export function qualityRetryCount(options: Pick<LongFormQualityOptions, 'maxRetries'> | undefined): number {
  return Math.round(bounded(options?.maxRetries, 0, 0, 3))
}

export function qualityWords(text: string): string[] {
  return text
    .replace(/\[[^\]]*\]/gu, ' ')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []
}

function speakableCharacterCount(text: string): number {
  return (text.replace(/\[[^\]]*\]/gu, '').match(/[\p{L}\p{N}\p{M}]/gu) ?? []).length
}

function addIssue(
  issues: LongFormQualityIssue[],
  code: LongFormQualityIssueCode,
  message: string,
  observed?: number,
  expected?: number,
  severity: LongFormQualityIssue['severity'] = 'warning',
) {
  issues.push({ code, severity, message, ...(observed === undefined ? {} : { observed }), ...(expected === undefined ? {} : { expected }) })
}

function waveformMetrics(samples: Float32Array, clipThreshold: number): { peak: number; clippedRatio: number; finite: boolean } {
  let peak = 0
  let clipped = 0
  let finiteSamples = 0
  for (const sample of samples) {
    if (!Number.isFinite(sample)) continue
    finiteSamples += 1
    const absolute = Math.abs(sample)
    peak = Math.max(peak, absolute)
    if (absolute >= clipThreshold) clipped += 1
  }
  return { peak, clippedRatio: samples.length > 0 ? clipped / samples.length : 0, finite: finiteSamples === samples.length }
}

function repeatedTailSimilarity(samples: Float32Array, sampleRate: number, windowSeconds: number): number | null {
  const windowSamples = Math.round(sampleRate * windowSeconds)
  if (!Number.isFinite(windowSamples) || windowSamples < 8 || samples.length < windowSamples * 2) return null
  const previousStart = samples.length - windowSamples * 2
  const tailStart = samples.length - windowSamples
  let sumSquares = 0
  let sumErrorSquares = 0
  for (let index = 0; index < windowSamples; index += 1) {
    const previous = samples[previousStart + index]
    const tail = samples[tailStart + index]
    if (!Number.isFinite(previous) || !Number.isFinite(tail)) return null
    sumSquares += previous * previous + tail * tail
    const difference = previous - tail
    sumErrorSquares += difference * difference
  }
  const scale = Math.sqrt(sumSquares / (windowSamples * 2))
  if (scale < 0.01) return null
  return 1 - Math.sqrt(sumErrorSquares / windowSamples) / scale
}

function wordErrorRate(source: readonly string[], transcript: readonly string[]): number {
  if (source.length === 0) return transcript.length === 0 ? 0 : 1
  let previous = Array.from({ length: transcript.length + 1 }, (_, index) => index)
  for (let row = 1; row <= source.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= transcript.length; column += 1) {
      current[column] = source[row - 1] === transcript[column - 1]
        ? previous[column - 1]
        : 1 + Math.min(previous[column - 1], previous[column], current[column - 1])
    }
    previous = current
  }
  return previous[transcript.length] / Math.max(1, source.length)
}

function inspectCues(
  cues: readonly LongFormQualityCue[],
  durationSeconds: number,
  options: Required<Pick<LongFormQualityOptions, 'cueToleranceSeconds' | 'alignmentDriftRatio'>>,
  issues: LongFormQualityIssue[],
) {
  const tolerance = options.cueToleranceSeconds
  let previousEnd = 0
  let invalid = false
  for (const cue of cues) {
    if (!Number.isFinite(cue.startSec) || !Number.isFinite(cue.endSec) || cue.startSec < -tolerance || cue.endSec <= cue.startSec || cue.startSec < previousEnd - tolerance || cue.endSec > durationSeconds + tolerance) {
      invalid = true
      break
    }
    previousEnd = cue.endSec
  }
  if (invalid) {
    addIssue(issues, 'cue-mismatch', 'Generated timing cues are invalid, overlap, or extend beyond the audio duration.', undefined, durationSeconds, 'error')
    return
  }
  if (cues.length === 0 || durationSeconds <= 0) return
  const firstGap = Math.max(0, cues[0].startSec)
  const lastGap = Math.max(0, durationSeconds - cues[cues.length - 1].endSec)
  const maximumDrift = Math.max(tolerance * 4, durationSeconds * options.alignmentDriftRatio)
  if (firstGap > maximumDrift || lastGap > maximumDrift) {
    addIssue(issues, 'alignment-drift', `Timing cues leave an unexplained ${Math.max(firstGap, lastGap).toFixed(2)}s edge gap.`, Math.max(firstGap, lastGap), maximumDrift)
  }
}

export async function evaluateLongFormQuality(
  input: LongFormQualityInput,
  options: LongFormQualityOptions = {},
): Promise<LongFormQualityAssessment> {
  const durationSeconds = input.sampleRate > 0 ? input.samples.length / input.sampleRate : 0
  if (options.enabled !== true) return { status: 'pass', verification: 'not-requested', issues: [], durationSeconds, peak: 0, clippedRatio: 0 }

  const issues: LongFormQualityIssue[] = []
  const tolerance = bounded(options.durationToleranceSeconds, DEFAULT_DURATION_TOLERANCE_SECONDS, 0.03, 10)
  const minSpeakableChars = Math.round(bounded(options.minSpeakableChars, DEFAULT_MIN_SPEAKABLE_CHARS, 1, 10_000))
  const maxCharsPerSecond = bounded(options.maxCharsPerSecond, DEFAULT_MAX_CHARS_PER_SECOND, 5, 200)
  const clipThreshold = bounded(options.clipThreshold, DEFAULT_CLIP_THRESHOLD, 0.8, 1)
  const clipRatio = bounded(options.clipRatio, DEFAULT_CLIP_RATIO, 0.0001, 1)
  const repeatedWindow = bounded(options.repeatedTailWindowSeconds, DEFAULT_REPEATED_TAIL_WINDOW_SECONDS, 0.05, 10)
  const repeatedSimilarity = bounded(options.repeatedTailSimilarity, DEFAULT_REPEATED_TAIL_SIMILARITY, 0.8, 1)
  const cueTolerance = bounded(options.cueToleranceSeconds, DEFAULT_CUE_TOLERANCE_SECONDS, 0.01, 10)
  const driftRatio = bounded(options.alignmentDriftRatio, DEFAULT_ALIGNMENT_DRIFT_RATIO, 0.05, 0.8)
  const maxWordErrorRate = bounded(options.maxWordErrorRate, DEFAULT_MAX_WORD_ERROR_RATE, 0, 1)

  if (input.samples.length === 0 || durationSeconds <= 0) {
    addIssue(issues, 'empty-audio', 'The generated segment contains no audio samples.', durationSeconds, 0, 'error')
  }

  const metrics = waveformMetrics(input.samples, clipThreshold)
  if (!metrics.finite && input.samples.length > 0) {
    addIssue(issues, 'clipped-output', 'The generated waveform contains non-finite samples.', undefined, undefined, 'error')
  } else if (metrics.clippedRatio >= clipRatio) {
    addIssue(issues, 'clipped-output', `The waveform is clipped at ${Math.round(metrics.clippedRatio * 1000) / 10}% of samples.`, metrics.clippedRatio, clipRatio)
  }

  const speakableChars = speakableCharacterCount(input.text)
  const speed = bounded(input.speed, 1, 0.5, 2)
  const minimumDuration = speakableChars / (maxCharsPerSecond * speed)
  if (input.expectedDurationSeconds !== undefined && Number.isFinite(input.expectedDurationSeconds) && input.expectedDurationSeconds > 0) {
    const expected = input.expectedDurationSeconds
    if (Math.abs(durationSeconds - expected) > Math.max(tolerance, expected * 0.12)) {
      addIssue(issues, 'duration-mismatch', `Audio duration ${durationSeconds.toFixed(2)}s differs from the expected ${expected.toFixed(2)}s.`, durationSeconds, expected)
    }
  } else if (speakableChars >= minSpeakableChars && durationSeconds < minimumDuration) {
    addIssue(issues, 'short-audio', `Audio duration ${durationSeconds.toFixed(2)}s is below the ${minimumDuration.toFixed(2)}s content floor.`, durationSeconds, minimumDuration)
  }

  const similarity = repeatedTailSimilarity(input.samples, input.sampleRate, repeatedWindow)
  if (similarity !== null && similarity >= repeatedSimilarity) {
    addIssue(issues, 'repeated-tail', `The final ${repeatedWindow.toFixed(2)}s closely repeats the preceding audio window.`, similarity, repeatedSimilarity)
  }

  if (input.cues) inspectCues(input.cues, durationSeconds, { cueToleranceSeconds: cueTolerance, alignmentDriftRatio: driftRatio }, issues)

  let wordErrorRateValue: number | undefined
  let verificationError: string | undefined
  let verification: LongFormQualityAssessment['verification'] = 'not-requested'
  if (options.transcribe) {
    try {
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException('Quality verification cancelled.', 'AbortError')
      const transcript = await options.transcribe(input.samples, input.sampleRate, input.signal)
      verification = 'verified'
      wordErrorRateValue = wordErrorRate(qualityWords(input.text), qualityWords(transcript.text))
      if (wordErrorRateValue > maxWordErrorRate) {
        addIssue(issues, 'pronunciation-failure', `Local transcript differs from the source at ${(wordErrorRateValue * 100).toFixed(0)}% word error rate.`, wordErrorRateValue, maxWordErrorRate)
      }
      if (transcript.cues?.length) inspectCues(transcript.cues, durationSeconds, { cueToleranceSeconds: cueTolerance, alignmentDriftRatio: driftRatio }, issues)
    } catch (error) {
      if (input.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      verification = 'unavailable'
      verificationError = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    status: issues.length > 0 ? 'needs-review' : 'pass',
    verification,
    issues,
    durationSeconds,
    peak: metrics.peak,
    clippedRatio: metrics.clippedRatio,
    ...(wordErrorRateValue === undefined ? {} : { wordErrorRate: wordErrorRateValue }),
    ...(verificationError ? { verificationError } : {}),
  }
}
