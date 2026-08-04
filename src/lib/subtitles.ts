export type Cue = {
  index: number
  startSec: number
  endSec: number
  text: string
}

export type SubtitleFormat = 'srt' | 'vtt'

export type ParsedSubtitle = {
  format: SubtitleFormat
  cues: Cue[]
  warnings: string[]
}

export type SubtitleAudioSegment = {
  cue: Cue
  samples: Float32Array | null
  sampleRate?: number
}

export type SubtitleFitResult = {
  samples: Float32Array
  mode: 'padded' | 'compressed' | 'trimmed' | 'empty'
  sourceDurationSec: number
  targetDurationSec: number
  warning?: string
}

export type SubtitleTimelineResult = {
  samples: Float32Array
  durationSec: number
  warnings: string[]
  compressedCueIndexes: number[]
  truncatedCueIndexes: number[]
  missingCueIndexes: number[]
}

export const SUBTITLE_FIT_TOLERANCE_SECONDS = 0.08
export const SUBTITLE_MAX_COMPRESSION_RATIO = 1.35

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// Derive all parts from a single rounded millisecond total; rounding the
// fraction alone can yield ms=1000 and emit invalid stamps like 00:00:02,1000.
function timeParts(sec: number): { h: number; m: number; s: number; ms: number } {
  const totalMs = Math.max(0, Math.round(sec * 1000))
  const ms = totalMs % 1000
  const totalSec = (totalMs - ms) / 1000
  return {
    h: Math.floor(totalSec / 3600),
    m: Math.floor((totalSec % 3600) / 60),
    s: totalSec % 60,
    ms,
  }
}

function srtTime(sec: number): string {
  const { h, m, s, ms } = timeParts(sec)
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, '0')}`
}

function vttTime(sec: number): string {
  const { h, m, s, ms } = timeParts(sec)
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(ms).padStart(3, '0')}`
}

// A blank line inside cue text terminates the block early and corrupts every
// following cue in strict parsers.
function cueText(text: string): string {
  return text.replace(/\n{2,}/g, '\n').trim()
}

function parseTimestamp(value: string): number | null {
  const normalized = value.trim().replace(',', '.')
  const parts = normalized.split(':')
  if (parts.length < 2 || parts.length > 3) return null

  const seconds = Number(parts.at(-1))
  const minutes = Number(parts.at(-2))
  const hours = parts.length === 3 ? Number(parts[0]) : 0
  if (![hours, minutes, seconds].every(Number.isFinite) || hours < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) {
    return null
  }
  return hours * 3600 + minutes * 60 + seconds
}

function formatCueWarning(format: SubtitleFormat, blockNumber: number, detail: string): string {
  return `${format.toUpperCase()} cue ${blockNumber}: ${detail}`
}

export function parseSubtitleText(source: string, formatHint?: SubtitleFormat): ParsedSubtitle {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const trimmed = normalized.trim()
  const format: SubtitleFormat = formatHint ?? (/^WEBVTT(?:\s|$)/i.test(trimmed) ? 'vtt' : 'srt')
  const warnings: string[] = []
  const cues: Cue[] = []
  const blocks = normalized.split(/\n{2,}/)
  let sequence = 0

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const lines = blocks[blockIndex].split('\n').map((line) => line.trimEnd())
    const first = lines.find((line) => line.trim().length > 0)?.trim() ?? ''
    if (!first || /^WEBVTT(?:\s|$)/i.test(first) || /^(?:NOTE|STYLE|REGION)(?:\s|$)/i.test(first)) continue

    const timestampLineIndex = lines.findIndex((line) => line.includes('-->'))
    if (timestampLineIndex < 0) {
      warnings.push(formatCueWarning(format, blockIndex + 1, 'missing a timestamp line; skipped.'))
      continue
    }

    const timestamp = lines[timestampLineIndex].match(/^\s*(\S+)\s*-->\s*(\S+)/)
    if (!timestamp) {
      warnings.push(formatCueWarning(format, blockIndex + 1, 'has an invalid timestamp line; skipped.'))
      continue
    }
    const startSec = parseTimestamp(timestamp[1])
    const endSec = parseTimestamp(timestamp[2])
    if (startSec === null || endSec === null || endSec <= startSec) {
      warnings.push(formatCueWarning(format, blockIndex + 1, 'has an invalid or empty time range; skipped.'))
      continue
    }

    const cueLines = lines.slice(timestampLineIndex + 1)
    const text = cueText(cueLines.join('\n'))
    if (!text) {
      warnings.push(formatCueWarning(format, blockIndex + 1, 'has no text; skipped.'))
      continue
    }

    const identifier = lines.slice(0, timestampLineIndex).find((line) => line.trim().length > 0)?.trim() ?? ''
    const parsedIndex = Number(identifier)
    sequence += 1
    cues.push({
      index: Number.isInteger(parsedIndex) && parsedIndex > 0 ? parsedIndex : sequence,
      startSec,
      endSec,
      text,
    })
  }

  if (cues.length === 0) throw new Error(`No valid ${format.toUpperCase()} cues found.`)
  return { format, cues, warnings }
}

export function subtitleTextForSpeech(text: string): string {
  return text
    .replace(/<\/?[^>]+>/g, '')
    .replace(/\\N/g, '\n')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function resampleToLength(samples: Float32Array, targetLength: number): Float32Array {
  if (targetLength <= 0) return new Float32Array()
  if (samples.length === targetLength) return samples.slice()
  if (samples.length === 0) return new Float32Array(targetLength)
  if (targetLength === 1) return new Float32Array([samples[0]])

  const result = new Float32Array(targetLength)
  const scale = (samples.length - 1) / (targetLength - 1)
  for (let index = 0; index < targetLength; index += 1) {
    const source = index * scale
    const lower = Math.floor(source)
    const upper = Math.min(lower + 1, samples.length - 1)
    const fraction = source - lower
    result[index] = samples[lower] * (1 - fraction) + samples[upper] * fraction
  }
  return result
}

function resample(samples: Float32Array, sourceSampleRate: number, targetSampleRate: number): Float32Array {
  if (samples.length === 0) return new Float32Array()
  if (sourceSampleRate === targetSampleRate) return samples.slice()
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0 || !Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
    throw new Error('Subtitle audio has an invalid sample rate.')
  }
  return resampleToLength(samples, Math.max(1, Math.round(samples.length * targetSampleRate / sourceSampleRate)))
}

export function fitAudioToCue(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
  cueDurationSec: number,
  cueIndex = 1,
): SubtitleFitResult {
  if (!Number.isFinite(cueDurationSec) || cueDurationSec <= 0) {
    return {
      samples: new Float32Array(),
      mode: 'empty',
      sourceDurationSec: 0,
      targetDurationSec: 0,
      warning: `Cue ${cueIndex} has no positive duration.`,
    }
  }

  const targetLength = Math.max(1, Math.round(cueDurationSec * targetSampleRate))
  const resampled = resample(samples, sourceSampleRate, targetSampleRate)
  const sourceDurationSec = resampled.length / targetSampleRate
  if (resampled.length === 0) {
    return {
      samples: new Float32Array(targetLength),
      mode: 'empty',
      sourceDurationSec,
      targetDurationSec: cueDurationSec,
      warning: `Cue ${cueIndex} produced no audio and was left silent.`,
    }
  }

  if (resampled.length <= targetLength) {
    const fitted = new Float32Array(targetLength)
    fitted.set(resampled)
    return { samples: fitted, mode: 'padded', sourceDurationSec, targetDurationSec: cueDurationSec }
  }

  const compressionRatio = sourceDurationSec / cueDurationSec
  if (sourceDurationSec - cueDurationSec <= SUBTITLE_FIT_TOLERANCE_SECONDS) {
    return {
      samples: resampled.slice(0, targetLength),
      mode: 'trimmed',
      sourceDurationSec,
      targetDurationSec: cueDurationSec,
    }
  }
  if (compressionRatio <= SUBTITLE_MAX_COMPRESSION_RATIO) {
    return {
      samples: resampleToLength(resampled, targetLength),
      mode: 'compressed',
      sourceDurationSec,
      targetDurationSec: cueDurationSec,
    }
  }

  return {
    samples: resampled.slice(0, targetLength),
    mode: 'trimmed',
    sourceDurationSec,
    targetDurationSec: cueDurationSec,
    warning: `Cue ${cueIndex} audio (${sourceDurationSec.toFixed(1)}s) could not fit its ${cueDurationSec.toFixed(1)}s window and was clipped.`,
  }
}

export function assembleSubtitleTimeline(
  segments: SubtitleAudioSegment[],
  targetSampleRate: number,
): SubtitleTimelineResult {
  if (!Number.isFinite(targetSampleRate) || targetSampleRate <= 0) throw new Error('Subtitle output has an invalid sample rate.')
  const durationSec = segments.reduce((max, segment) => Math.max(max, segment.cue.endSec), 0)
  const timeline = new Float32Array(Math.max(1, Math.round(durationSec * targetSampleRate)))
  const warnings: string[] = []
  const compressedCueIndexes: number[] = []
  const truncatedCueIndexes: number[] = []
  const missingCueIndexes: number[] = []

  const ordered = [...segments].sort((a, b) => a.cue.startSec - b.cue.startSec || a.cue.index - b.cue.index)
  let previousEnd = 0
  for (const segment of ordered) {
    const { cue } = segment
    if (cue.startSec < previousEnd) warnings.push(`Cue ${cue.index} overlaps an earlier cue; overlapping audio was mixed.`)
    previousEnd = Math.max(previousEnd, cue.endSec)
    const fit = fitAudioToCue(
      segment.samples ?? new Float32Array(),
      segment.sampleRate ?? targetSampleRate,
      targetSampleRate,
      cue.endSec - cue.startSec,
      cue.index,
    )
    if (fit.mode === 'compressed') compressedCueIndexes.push(cue.index)
    if (fit.mode === 'trimmed') truncatedCueIndexes.push(cue.index)
    if (fit.mode === 'empty') missingCueIndexes.push(cue.index)
    if (fit.warning) warnings.push(fit.warning)

    const offset = Math.max(0, Math.round(cue.startSec * targetSampleRate))
    for (let index = 0; index < fit.samples.length && offset + index < timeline.length; index += 1) {
      const mixed = timeline[offset + index] + fit.samples[index]
      timeline[offset + index] = Math.max(-1, Math.min(1, mixed))
    }
  }

  return {
    samples: timeline,
    durationSec,
    warnings,
    compressedCueIndexes,
    truncatedCueIndexes,
    missingCueIndexes,
  }
}

export function toSRT(cues: Cue[]): string {
  return cues
    .map((c) => `${c.index}\n${srtTime(c.startSec)} --> ${srtTime(c.endSec)}\n${cueText(c.text)}`)
    .join('\n\n')
}

export function toVTT(cues: Cue[]): string {
  const body = cues
    .map((c) => `${c.index}\n${vttTime(c.startSec)} --> ${vttTime(c.endSec)}\n${cueText(c.text)}`)
    .join('\n\n')
  return `WEBVTT\n\n${body}`
}
