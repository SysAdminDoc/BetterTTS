import { commitQueueChunk, getChunkBlob, listJobs, replaceQueueChunk, type QueueJob } from './queue.ts'
import { replaceSentenceText, resampleMono, spliceCueAudio, type SentenceRetakeAudio } from './sentence-retakes.ts'
import type { Cue } from './subtitles.ts'
import { encodeWav } from './wav.ts'

type SynthesizedAudio = {
  samples: Float32Array
  sampleRate: number
}

type QueueEngine = {
  synthesize: (
    text: string,
    voice: string,
    speed: number,
    voiceBin?: Float32Array,
    signal?: AbortSignal,
  ) => Promise<SynthesizedAudio | null>
}

export type QueueSentenceRetakeRuntime = {
  ensureQueueEngine: (job: QueueJob, onProgress: (info: { status?: string }) => void) => Promise<QueueEngine>
  queueVoiceBin: (job: QueueJob, chunk: QueueJob['chunks'][number], cache: Map<string, Float32Array>) => Promise<Float32Array | undefined>
  applyPronunciations: (text: string) => string
  setStatus: (status: string) => void
  isCancelled: () => boolean
}

type QueueSentenceSpliceRuntime = {
  encodeOutput: (samples: Float32Array, sampleRate: number, format: QueueJob['format'], bitrate: number, title: string) => Promise<{ blob: Blob; extension: string }>
  onEncoding?: () => void
  isCancelled: () => boolean
}

async function decodeMonoAudioBlob(blob: Blob): Promise<{ samples: Float32Array; sampleRate: number }> {
  const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext }
  const AudioContextConstructor = window.AudioContext ?? audioWindow.webkitAudioContext
  if (!AudioContextConstructor) throw new Error('This browser cannot decode audio for sentence splicing.')
  const context = new AudioContextConstructor()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const samples = new Float32Array(decoded.length)
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const source = decoded.getChannelData(channel)
      for (let index = 0; index < decoded.length; index += 1) samples[index] += source[index] / decoded.numberOfChannels
    }
    return { samples, sampleRate: decoded.sampleRate }
  } finally {
    await context.close().catch(() => {})
  }
}

export async function generateSentenceRetake(
  runtime: QueueSentenceRetakeRuntime,
  jobId: string,
  chunkIndex: number,
  cue: Cue,
  text: string,
  signal: AbortSignal,
): Promise<SentenceRetakeAudio | null> {
  const jobs = await listJobs()
  const job = jobs.find((item) => item.id === jobId)
  const chunk = job?.chunks.find((item) => item.index === chunkIndex)
  const currentCue = chunk?.cues?.find((item) => item.index === cue.index)
  if (!job || !chunk || !currentCue) throw new Error('The selected sentence is no longer available.')
  const { synthesize } = await runtime.ensureQueueEngine(job, (info) => {
    if (info.status === 'ready') runtime.setStatus('Model ready')
  })
  const voiceBin = await runtime.queueVoiceBin(job, chunk, new Map<string, Float32Array>())
  const audio = await synthesize(runtime.applyPronunciations(text), chunk.voice ?? job.voice, job.speed, voiceBin, signal)
  if (!audio || runtime.isCancelled() || signal.aborted) return null
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0 || audio.samples.length === 0) throw new Error('The retake produced no usable audio.')
  return {
    blob: new Blob([encodeWav(audio.samples, audio.sampleRate)], { type: 'audio/wav' }),
    samples: audio.samples,
    sampleRate: audio.sampleRate,
  }
}

export async function spliceSentenceRetake(
  runtime: QueueSentenceSpliceRuntime,
  jobId: string,
  chunkIndex: number,
  cue: Cue,
  take: SentenceRetakeAudio,
  replacementText: string,
  signal: AbortSignal,
): Promise<QueueJob | null> {
  const jobs = await listJobs()
  const job = jobs.find((item) => item.id === jobId)
  const chunk = job?.chunks.find((item) => item.index === chunkIndex)
  const currentCue = chunk?.cues?.find((item) => item.index === cue.index)
  if (!job || !chunk || !currentCue) throw new Error('The selected sentence is no longer available.')
  const originalBlob = await getChunkBlob(jobId, chunkIndex)
  if (!originalBlob) throw new Error('Original chunk audio is missing.')
  const original = await decodeMonoAudioBlob(originalBlob)
  if (runtime.isCancelled() || signal.aborted) return null
  const replacement = resampleMono(take.samples, take.sampleRate, original.sampleRate)
  const spliced = spliceCueAudio(original.samples, replacement, chunk.cues ?? [], currentCue.index, original.sampleRate, replacementText)
  runtime.onEncoding?.()
  const encoded = await runtime.encodeOutput(spliced.samples, original.sampleRate, job.format, job.bitrate, job.title)
  if (runtime.isCancelled() || signal.aborted) return null
  const nextJob = replaceQueueChunk(job, chunkIndex, {
    text: replaceSentenceText(chunk.text, currentCue.text, replacementText),
    status: 'done',
    chapterTitle: chunk.chapterTitle,
    chapterIndex: chunk.chapterIndex,
    duration: `${(spliced.samples.length / original.sampleRate).toFixed(1)}s`,
    cues: spliced.cues,
    warning: undefined,
  })
  // Audio and cue metadata replace the old record in one IndexedDB transaction.
  await commitQueueChunk(nextJob, chunkIndex, encoded.blob)
  return nextJob
}
