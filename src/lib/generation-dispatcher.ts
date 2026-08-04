import { parsePauseTags, parseProsodyTags, splitIntoSentences, type NarratorRole, type ProsodySettings } from './text.ts'

export type GenerationJob = {
  text: string
  voice: string
  role?: NarratorRole
  speaker?: string
  voiceBin?: Float32Array
}

export type GeneratedSentence = {
  samples: Float32Array
  sampleRate: number
  wordCues?: Array<{ startSec: number; endSec: number; text: string }>
}

export type GenerationJobResult = {
  audioParts: Float32Array[]
  cues: Array<{ startSec: number; endSec: number; text: string }>
  totalSamples: number
  totalChars: number
  flaggedSentences: number
}

export type GenerationDispatchResult = {
  jobs: GenerationJobResult[]
  totalSentences: number
  completedSentences: number
  totalSamples: number
  totalChars: number
  flaggedSentences: number
  timeToFirstAudioMs: number | null
  cancelled: boolean
}

export type GenerationDispatcherOptions = {
  sampleRate: number
  speed: number
  requestStart: number
  signal?: AbortSignal
  isCancelled?: () => boolean
  applyPronunciations?: (text: string) => string
  synthesize: (text: string, voice: string, speed: number, voiceBin?: Float32Array, signal?: AbortSignal) => Promise<GeneratedSentence | null>
  processAudio?: (audio: GeneratedSentence, prosody: ProsodySettings) => Promise<GeneratedSentence> | GeneratedSentence
  checkCompleteness?: (text: string, durationSeconds: number, speed: number) => { suspect: boolean; speakableChars: number; minExpectedSeconds: number }
  onProgress?: (completed: number, total: number) => void
  onAudio?: (audio: GeneratedSentence, startSec: number, endSec: number) => void
  onSuspectAudio?: (text: string, completeness: { speakableChars: number; minExpectedSeconds: number; durationSeconds: number }) => void
  onMissingAudio?: (text: string) => void
}

export async function dispatchGeneration(
  jobs: GenerationJob[],
  options: GenerationDispatcherOptions,
): Promise<GenerationDispatchResult> {
  const plans = jobs.map((job) => parseProsodyTags(job.text).flatMap((span) => parsePauseTags(span.content).map((segment) => (
    segment.type === 'pause' ? segment : {
      ...segment,
      sentences: splitIntoSentences(segment.content).map((text) => ({ text, prosody: span })),
    }
  ))))
  const totalSentences = plans.reduce(
    (total, plan) => total + plan.reduce((count, segment) => segment.type === 'text' ? count + segment.sentences.length : count, 0),
    0,
  )
  const resultJobs: GenerationJobResult[] = []
  let completedSentences = 0
  let totalSamples = 0
  let totalChars = 0
  let flaggedSentences = 0
  let timeToFirstAudioMs: number | null = null

  const cancelled = () => options.signal?.aborted === true || options.isCancelled?.() === true

  for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
    if (cancelled()) break
    const job = jobs[jobIndex]
    const plan = plans[jobIndex]
    const audioParts: Float32Array[] = []
    const cues: Array<{ startSec: number; endSec: number; text: string }> = []
    let sampleOffset = 0
    let jobChars = 0
    let jobFlagged = 0

    for (const segment of plan) {
      if (cancelled()) break
      if (segment.type === 'pause') {
        const silence = new Float32Array(Math.round(segment.duration * options.sampleRate))
        audioParts.push(silence)
        sampleOffset += silence.length
        totalSamples += silence.length
        continue
      }

      for (const sentence of segment.sentences) {
        if (cancelled()) break
        const effectiveSpeed = options.speed * sentence.prosody.rate
        const preparedText = options.applyPronunciations?.(sentence.text) ?? sentence.text
        const synthesized = await options.synthesize(preparedText, job.voice, effectiveSpeed, job.voiceBin, options.signal)
        const audio = synthesized && options.processAudio
          ? await options.processAudio(synthesized, {
            rate: sentence.prosody.rate,
            pitchSemitones: sentence.prosody.pitchSemitones,
          })
          : synthesized

        if (audio) {
          if (audio.sampleRate !== options.sampleRate) throw new Error('Generated chunks used mixed sample rates.')
          if (timeToFirstAudioMs === null && audio.samples.length > 0) {
            timeToFirstAudioMs = performance.now() - options.requestStart
          }
          const durationSeconds = audio.samples.length / options.sampleRate
          const completeness = options.checkCompleteness?.(sentence.text, durationSeconds, effectiveSpeed)
          if (completeness?.suspect) {
            flaggedSentences += 1
            jobFlagged += 1
            options.onSuspectAudio?.(sentence.text, {
              speakableChars: completeness.speakableChars,
              minExpectedSeconds: completeness.minExpectedSeconds,
              durationSeconds,
            })
          }
          audioParts.push(audio.samples)
          totalSamples += audio.samples.length
          totalChars += sentence.text.length
          jobChars += sentence.text.length
          const startSec = sampleOffset / options.sampleRate
          sampleOffset += audio.samples.length
          const endSec = sampleOffset / options.sampleRate
          if (audio.wordCues?.length) {
            for (const cue of audio.wordCues) {
              const wordStart = Math.max(startSec, Math.min(endSec, startSec + cue.startSec))
              const wordEnd = Math.max(wordStart, Math.min(endSec, startSec + cue.endSec))
              if (wordEnd > wordStart) cues.push({ startSec: wordStart, endSec: wordEnd, text: cue.text })
            }
          } else {
            cues.push({ startSec, endSec, text: sentence.text })
          }
          options.onAudio?.(audio, startSec, endSec)
        } else if (!cancelled()) {
          flaggedSentences += 1
          jobFlagged += 1
          options.onMissingAudio?.(sentence.text)
        }
        completedSentences += 1
        options.onProgress?.(completedSentences, totalSentences)
      }
    }

    resultJobs.push({
      audioParts,
      cues,
      totalSamples: audioParts.reduce((total, part) => total + part.length, 0),
      totalChars: jobChars,
      flaggedSentences: jobFlagged,
    })
  }

  return {
    jobs: resultJobs,
    totalSentences,
    completedSentences,
    totalSamples,
    totalChars,
    flaggedSentences,
    timeToFirstAudioMs,
    cancelled: cancelled(),
  }
}
