export const CHATTERBOX_SAMPLE_RATE = 24000
export const CHATTERBOX_ENGLISH_MODEL_ID = 'onnx-community/chatterbox-ONNX'
export const CHATTERBOX_MULTILINGUAL_MODEL_ID = 'onnx-community/chatterbox-multilingual-ONNX'
export const CHATTERBOX_DEFAULT_EXAGGERATION = 0.5
export const CHATTERBOX_MAX_NEW_TOKENS = 2048
export const CHATTERBOX_MAX_REFERENCE_BYTES = 15 * 1024 * 1024
export const CHATTERBOX_MIN_REFERENCE_SECONDS = 0.5
export const CHATTERBOX_MAX_REFERENCE_SECONDS = 30

export const CHATTERBOX_LANGUAGES = [
  { id: 'ar', label: 'Arabic' },
  { id: 'da', label: 'Danish' },
  { id: 'de', label: 'German' },
  { id: 'el', label: 'Greek' },
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Spanish' },
  { id: 'fi', label: 'Finnish' },
  { id: 'fr', label: 'French' },
  { id: 'he', label: 'Hebrew' },
  { id: 'hi', label: 'Hindi' },
  { id: 'it', label: 'Italian' },
  { id: 'ja', label: 'Japanese' },
  { id: 'ko', label: 'Korean' },
  { id: 'ms', label: 'Malay' },
  { id: 'nl', label: 'Dutch' },
  { id: 'no', label: 'Norwegian' },
  { id: 'pl', label: 'Polish' },
  { id: 'pt', label: 'Portuguese' },
  { id: 'ru', label: 'Russian' },
  { id: 'sv', label: 'Swedish' },
  { id: 'sw', label: 'Swahili' },
  { id: 'tr', label: 'Turkish' },
  { id: 'zh', label: 'Chinese' },
] as const

export type ChatterboxModelVariant = 'english' | 'multilingual'
export type ChatterboxLanguageId = typeof CHATTERBOX_LANGUAGES[number]['id']

export function chatterboxModelId(variant: ChatterboxModelVariant): string {
  return variant === 'multilingual' ? CHATTERBOX_MULTILINGUAL_MODEL_ID : CHATTERBOX_ENGLISH_MODEL_ID
}

export function chatterboxModelLabel(variant: ChatterboxModelVariant): string {
  return variant === 'multilingual' ? 'Chatterbox multilingual (23 languages)' : 'Chatterbox English'
}

export function chatterboxLanguageLabel(language: ChatterboxLanguageId): string {
  return CHATTERBOX_LANGUAGES.find((item) => item.id === language)?.label ?? language
}

export function chatterboxPrompt(text: string, variant: ChatterboxModelVariant, language: ChatterboxLanguageId): string {
  return variant === 'multilingual' ? `[${language}] ${text}` : text
}

export function clampChatterboxExaggeration(value: number): number {
  return Math.min(2, Math.max(0, Number.isFinite(value) ? value : CHATTERBOX_DEFAULT_EXAGGERATION))
}
