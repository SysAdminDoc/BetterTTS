export type VoiceId =
  | 'am_adam' | 'am_puck' | 'am_liam' | 'af_heart' | 'af_bella' | 'af_nova'
  | 'af_alloy' | 'af_aoede' | 'af_jessica' | 'af_kore' | 'af_nicole' | 'af_river'
  | 'af_sarah' | 'af_sky'
  | 'am_echo' | 'am_eric' | 'am_fenrir' | 'am_michael' | 'am_onyx' | 'am_santa'
  | 'bf_alice' | 'bf_emma' | 'bf_isabella' | 'bf_lily'
  | 'bm_daniel' | 'bm_fable' | 'bm_george' | 'bm_lewis'
  | 'jf_alpha' | 'jf_gongitsune' | 'jf_nezumi' | 'jf_tebukuro' | 'jm_kumo'
  | 'zf_xiaobei' | 'zf_xiaoni' | 'zf_xiaoxiao' | 'zf_xiaoyi'
  | 'zm_yunjian' | 'zm_yunxi' | 'zm_yunxia' | 'zm_yunyang'
  | 'ef_dora' | 'em_alex' | 'em_santa'
  | 'ff_siwis'
  | 'hf_alpha' | 'hf_beta' | 'hm_omega' | 'hm_psi'
  | 'if_sara' | 'im_nicola'
  | 'pf_dora' | 'pm_alex' | 'pm_santa'

export type KokoroLocale = 'en-us' | 'en-gb' | 'ja' | 'cmn' | 'es' | 'fr' | 'it' | 'pt-br' | 'hi'

export type KokoroLanguage = {
  id: KokoroLocale
  label: string
  phonemeLanguage: 'en-us' | 'en' | 'ja' | 'cmn' | 'es' | 'fr' | 'it' | 'pt-BR' | 'hi'
  previewText: string
}

export type Voice = {
  id: VoiceId
  name: string
  locale: KokoroLocale
  gender: 'Female' | 'Male'
  grade: string
}

export const KOKORO_LANGUAGES: KokoroLanguage[] = [
  { id: 'en-us', label: 'English US', phonemeLanguage: 'en-us', previewText: 'This is how I sound.' },
  { id: 'en-gb', label: 'English British', phonemeLanguage: 'en', previewText: 'This is how I sound.' },
  { id: 'ja', label: 'Japanese', phonemeLanguage: 'ja', previewText: 'こんにちは、これは私の声です。' },
  { id: 'cmn', label: 'Mandarin Chinese', phonemeLanguage: 'cmn', previewText: '你好，这是我的声音。' },
  { id: 'es', label: 'Spanish', phonemeLanguage: 'es', previewText: 'Hola, asi suena mi voz.' },
  { id: 'fr', label: 'French', phonemeLanguage: 'fr', previewText: 'Bonjour, voici ma voix.' },
  { id: 'it', label: 'Italian', phonemeLanguage: 'it', previewText: 'Ciao, questa e la mia voce.' },
  { id: 'pt-br', label: 'Portuguese BR', phonemeLanguage: 'pt-BR', previewText: 'Ola, esta e a minha voz.' },
  { id: 'hi', label: 'Hindi', phonemeLanguage: 'hi', previewText: 'नमस्ते, यह मेरी आवाज है.' },
]

export const VOICES: Voice[] = [
  { id: 'am_adam', name: 'Adam', locale: 'en-us', gender: 'Male', grade: 'F+' },
  { id: 'am_puck', name: 'Puck', locale: 'en-us', gender: 'Male', grade: 'C+' },
  { id: 'am_liam', name: 'Liam', locale: 'en-us', gender: 'Male', grade: 'D' },
  { id: 'af_heart', name: 'Heart', locale: 'en-us', gender: 'Female', grade: 'A' },
  { id: 'af_bella', name: 'Bella', locale: 'en-us', gender: 'Female', grade: 'A-' },
  { id: 'af_nova', name: 'Nova', locale: 'en-us', gender: 'Female', grade: 'C' },
  { id: 'af_alloy', name: 'Alloy', locale: 'en-us', gender: 'Female', grade: 'C' },
  { id: 'af_aoede', name: 'Aoede', locale: 'en-us', gender: 'Female', grade: 'C+' },
  { id: 'af_jessica', name: 'Jessica', locale: 'en-us', gender: 'Female', grade: 'D' },
  { id: 'af_kore', name: 'Kore', locale: 'en-us', gender: 'Female', grade: 'C+' },
  { id: 'af_nicole', name: 'Nicole', locale: 'en-us', gender: 'Female', grade: 'B-' },
  { id: 'af_river', name: 'River', locale: 'en-us', gender: 'Female', grade: 'D' },
  { id: 'af_sarah', name: 'Sarah', locale: 'en-us', gender: 'Female', grade: 'C+' },
  { id: 'af_sky', name: 'Sky', locale: 'en-us', gender: 'Female', grade: 'C-' },
  { id: 'am_echo', name: 'Echo', locale: 'en-us', gender: 'Male', grade: 'D' },
  { id: 'am_eric', name: 'Eric', locale: 'en-us', gender: 'Male', grade: 'D' },
  { id: 'am_fenrir', name: 'Fenrir', locale: 'en-us', gender: 'Male', grade: 'C+' },
  { id: 'am_michael', name: 'Michael', locale: 'en-us', gender: 'Male', grade: 'C+' },
  { id: 'am_onyx', name: 'Onyx', locale: 'en-us', gender: 'Male', grade: 'D' },
  { id: 'am_santa', name: 'Santa', locale: 'en-us', gender: 'Male', grade: 'D-' },
  { id: 'bf_alice', name: 'Alice', locale: 'en-gb', gender: 'Female', grade: 'D' },
  { id: 'bf_emma', name: 'Emma', locale: 'en-gb', gender: 'Female', grade: 'B-' },
  { id: 'bf_isabella', name: 'Isabella', locale: 'en-gb', gender: 'Female', grade: 'C' },
  { id: 'bf_lily', name: 'Lily', locale: 'en-gb', gender: 'Female', grade: 'D' },
  { id: 'bm_daniel', name: 'Daniel', locale: 'en-gb', gender: 'Male', grade: 'D' },
  { id: 'bm_fable', name: 'Fable', locale: 'en-gb', gender: 'Male', grade: 'C' },
  { id: 'bm_george', name: 'George', locale: 'en-gb', gender: 'Male', grade: 'C' },
  { id: 'bm_lewis', name: 'Lewis', locale: 'en-gb', gender: 'Male', grade: 'D+' },
  { id: 'jf_alpha', name: 'Alpha', locale: 'ja', gender: 'Female', grade: 'C+' },
  { id: 'jf_gongitsune', name: 'Gongitsune', locale: 'ja', gender: 'Female', grade: 'C' },
  { id: 'jf_nezumi', name: 'Nezumi', locale: 'ja', gender: 'Female', grade: 'C-' },
  { id: 'jf_tebukuro', name: 'Tebukuro', locale: 'ja', gender: 'Female', grade: 'C' },
  { id: 'jm_kumo', name: 'Kumo', locale: 'ja', gender: 'Male', grade: 'C-' },
  { id: 'zf_xiaobei', name: 'Xiaobei', locale: 'cmn', gender: 'Female', grade: 'D' },
  { id: 'zf_xiaoni', name: 'Xiaoni', locale: 'cmn', gender: 'Female', grade: 'D' },
  { id: 'zf_xiaoxiao', name: 'Xiaoxiao', locale: 'cmn', gender: 'Female', grade: 'D' },
  { id: 'zf_xiaoyi', name: 'Xiaoyi', locale: 'cmn', gender: 'Female', grade: 'D' },
  { id: 'zm_yunjian', name: 'Yunjian', locale: 'cmn', gender: 'Male', grade: 'D' },
  { id: 'zm_yunxi', name: 'Yunxi', locale: 'cmn', gender: 'Male', grade: 'D' },
  { id: 'zm_yunxia', name: 'Yunxia', locale: 'cmn', gender: 'Male', grade: 'D' },
  { id: 'zm_yunyang', name: 'Yunyang', locale: 'cmn', gender: 'Male', grade: 'D' },
  { id: 'ef_dora', name: 'Dora', locale: 'es', gender: 'Female', grade: 'C' },
  { id: 'em_alex', name: 'Alex', locale: 'es', gender: 'Male', grade: 'C' },
  { id: 'em_santa', name: 'Santa', locale: 'es', gender: 'Male', grade: 'C' },
  { id: 'ff_siwis', name: 'Siwis', locale: 'fr', gender: 'Female', grade: 'B-' },
  { id: 'hf_alpha', name: 'Alpha', locale: 'hi', gender: 'Female', grade: 'C' },
  { id: 'hf_beta', name: 'Beta', locale: 'hi', gender: 'Female', grade: 'C' },
  { id: 'hm_omega', name: 'Omega', locale: 'hi', gender: 'Male', grade: 'C' },
  { id: 'hm_psi', name: 'Psi', locale: 'hi', gender: 'Male', grade: 'C' },
  { id: 'if_sara', name: 'Sara', locale: 'it', gender: 'Female', grade: 'C' },
  { id: 'im_nicola', name: 'Nicola', locale: 'it', gender: 'Male', grade: 'C' },
  { id: 'pf_dora', name: 'Dora', locale: 'pt-br', gender: 'Female', grade: 'C' },
  { id: 'pm_alex', name: 'Alex', locale: 'pt-br', gender: 'Male', grade: 'C' },
  { id: 'pm_santa', name: 'Santa', locale: 'pt-br', gender: 'Male', grade: 'C' },
]

export const ENGLISH_KOKORO_LOCALES = new Set<KokoroLocale>(['en-us', 'en-gb'])
export const SELF_HOSTED_KOKORO_VOICE_IDS = new Set<VoiceId>(
  VOICES.filter((voice) => ENGLISH_KOKORO_LOCALES.has(voice.locale)).map((voice) => voice.id),
)

export function kokoroLanguageForLocale(locale: KokoroLocale): KokoroLanguage {
  return KOKORO_LANGUAGES.find((language) => language.id === locale) ?? KOKORO_LANGUAGES[0]
}

export function kokoroLanguageForVoice(voiceId: string): KokoroLanguage {
  const voice = VOICES.find((candidate) => candidate.id === voiceId)
  return kokoroLanguageForLocale(voice?.locale ?? 'en-us')
}

export function isEnglishKokoroLocale(locale: KokoroLocale): boolean {
  return ENGLISH_KOKORO_LOCALES.has(locale)
}
