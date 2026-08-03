import type { Cue } from './subtitles.ts'

export const WHISPER_CPP_VERSION = 'v1.9.1'
export const WHISPER_CPP_ASSET = 'whisper-bin-x64.zip'
export const WHISPER_CPP_ASSET_SHA256 = '7D8BE46ECD31828E1EB7A2ECDD0D6B314FEAFD82163038AB6092594B0A063539'
export const WHISPER_CPP_DOWNLOAD_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}/${WHISPER_CPP_ASSET}`
export const WHISPER_MODEL_FILENAME = 'ggml-base.bin'
export const WHISPER_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL_FILENAME}?download=true`
export const WHISPER_SAMPLE_RATE = 16_000
export const MAX_WHISPER_AUDIO_SECONDS = 30 * 60
export const MAX_WHISPER_AUDIO_BYTES = 80 * 1024 * 1024

export const WHISPER_LANGUAGES = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'ar', label: 'Arabic' },
  { id: 'de', label: 'German' },
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Spanish' },
  { id: 'fr', label: 'French' },
  { id: 'hi', label: 'Hindi' },
  { id: 'it', label: 'Italian' },
  { id: 'ja', label: 'Japanese' },
  { id: 'ko', label: 'Korean' },
  { id: 'nl', label: 'Dutch' },
  { id: 'pl', label: 'Polish' },
  { id: 'pt', label: 'Portuguese' },
  { id: 'ru', label: 'Russian' },
  { id: 'tr', label: 'Turkish' },
  { id: 'uk', label: 'Ukrainian' },
  { id: 'zh', label: 'Chinese' },
] as const

export type WhisperLanguage = typeof WHISPER_LANGUAGES[number]['id']

export type WhisperWord = {
  startSec: number
  endSec: number
  text: string
}

export type WhisperAlignment = {
  schemaVersion: 1
  language: string
  words: WhisperWord[]
  cues: Cue[]
  durationSec: number
}

export type WhisperRuntimeStatus = {
  available: boolean
  cliPath?: string
  modelPath?: string
  modelName?: string
  message: string
  recovery: string
}

type RawRecord = Record<string, unknown>

function record(value: unknown): RawRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function timestampSeconds(value: unknown): number | null {
  const numeric = finite(value)
  if (numeric !== null) return numeric >= 100 ? numeric / 1000 : numeric
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/)
  if (!match) return null
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const milliseconds = Number(match[4].padEnd(3, '0'))
  if (minutes > 59 || seconds > 59) return null
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000
}

function offsetSeconds(value: unknown): number | null {
  const numeric = finite(value)
  return numeric === null ? null : numeric / 1000
}

function timeFrom(row: RawRecord, key: 'from' | 'to'): number | null {
  const offsets = record(row.offsets)
  const timestamps = record(row.timestamps)
  return offsetSeconds(offsets?.[key]) ?? timestampSeconds(timestamps?.[key])
}

function cleanTranscriptText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const cleaned = value
    .replace(/\[_(?:BEG|END|NOSPEECH)_\]/giu, '')
    .replace(/<\|[^>]+\|>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return cleaned
}

function splitTimedText(text: string, startSec: number, endSec: number): WhisperWord[] {
  const parts = text.split(/\s+/u).filter(Boolean)
  if (parts.length <= 1) return [{ startSec, endSec, text }]

  const totalWeight = parts.reduce((sum, part) => sum + Math.max(1, [...part].length), 0)
  const duration = Math.max(0, endSec - startSec)
  let cursor = startSec
  return parts.map((part) => {
    const partDuration = duration * Math.max(1, [...part].length) / totalWeight
    const word = { startSec: cursor, endSec: cursor + partDuration, text: part }
    cursor += partDuration
    return word
  })
}

function isPunctuation(text: string): boolean {
  return /^[\p{P}\p{S}]+$/u.test(text)
}

function mergePunctuation(words: WhisperWord[]): WhisperWord[] {
  const merged: WhisperWord[] = []
  for (const word of words) {
    if (isPunctuation(word.text) && merged.length > 0) {
      const previous = merged[merged.length - 1]
      previous.text = `${previous.text}${word.text}`
      previous.endSec = Math.max(previous.endSec, word.endSec)
    } else {
      merged.push({ ...word })
    }
  }
  return merged
}

function normalizeWords(words: WhisperWord[]): WhisperWord[] {
  const usable = words
    .filter((word) => word.text && Number.isFinite(word.startSec) && Number.isFinite(word.endSec))
    .map((word) => ({
      startSec: Math.max(0, word.startSec),
      endSec: Math.max(Math.max(0, word.startSec), word.endSec),
      text: word.text,
    }))
    .filter((word) => word.endSec > word.startSec && word.text.length > 0)
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)

  return mergePunctuation(usable)
}

function rowsFromPayload(payload: RawRecord): RawRecord[] {
  const transcription = Array.isArray(payload.transcription) ? payload.transcription : null
  if (transcription) return transcription.map(record).filter((row): row is RawRecord => row !== null)
  const segments = Array.isArray(payload.segments) ? payload.segments : []
  return segments.map(record).filter((row): row is RawRecord => row !== null)
}

function languageFromPayload(payload: RawRecord, fallbackLanguage: string): string {
  const result = record(payload.result)
  const language = result?.language ?? payload.language
  return typeof language === 'string' && /^[a-z]{2,8}$/iu.test(language) ? language.toLowerCase() : fallbackLanguage
}

export function cuesFromWhisperWords(words: WhisperWord[]): Cue[] {
  return normalizeWords(words).map((word, index) => ({
    index: index + 1,
    startSec: word.startSec,
    endSec: word.endSec,
    text: word.text,
  }))
}

export function parseWhisperJson(payload: unknown, fallbackLanguage = 'auto'): WhisperAlignment {
  const root = record(payload)
  if (!root) throw new Error('whisper.cpp returned an invalid JSON object.')

  const words: WhisperWord[] = []
  for (const row of rowsFromPayload(root)) {
    const text = cleanTranscriptText(row.text)
    const startSec = timeFrom(row, 'from')
    const endSec = timeFrom(row, 'to')
    if (!text || startSec === null || endSec === null || endSec <= startSec) continue
    words.push(...splitTimedText(text, startSec, endSec))
  }

  const normalized = normalizeWords(words)
  const cues = cuesFromWhisperWords(normalized)
  return {
    schemaVersion: 1,
    language: languageFromPayload(root, fallbackLanguage),
    words: normalized,
    cues,
    durationSec: cues.length > 0 ? cues[cues.length - 1].endSec : 0,
  }
}

export function formatWhisperRuntimeRecovery(status: Pick<WhisperRuntimeStatus, 'cliPath' | 'modelPath'>): string {
  const missing: string[] = []
  if (!status.cliPath) missing.push('the pinned whisper.cpp Windows runtime')
  if (!status.modelPath) missing.push(`the multilingual ${WHISPER_MODEL_FILENAME} model`)
  if (missing.length === 0) return 'whisper.cpp is ready for local captioning.'
  return `Captioning needs ${missing.join(' and ')}. Run the desktop build to fetch the runtime, then place ${WHISPER_MODEL_FILENAME} in the BetterTTS whisper model folder or set BETTERTTS_WHISPER_MODEL. Model download: ${WHISPER_MODEL_URL}`
}

export function resampleMonoAudio(channels: readonly Float32Array[], sourceRate: number, targetRate = WHISPER_SAMPLE_RATE): Float32Array {
  if (channels.length === 0 || !Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) {
    return new Float32Array()
  }
  const sourceLength = Math.max(...channels.map((channel) => channel.length), 0)
  if (sourceLength === 0) return new Float32Array()
  const targetLength = Math.max(1, Math.round(sourceLength * targetRate / sourceRate))
  const output = new Float32Array(targetLength)
  const ratio = sourceRate / targetRate
  for (let index = 0; index < targetLength; index += 1) {
    const position = index * ratio
    const left = Math.min(sourceLength - 1, Math.floor(position))
    const right = Math.min(sourceLength - 1, left + 1)
    const fraction = position - left
    let sample = 0
    let count = 0
    for (const channel of channels) {
      const a = channel[left] ?? 0
      const b = channel[right] ?? a
      sample += a + (b - a) * fraction
      count += 1
    }
    output[index] = count > 0 ? sample / count : 0
  }
  return output
}
