import { describe, expect, it, vi } from 'vitest'
import { isSelfHostedKokoroAsset } from './kokoro-assets.ts'
import { needsDirectKokoroPath, phonemizeKokoroText } from './kokoro-multilingual.ts'
import { KOKORO_LANGUAGES, VOICES, kokoroLanguageForLocale, kokoroLanguageForVoice } from './voices.ts'

describe('Kokoro multilingual catalog', () => {
  it('exposes exactly the wired browser-safe Kokoro languages', () => {
    expect(KOKORO_LANGUAGES.map((language) => language.id)).toEqual(['en-us', 'en-gb', 'ja', 'cmn', 'es', 'fr', 'it', 'pt-br', 'hi'])
    expect(VOICES.filter((voice) => voice.locale === 'ja').map((voice) => voice.id)).toEqual(['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo'])
    expect(VOICES.filter((voice) => voice.locale === 'cmn').map((voice) => voice.id)).toEqual(['zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi', 'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang'])
    expect(VOICES.filter((voice) => voice.locale === 'es').map((voice) => voice.id)).toEqual(['ef_dora', 'em_alex', 'em_santa'])
    expect(VOICES.filter((voice) => voice.locale === 'fr').map((voice) => voice.id)).toEqual(['ff_siwis'])
    expect(VOICES.filter((voice) => voice.locale === 'hi').map((voice) => voice.id)).toEqual(['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi'])
    expect(VOICES.filter((voice) => voice.locale === 'it').map((voice) => voice.id)).toEqual(['if_sara', 'im_nicola'])
    expect(VOICES.filter((voice) => voice.locale === 'pt-br').map((voice) => voice.id)).toEqual(['pf_dora', 'pm_alex', 'pm_santa'])
  })

  it('keeps multilingual voice bins remote-only and routes them through direct synthesis', () => {
    expect(isSelfHostedKokoroAsset('voices/af_heart.bin')).toBe(true)
    expect(isSelfHostedKokoroAsset('voices/ff_siwis.bin')).toBe(false)
    expect(kokoroLanguageForVoice('pf_dora').phonemeLanguage).toBe('pt-BR')
    expect(needsDirectKokoroPath('af_heart')).toBe(false)
    expect(needsDirectKokoroPath('ff_siwis')).toBe(true)
    expect(needsDirectKokoroPath('af_heart', new Float32Array(256))).toBe(true)
  })

  it('phonemizes Romance, East Asian, and Hindi text with ephone language packs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(phonemizeKokoroText('Hola mundo.', kokoroLanguageForLocale('es'))).resolves.toContain('ola')
      await expect(phonemizeKokoroText('こんにちは。', kokoroLanguageForLocale('ja'))).resolves.toMatch(/\S/)
      await expect(phonemizeKokoroText('你好。', kokoroLanguageForLocale('cmn'))).resolves.toMatch(/\S/)
      await expect(phonemizeKokoroText('नमस्ते दुनिया.', kokoroLanguageForLocale('hi'))).resolves.toContain('nəm')
    } finally {
      warn.mockRestore()
    }
  }, 30_000)
})
