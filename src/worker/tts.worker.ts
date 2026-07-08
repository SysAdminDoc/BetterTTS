import { KOKORO_MODEL_ID, type ProgressInfo } from '../lib/kokoro.ts'

type KokoroModule = typeof import('kokoro-js')
type KokoroInstance = Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>

export type WorkerRequest =
  | { type: 'load'; device: 'webgpu' | 'wasm'; dtype: 'fp32' | 'q8' }
  | { type: 'generate'; text: string; voice: string; speed: number; id: number }

export type WorkerResponse =
  | { type: 'progress'; info: ProgressInfo }
  | { type: 'loaded' }
  | { type: 'loadError'; message: string }
  | { type: 'generated'; samples: Float32Array; id: number }
  | { type: 'generateError'; message: string; id: number }

let tts: KokoroInstance | null = null

self.addEventListener('message', async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data

  if (msg.type === 'load') {
    try {
      const { KokoroTTS } = await import('kokoro-js')
      tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        device: msg.device,
        dtype: msg.dtype,
        progress_callback: (info) => {
          self.postMessage({ type: 'progress', info: info as ProgressInfo } satisfies WorkerResponse)
        },
      })
      self.postMessage({ type: 'loaded' } satisfies WorkerResponse)
    } catch (err) {
      tts = null
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
      const audio = await tts.generate(msg.text, { voice: msg.voice as never, speed: msg.speed })
      const samples = (audio as { audio?: Float32Array }).audio
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
