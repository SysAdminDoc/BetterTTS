import type { Cue } from './subtitles.ts'

export const DEFAULT_RETAKE_CROSSFADE_MS = 20
export const MAX_RETAKE_CROSSFADE_MS = 200

export type SentenceSpliceResult = {
  samples: Float32Array
  cues: Cue[]
}

export type SentenceRetakeAudio = {
  blob: Blob
  samples: Float32Array
  sampleRate: number
}

function clampCrossfadeSamples(sampleRate: number, crossfadeMs: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Sample rate must be positive.')
  const safeMs = Math.max(0, Math.min(MAX_RETAKE_CROSSFADE_MS, Number(crossfadeMs) || 0))
  return Math.round(sampleRate * safeMs / 1000)
}

function equalPowerFade(oldSample: number, newSample: number, progress: number): number {
  const angle = Math.max(0, Math.min(1, progress)) * Math.PI / 2
  return oldSample * Math.cos(angle) + newSample * Math.sin(angle)
}

export function spliceMonoAudio(
  original: Float32Array,
  replacement: Float32Array,
  startSample: number,
  endSample: number,
  sampleRate: number,
  crossfadeMs = DEFAULT_RETAKE_CROSSFADE_MS,
): Float32Array {
  if (original.length === 0 || replacement.length === 0) throw new Error('Sentence splice audio cannot be empty.')
  const start = Math.max(0, Math.min(original.length, Math.round(startSample)))
  const end = Math.max(start, Math.min(original.length, Math.round(endSample)))
  if (end <= start) throw new Error('Sentence splice range is empty.')

  const requestedFade = clampCrossfadeSamples(sampleRate, crossfadeMs)
  const leftFade = Math.min(requestedFade, start, replacement.length)
  const rightFade = Math.min(requestedFade, original.length - end, Math.max(0, replacement.length - leftFade))
  const replacementMiddle = Math.max(0, replacement.length - leftFade - rightFade)
  const suffixLength = original.length - end - rightFade
  const output = new Float32Array(start - leftFade + leftFade + replacementMiddle + rightFade + suffixLength)
  let cursor = 0

  output.set(original.subarray(0, start - leftFade), cursor)
  cursor += start - leftFade

  for (let index = 0; index < leftFade; index += 1) {
    output[cursor++] = equalPowerFade(
      original[start - leftFade + index],
      replacement[index],
      (index + 1) / leftFade,
    )
  }

  output.set(replacement.subarray(leftFade, leftFade + replacementMiddle), cursor)
  cursor += replacementMiddle

  for (let index = 0; index < rightFade; index += 1) {
    output[cursor++] = equalPowerFade(
      replacement[replacement.length - rightFade + index],
      original[end + index],
      (index + 1) / rightFade,
    )
  }

  output.set(original.subarray(end + rightFade), cursor)
  return output
}

export function resampleMono(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    throw new Error('Audio sample rates must be positive.')
  }
  if (fromRate === toRate) return samples
  if (samples.length === 0) return new Float32Array()
  const ratio = toRate / fromRate
  const output = new Float32Array(Math.max(1, Math.round(samples.length * ratio)))
  for (let index = 0; index < output.length; index += 1) {
    const source = Math.min(samples.length - 1, index / ratio)
    const lower = Math.floor(source)
    const upper = Math.min(lower + 1, samples.length - 1)
    const fraction = source - lower
    output[index] = samples[lower] * (1 - fraction) + samples[upper] * fraction
  }
  return output
}

export function spliceCueAudio(
  original: Float32Array,
  replacement: Float32Array,
  cues: readonly Cue[],
  cueIndex: number,
  sampleRate: number,
  replacementText?: string,
  crossfadeMs = DEFAULT_RETAKE_CROSSFADE_MS,
): SentenceSpliceResult {
  const target = cues.find((cue) => cue.index === cueIndex)
  if (!target) throw new Error('The selected sentence cue is no longer available.')
  const startSample = Math.round(target.startSec * sampleRate)
  const endSample = Math.round(target.endSec * sampleRate)
  const samples = spliceMonoAudio(original, replacement, startSample, endSample, sampleRate, crossfadeMs)
  const requestedFade = clampCrossfadeSamples(sampleRate, crossfadeMs)
  const leftFade = Math.min(requestedFade, startSample, replacement.length)
  // The left crossfade overlaps the old prefix, so the replacement's audible
  // cue starts at the original boundary and ends after its remaining samples.
  const targetEndSec = target.startSec + Math.max(0, replacement.length - leftFade) / sampleRate
  // Use the actual rendered length: both boundary crossfades overlap source
  // audio and therefore affect the timeline delta seen by later cues.
  const delta = (samples.length - original.length) / sampleRate
  const nextCues: Cue[] = []
  for (const cue of cues) {
    if (cue.startSec >= target.startSec && cue.endSec <= target.endSec && cue.index !== target.index) continue
    if (cue.index === target.index) {
      nextCues.push({
        ...cue,
        startSec: target.startSec,
        endSec: targetEndSec,
        text: replacementText?.trim() || cue.text,
      })
      continue
    }
    const shift = cue.startSec >= target.endSec ? delta : 0
    nextCues.push({
      ...cue,
      startSec: Math.max(0, cue.startSec + shift),
      endSec: Math.max(0, cue.endSec + shift),
    })
  }
  nextCues.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)
  return {
    samples,
    cues: nextCues.map((cue, index) => ({ ...cue, index: index + 1 })),
  }
}

export function replaceSentenceText(source: string, previousSentence: string, nextSentence: string): string {
  const previous = previousSentence.trim()
  const next = nextSentence.trim()
  if (!previous || !next) return source
  const exactStart = source.indexOf(previous)
  if (exactStart >= 0) return `${source.slice(0, exactStart)}${next}${source.slice(exactStart + previous.length)}`

  const escapedPrevious = previous.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const caseInsensitiveStart = source.search(new RegExp(escapedPrevious, 'iu'))
  if (caseInsensitiveStart >= 0) {
    return `${source.slice(0, caseInsensitiveStart)}${next}${source.slice(caseInsensitiveStart + previous.length)}`
  }
  return source
}
