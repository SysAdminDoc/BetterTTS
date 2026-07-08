export type VoiceId =
  | 'am_adam' | 'am_puck' | 'am_liam' | 'af_heart' | 'af_bella' | 'af_nova'
  | 'af_alloy' | 'af_jessica' | 'af_kore' | 'af_nicole' | 'af_river' | 'af_sarah'
  | 'am_echo' | 'am_eric' | 'am_fenrir' | 'am_michael' | 'am_onyx' | 'am_santa'
  | 'bf_alice' | 'bf_emma' | 'bf_isabella' | 'bf_lily'
  | 'bm_daniel' | 'bm_fable' | 'bm_george' | 'bm_lewis'

export type Voice = {
  id: VoiceId
  name: string
  locale: 'en-us' | 'en-gb'
  gender: 'Female' | 'Male'
  grade: string
}

export const VOICES: Voice[] = [
  { id: 'am_adam', name: 'Adam', locale: 'en-us', gender: 'Male', grade: 'F+' },
  { id: 'am_puck', name: 'Puck', locale: 'en-us', gender: 'Male', grade: 'C+' },
  { id: 'am_liam', name: 'Liam', locale: 'en-us', gender: 'Male', grade: 'D' },
  { id: 'af_heart', name: 'Heart', locale: 'en-us', gender: 'Female', grade: 'A' },
  { id: 'af_bella', name: 'Bella', locale: 'en-us', gender: 'Female', grade: 'A-' },
  { id: 'af_nova', name: 'Nova', locale: 'en-us', gender: 'Female', grade: 'C' },
  { id: 'af_alloy', name: 'Alloy', locale: 'en-us', gender: 'Female', grade: 'C' },
  { id: 'af_jessica', name: 'Jessica', locale: 'en-us', gender: 'Female', grade: 'D' },
  { id: 'af_kore', name: 'Kore', locale: 'en-us', gender: 'Female', grade: 'C+' },
  { id: 'af_nicole', name: 'Nicole', locale: 'en-us', gender: 'Female', grade: 'B-' },
  { id: 'af_river', name: 'River', locale: 'en-us', gender: 'Female', grade: 'D' },
  { id: 'af_sarah', name: 'Sarah', locale: 'en-us', gender: 'Female', grade: 'C+' },
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
]
