import { fetchVoiceBin } from './voice-mix.ts'
import { kokoroLanguageForVoice, type KokoroLanguage } from './voices.ts'
import { splitPronunciationTags } from './pronunciations.ts'
export { needsDirectKokoroPath } from './kokoro-direct.ts'

type TensorLike = {
  data?: Float32Array | number[]
  dims?: readonly number[]
}

type DirectKokoroInstance = {
  tokenizer(input: string, opts: { truncation: boolean }): { input_ids: TensorLike }
  model(input: { input_ids: TensorLike; style: unknown; speed: unknown }): Promise<Record<string, TensorLike | undefined>>
}

export type DirectKokoroAudio = {
  samples: Float32Array
  sampleRate: number
}

type EphoneModule = import('ephone').ephoneModule
type EphoneLanguagePack = import('ephone').ephoneLanguagePack
type CreateEphone = typeof import('ephone').default

const KOKORO_SAMPLE_RATE = 24000
const STYLE_WIDTH = 256
const STYLE_MAX_TOKENS = 509

let romanceEphonePromise: Promise<EphoneModule> | null = null
let allEphonePromise: Promise<EphoneModule> | null = null
let japaneseEphonePromise: Promise<EphoneModule> | null = null
let chineseEphonePromise: Promise<EphoneModule> | null = null

export async function synthesizeDirectKokoro(
  tts: unknown,
  text: string,
  voice: string,
  speed: number,
  voiceBin?: Float32Array,
): Promise<DirectKokoroAudio | null> {
  const language = kokoroLanguageForVoice(voice)
  const phonemes = await phonemizeKokoroText(text, language)
  if (!phonemes) return null

  const direct = tts as DirectKokoroInstance
  const tokenized = direct.tokenizer(phonemes, { truncation: true })
  const tokenCount = tokenized.input_ids.dims?.at(-1) ?? 0
  const styleOffset = STYLE_WIDTH * Math.min(Math.max(tokenCount - 2, 0), STYLE_MAX_TOKENS)
  const styleSource = voiceBin ?? await fetchVoiceBin(voice)
  const style = styleSource.slice(styleOffset, styleOffset + STYLE_WIDTH)
  const { Tensor } = await import('@huggingface/transformers')
  const output = await direct.model({
    input_ids: tokenized.input_ids,
    style: new Tensor('float32', style, [1, STYLE_WIDTH]),
    speed: new Tensor('float32', [speed], [1]),
  })
  const waveform = pickTensor(output, ['waveform', 'audio', 'output'], true)
  if (!waveform?.data) return null
  return {
    samples: waveform.data instanceof Float32Array ? waveform.data : new Float32Array(waveform.data),
    sampleRate: KOKORO_SAMPLE_RATE,
  }
}

export async function phonemizeKokoroText(text: string, language: KokoroLanguage): Promise<string> {
  const segments = splitPronunciationTags(text)
  const output: string[] = []
  let englishPhonemizer: typeof import('phonemizer').phonemize | null = null
  let ephone: EphoneModule | null = null

  for (const segment of segments) {
    if (segment.kind === 'phoneme') {
      if (segment.value.phonemes.trim()) output.push(segment.value.phonemes.trim())
      continue
    }
    const normalized = normalizeKokoroText(segment.value)
    if (!normalized) continue

    if (language.phonemeLanguage === 'en-us' || language.phonemeLanguage === 'en') {
      englishPhonemizer ??= (await import('phonemizer')).phonemize
      output.push(postProcessEnglishPhonemes(
        (await englishPhonemizer(normalized, language.phonemeLanguage)).join(' '),
        language.phonemeLanguage === 'en-us',
      ))
    } else {
      ephone ??= await loadEphone(language.phonemeLanguage)
      ephone.setVoice(language.phonemeLanguage)
      output.push(textToIpaQuietly(ephone, normalized))
    }
  }
  return output.filter(Boolean).join(' ').trim()
}

async function loadEphone(language: KokoroLanguage['phonemeLanguage']): Promise<EphoneModule> {
  if (language === 'hi') {
    if (!allEphonePromise) {
      allEphonePromise = import('ephone').then(({ default: createEphone, all }) => createEphoneQuietly(createEphone, all))
    }
    return allEphonePromise
  }

  if (language === 'ja') {
    if (!japaneseEphonePromise) {
      japaneseEphonePromise = import('ephone').then(({ default: createEphone, jpx }) => createEphoneQuietly(createEphone, jpx))
    }
    return japaneseEphonePromise
  }

  if (language === 'cmn') {
    if (!chineseEphonePromise) {
      chineseEphonePromise = import('ephone').then(({ default: createEphone, sit }) => createEphoneQuietly(createEphone, sit))
    }
    return chineseEphonePromise
  }

  if (!romanceEphonePromise) {
    romanceEphonePromise = import('ephone').then(({ default: createEphone, roa }) => createEphoneQuietly(createEphone, roa))
  }
  return romanceEphonePromise
}

function pickTensor(
  output: Record<string, TensorLike | undefined>,
  preferredNames: string[],
  allowFallback = false,
): TensorLike | undefined {
  for (const name of preferredNames) {
    if (output[name]?.data) return output[name]
  }
  return allowFallback ? Object.values(output).find((value) => value?.data) : undefined
}

function textToIpaQuietly(ephone: EphoneModule, text: string): string {
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    if (args.length === 1 && args[0] === 'Tones have been removed') return
    originalLog(...args)
  }
  try {
    return ephone.textToIpa(text).trim()
  } finally {
    console.log = originalLog
  }
}

async function createEphoneQuietly(createEphone: CreateEphone, languages: EphoneLanguagePack): Promise<EphoneModule> {
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    if (args.length === 1 && args[0] === 'Tones have been removed') return
    originalLog(...args)
  }
  try {
    return await createEphone(languages)
  } finally {
    console.log = originalLog
  }
}

function normalizeKokoroText(value: string): string {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '"')
    .replace(/»/g, '"')
    .replace(/[“”]/g, '"')
    .replace(/\(/g, '«')
    .replace(/\)/g, '»')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/g, ' ')
    .trim()
}

function postProcessEnglishPhonemes(phonemes: string, american: boolean): string {
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
