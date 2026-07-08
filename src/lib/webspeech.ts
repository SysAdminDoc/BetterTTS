import { splitIntoSentences } from './text.ts'

function getBrowserVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis
  const voices = synth.getVoices()
  if (voices.length > 0) return Promise.resolve(voices)

  return new Promise((resolve) => {
    const onReady = () => {
      synth.removeEventListener('voiceschanged', onReady)
      resolve(synth.getVoices())
    }
    synth.addEventListener('voiceschanged', onReady)
    setTimeout(() => {
      synth.removeEventListener('voiceschanged', onReady)
      resolve(synth.getVoices())
    }, 2000)
  })
}

export async function speakBrowser(text: string, speed: number, chosenVoice?: SpeechSynthesisVoice) {
  if (!('speechSynthesis' in window)) {
    throw new Error('This browser does not expose speech synthesis.')
  }

  const synth = window.speechSynthesis
  synth.cancel()

  const voice = chosenVoice ?? (await getBrowserVoices()).find((v) => v.lang.toLowerCase().startsWith('en')) ?? null
  const chunks = splitIntoSentences(text)
  const rate = Math.max(0.5, Math.min(1.5, speed))

  for (const chunk of chunks) {
    await new Promise<void>((resolve, reject) => {
      const utt = new SpeechSynthesisUtterance(chunk)
      utt.rate = rate
      utt.voice = voice
      utt.onend = () => resolve()
      utt.onerror = (ev) => {
        if (ev.error === 'interrupted' || ev.error === 'canceled') resolve()
        else reject(new Error('Browser speech playback failed.'))
      }

      const watchdog = setTimeout(() => {
        synth.cancel()
        resolve()
      }, 20000)
      const origEnd = utt.onend
      utt.onend = (e) => {
        clearTimeout(watchdog)
        origEnd?.call(utt, e)
      }

      synth.speak(utt)
    })
  }
}
