import { KOKORO_MODEL_ID, installKokoroAssetFallback } from '../lib/kokoro-assets.ts'
import type { ProgressInfo } from '../lib/kokoro.ts'

type KokoroModule = typeof import('kokoro-js')
type KokoroInstance = Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>

export type WorkerRequest =
  | { type: 'load'; device: 'webgpu' | 'wasm'; dtype: 'fp32' | 'q8' }
  | { type: 'generate'; text: string; voice: string; speed: number; id: number; voiceBin?: Float32Array }

export type WorkerResponse =
  | { type: 'progress'; info: ProgressInfo }
  | { type: 'loaded' }
  | { type: 'loadError'; message: string }
  | { type: 'generated'; samples: Float32Array; id: number }
  | { type: 'generateError'; message: string; id: number }

let tts: KokoroInstance | null = null
let loadedKey = ''

self.addEventListener('message', async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data

  if (msg.type === 'load') {
    const key = `${msg.device}:${msg.dtype}`
    if (tts && loadedKey === key) {
      self.postMessage({ type: 'loaded' } satisfies WorkerResponse)
      return
    }
    try {
      installKokoroAssetFallback()
      const { KokoroTTS } = await import('kokoro-js')
      tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        device: msg.device,
        dtype: msg.dtype,
        progress_callback: (info) => {
          self.postMessage({ type: 'progress', info: info as ProgressInfo } satisfies WorkerResponse)
        },
      })
      loadedKey = key
      self.postMessage({ type: 'loaded' } satisfies WorkerResponse)
    } catch (err) {
      tts = null
      loadedKey = ''
      self.postMessage({ type: 'loadError', message: err instanceof Error ? err.message : 'Model load failed' } satisfies WorkerResponse)
    }
    return
  }

  if (msg.type === 'generate') {
    if (!tts) {
      self.postMessage({ type: 'generateError', message: 'Model not loaded', id: msg.id } satisfies WorkerResponse)
      return
    }
    try {
      let samples: Float32Array | undefined

      if (msg.voiceBin) {
        // Voice-mix path: replicate kokoro-js's generate pipeline with a
        // custom blended style tensor instead of looking up a named voice bin.
        const { Tensor } = await import('@huggingface/transformers')
        const { phonemize } = await import('phonemizer')
        const langCode = msg.voice.charAt(0) === 'a' ? 'en-us' : 'en'
        const phonemeArr = await phonemize(msg.text, langCode) as string[]
        const phonemes = phonemeArr.join(' ')
        const tokenized = (tts as unknown as { tokenizer(text: string, opts: { truncation: boolean }): { input_ids: { dims: readonly number[] } } })
          .tokenizer(phonemes, { truncation: true })
        const numTokens = tokenized.input_ids.dims.at(-1) ?? 0
        const offset = 256 * Math.min(Math.max(numTokens - 2, 0), 509)
        const styleSlice = msg.voiceBin.slice(offset, offset + 256)
        const { waveform } = await (tts as unknown as { model(input: unknown): Promise<{ waveform: { data: Float32Array } }> }).model({
          input_ids: tokenized.input_ids,
          style: new Tensor('float32', styleSlice, [1, 256]),
          speed: new Tensor('float32', [msg.speed], [1]),
        })
        samples = waveform.data
      } else {
        const audio = (await tts.generate(msg.text, { voice: msg.voice as never, speed: msg.speed })) as { audio?: Float32Array }
        samples = audio.audio
      }

      if (samples) {
        self.postMessage(
          { type: 'generated', samples, id: msg.id } satisfies WorkerResponse,
          { transfer: [samples.buffer as ArrayBuffer] },
        )
      } else {
        self.postMessage({ type: 'generateError', message: 'No audio produced', id: msg.id } satisfies WorkerResponse)
      }
    } catch (err) {
      self.postMessage({ type: 'generateError', message: err instanceof Error ? err.message : 'Generation failed', id: msg.id } satisfies WorkerResponse)
    }
  }
})
