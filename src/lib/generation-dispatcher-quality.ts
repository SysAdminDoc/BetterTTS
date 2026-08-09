import {
  dispatchGeneration,
  type GeneratedSentence,
  type GenerationDispatcherOptions,
  type GenerationDispatchResult,
  type GenerationJob,
} from './generation-dispatcher.ts'
import {
  evaluateLongFormQuality,
  qualityRetryCount,
  type LongFormQualityAssessment,
  type LongFormQualityReview,
} from './long-form-quality.ts'
import type { ProsodySettings } from './text.ts'

export async function dispatchGenerationWithQuality(
  jobs: GenerationJob[],
  options: GenerationDispatcherOptions,
): Promise<GenerationDispatchResult> {
  const qualityGate = options.qualityGate
  if (!qualityGate?.enabled) return dispatchGeneration(jobs, options)

  const segmentReviews: LongFormQualityReview[][] = jobs.map(() => [])
  let activeJobIndex = 0
  const cancelled = (signal?: AbortSignal) => options.signal?.aborted === true || signal?.aborted === true || options.isCancelled?.() === true
  const synthesizeWithQuality = async (
    text: string,
    voice: string,
    speed: number,
    voiceBin: Float32Array | undefined,
    prosody: ProsodySettings,
    signal?: AbortSignal,
  ): Promise<GeneratedSentence | null> => {
    const maxAttempts = 1 + qualityRetryCount(qualityGate)
    let attempts = 0
    let audio: GeneratedSentence | null = null
    let qualityAssessment: LongFormQualityAssessment | undefined
    while (attempts < maxAttempts) {
      attempts += 1
      const synthesized = await options.synthesize(text, voice, speed, voiceBin, signal)
      audio = synthesized && options.processAudio
        ? await options.processAudio(synthesized, prosody)
        : synthesized
      if (cancelled(signal)) return null
      qualityAssessment = await evaluateLongFormQuality({
        text,
        samples: audio?.samples ?? new Float32Array(),
        sampleRate: options.sampleRate,
        speed,
        cues: audio?.wordCues,
        signal,
      }, qualityGate.transcriptionScope === 'segment'
        ? qualityGate
        : { ...qualityGate, transcribe: undefined })
      if (qualityAssessment.status === 'pass' || attempts >= maxAttempts) break
      options.onQualityRetry?.(text, attempts, qualityAssessment.issues)
    }

    if (qualityAssessment?.status === 'needs-review') {
      const review: LongFormQualityReview = {
        scope: 'segment',
        text,
        attempts,
        issues: qualityAssessment.issues,
        durationSeconds: qualityAssessment.durationSeconds,
        verification: qualityAssessment.verification,
        ...(qualityAssessment.verificationError ? { verificationError: qualityAssessment.verificationError } : {}),
      }
      segmentReviews[activeJobIndex]?.push(review)
      options.onQualityReview?.(review)
    }
    return audio
  }

  const result = await dispatchGeneration(jobs, {
    ...options,
    qualityGate: undefined,
    processAudio: undefined,
    synthesizeWithProsody: synthesizeWithQuality,
    onJobStart: (jobIndex) => { activeJobIndex = jobIndex },
  })
  const needsReview: LongFormQualityReview[] = []
  for (let index = 0; index < result.jobs.length; index += 1) {
    const jobResult = result.jobs[index]
    const reviews = segmentReviews[index] ?? []
    if (jobResult) {
      jobResult.needsReview = reviews
      jobResult.flaggedSentences += reviews.length
    }
    needsReview.push(...reviews)
    if (result.cancelled) continue
    const job = jobs[index]
    if (!job || !jobResult) continue
    const assessment = await evaluateLongFormQuality({
      text: job.text,
      samples: concatSamples(jobResult.audioParts),
      sampleRate: options.sampleRate,
      speed: options.speed,
      cues: jobResult.cues,
      signal: options.signal,
    }, qualityGate)
    if (assessment.status === 'needs-review') {
      const review: LongFormQualityReview = {
        scope: 'job',
        text: job.text,
        attempts: 1,
        issues: assessment.issues,
        durationSeconds: assessment.durationSeconds,
        verification: assessment.verification,
        ...(assessment.verificationError ? { verificationError: assessment.verificationError } : {}),
      }
      jobResult.needsReview.push(review)
      needsReview.push(review)
      options.onQualityReview?.(review)
    }
  }
  return {
    ...result,
    flaggedSentences: result.flaggedSentences + segmentReviews.reduce((total, reviews) => total + reviews.length, 0),
    needsReview,
  }
}

function concatSamples(parts: readonly Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const samples = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    samples.set(part, offset)
    offset += part.length
  }
  return samples
}
