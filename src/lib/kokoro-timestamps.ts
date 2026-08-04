import { fetchVoiceBin } from './voice-mix.ts'
import type { ProgressInfo } from './kokoro.ts'
import type { Cue } from './subtitles.ts'
import { splitPronunciationTags } from './pronunciations.ts'
import { cropAudioToTimeRange } from './encode.ts'

export const KOKORO_TIMESTAMPED_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped'
const KOKORO_TIMESTAMPED_SAMPLE_RATE = 24000
const TIMESTAMP_DIVISOR = 80

type KokoroModule = typeof import('kokoro-js')
type TimestampedKokoroInstance = Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>

type TensorLike = {
  data: Float32Array | number[]
  dims?: readonly number[]
}

type TimestampedOutput = Record<string, TensorLike | undefined>

export type TimestampToken = {
  text: string
  phonemes: string
  whitespace: boolean
  kind: 'word' | 'punctuation'
}

export type TimestampedKokoroAudio = {
  samples: Float32Array
  sampleRate: number
  wordCues: Omit<Cue, 'index'>[]
}

export const SHORT_INPUT_MAX_WORDS = 4
export const SHORT_INPUT_PREFIX = 'Please say'
export const SHORT_INPUT_SUFFIX = 'clearly'

let timestampedKokoroPromise: Promise<TimestampedKokoroInstance> | null = null

export async function loadTimestampedKokoro(onProgress: (info: ProgressInfo) => void): Promise<TimestampedKokoroInstance> {
  if (timestampedKokoroPromise) return timestampedKokoroPromise

  const { KokoroTTS } = await import('kokoro-js')
  timestampedKokoroPromise = KokoroTTS.from_pretrained(KOKORO_TIMESTAMPED_MODEL_ID, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (info) => onProgress(info as ProgressInfo),
  })

  try {
    return await timestampedKokoroPromise
  } catch (err) {
    timestampedKokoroPromise = null
    throw err
  }
}

export function resetTimestampedKokoroSession() {
  timestampedKokoroPromise = null
}

export function countEnglishWords(text: string): number {
  return [...text.matchAll(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/gu)].length
}

export function isShortKokoroInput(text: string): boolean {
  const wordCount = countEnglishWords(text)
  return wordCount > 0 && wordCount <= SHORT_INPUT_MAX_WORDS
}

export function countWordTokens(tokens: readonly TimestampToken[]): number {
  return tokens.reduce((count, token) => count + (token.kind === 'word' ? 1 : 0), 0)
}

export function shouldPadShortInput(tokens: readonly TimestampToken[]): boolean {
  const wordCount = countWordTokens(tokens)
  return wordCount > 0 && wordCount <= SHORT_INPUT_MAX_WORDS
}

export function padShortInput(text: string): string {
  return `${SHORT_INPUT_PREFIX} ${text.trim()} ${SHORT_INPUT_SUFFIX}.`
}

export function cropTimestampedKokoroAudio(
  audio: TimestampedKokoroAudio,
  targetCues: readonly Omit<Cue, 'index'>[],
): TimestampedKokoroAudio {
  if (targetCues.length === 0) return audio
  const startSec = targetCues[0].startSec
  const endSec = targetCues[targetCues.length - 1].endSec
  const startSample = Math.max(0, Math.min(audio.samples.length, Math.floor(startSec * audio.sampleRate)))
  const cropped = cropAudioToTimeRange(audio.samples, audio.sampleRate, startSec, endSec)
  const cropStartSec = startSample / audio.sampleRate
  const durationSec = cropped.length / audio.sampleRate
  return {
    ...audio,
    samples: cropped,
    wordCues: targetCues.flatMap((cue) => {
      const start = Math.max(0, cue.startSec - cropStartSec)
      const end = Math.min(durationSec, Math.max(start, cue.endSec - cropStartSec))
      return end > start ? [{ startSec: start, endSec: end, text: cue.text }] : []
    }),
  }
}

export async function synthesizeTimestampedKokoro(
  tts: TimestampedKokoroInstance,
  text: string,
  voice: string,
  speed: number,
  voiceBin?: Float32Array,
): Promise<TimestampedKokoroAudio | null> {
  const language = voice.charAt(0) === 'a' ? 'en-us' : 'en'
  const sourceTokens = await buildTimestampTokens(text, language)
  if (sourceTokens.length === 0) return null
  const pad = shouldPadShortInput(sourceTokens)
  const prefixTokens = pad ? await buildTimestampTokens(SHORT_INPUT_PREFIX, language) : []
  const tokens = pad ? await buildTimestampTokens(padShortInput(text), language) : sourceTokens
  const styleSource = voiceBin ?? await fetchVoiceBin(voice)
  const { Tensor } = await import('@huggingface/transformers')

  const synthesizeTokens = async (candidateTokens: TimestampToken[]): Promise<TimestampedKokoroAudio | null> => {
    const phonemes = timestampTokensToPhonemes(candidateTokens)
    if (!phonemes) return null
    const tokenized = (tts as unknown as {
      tokenizer(input: string, opts: { truncation: boolean }): { input_ids: TensorLike }
    }).tokenizer(phonemes, { truncation: true })
    const tokenCount = tokenized.input_ids.dims?.at(-1) ?? 0
    const styleOffset = 256 * Math.min(Math.max(tokenCount - 2, 0), 509)
    const style = styleSource.slice(styleOffset, styleOffset + 256)
    const output = await (tts as unknown as {
      model(input: { input_ids: TensorLike; style: unknown; speed: unknown }): Promise<TimestampedOutput>
    }).model({
      input_ids: tokenized.input_ids,
      style: new Tensor('float32', style, [1, 256]),
      speed: new Tensor('float32', [speed], [1]),
    })

    const waveform = pickTensor(output, ['waveform', 'audio', 'output'], true)
    const durations = pickTensor(output, ['pred_dur', 'durations', 'duration'])
    if (!waveform?.data) return null
    if (!durations?.data) throw new Error('Timestamped Kokoro did not return duration data.')

    return {
      samples: waveform.data instanceof Float32Array ? waveform.data : new Float32Array(waveform.data),
      sampleRate: KOKORO_TIMESTAMPED_SAMPLE_RATE,
      wordCues: joinWordTimestamps(candidateTokens, durations.data),
    }
  }

  const synthesized = await synthesizeTokens(tokens)
  if (!synthesized || !pad) return synthesized
  const sourceWordCount = countWordTokens(sourceTokens)
  const prefixWordCount = countWordTokens(prefixTokens)
  const targetCues = synthesized.wordCues.slice(prefixWordCount, prefixWordCount + sourceWordCount)
  if (targetCues.length !== sourceWordCount) return synthesizeTokens(sourceTokens)
  return cropTimestampedKokoroAudio(synthesized, targetCues)
}

export async function buildTimestampTokens(text: string, language: string): Promise<TimestampToken[]> {
  const { phonemize } = await import('phonemizer')
  const tokens: TimestampToken[] = []

  const segments = splitPronunciationTags(text)
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex]
    if (segment.kind === 'phoneme') {
      const following = segments[segmentIndex + 1]
      tokens.push({
        text: segment.value.word,
        phonemes: segment.value.phonemes,
        whitespace: following?.kind === 'text' && /^\s/u.test(following.value),
        kind: 'word',
      })
      continue
    }

    const matches = [...segment.value.matchAll(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*|[^\sA-Za-z0-9]/gu)]
    for (let i = 0; i < matches.length; i += 1) {
      const match = matches[i]
      const value = match[0]
      const nextIndex = i + 1 < matches.length ? matches[i + 1].index ?? segment.value.length : segment.value.length
      const end = (match.index ?? 0) + value.length
      const whitespace = /\s/.test(segment.value.slice(end, nextIndex))
      const kind = /^[A-Za-z0-9]/.test(value) ? 'word' : 'punctuation'
      const phonemes = kind === 'punctuation'
        ? normalizePunctuation(value)
        : postProcessKokoroPhonemes((await phonemize(normalizeKokoroText(value), language)).join(' '), language === 'en-us')

      if (phonemes) tokens.push({ text: value, phonemes, whitespace, kind })
    }
  }

  return tokens
}

export function timestampTokensToPhonemes(tokens: TimestampToken[]): string {
  return tokens.map((token) => `${token.phonemes}${token.whitespace ? ' ' : ''}`).join('').trim()
}

export function joinWordTimestamps(tokens: TimestampToken[], durations: ArrayLike<number>): Omit<Cue, 'index'>[] {
  if (tokens.length === 0 || durations.length < 3) return []

  const cues: Omit<Cue, 'index'>[] = []
  let left = 2 * Math.max(0, Number(durations[0]) - 3)
  let right = left
  let i = 1

  for (const token of tokens) {
    if (i >= durations.length - 1) break
    if (!token.phonemes) {
      if (token.whitespace) {
        i += 1
        const spaceDur = Number(durations[i] ?? 0)
        left = right + spaceDur
        right = left + spaceDur
        i += 1
      }
      continue
    }

    const j = i + [...token.phonemes].length
    if (j >= durations.length) break
    const startSec = left / TIMESTAMP_DIVISOR
    let tokenDur = 0
    for (let k = i; k < j; k += 1) tokenDur += Number(durations[k] ?? 0)
    const spaceDur = token.whitespace ? Number(durations[j] ?? 0) : 0
    left = right + (2 * tokenDur) + spaceDur
    const endSec = left / TIMESTAMP_DIVISOR
    right = left + spaceDur
    i = j + (token.whitespace ? 1 : 0)

    if (token.kind === 'word' && endSec > startSec) {
      cues.push({ startSec, endSec, text: token.text })
    }
  }

  return cues
}

function pickTensor(output: TimestampedOutput, preferredNames: string[], allowFallback = false): TensorLike | undefined {
  for (const name of preferredNames) {
    if (output[name]?.data) return output[name]
  }
  return allowFallback ? Object.values(output).find((value) => value?.data) : undefined
}

function normalizePunctuation(value: string): string {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“')
    .replace(/»/g, '”')
    .replace(/[“”]/g, '"')
}

function normalizeKokoroText(value: string): string {
  return normalizePunctuation(value)
    .replace(/\(/g, '«')
    .replace(/\)/g, '»')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/g, ' ')
    .trim()
}

function postProcessKokoroPhonemes(phonemes: string, american: boolean): string {
  let next = phonemes
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z')
  if (american) next = next.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di')
  return next.trim()
}
