export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
export const KOKORO_SAMPLE_RATE = 24000

type KokoroModule = typeof import('kokoro-js')
export type KokoroInstance = Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>

export type RawAudioLike = {
  audio?: Float32Array
  sampling_rate?: number
  toBlob?: () => Blob
}

export type ProgressInfo = {
  status?: string
  file?: string
  progress?: number
  loaded?: number
  total?: number
}

let kokoroPromise: Promise<KokoroInstance> | null = null

export async function probeWebGpu(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false
  try {
    const gpu = navigator.gpu as { requestAdapter(): Promise<unknown | null> }
    const adapter = await gpu.requestAdapter()
    return adapter != null
  } catch {
    return false
  }
}

export async function loadKokoro(onProgress: (info: ProgressInfo) => void): Promise<KokoroInstance> {
  if (kokoroPromise) return kokoroPromise

  const [{ KokoroTTS }, hasWebGpu] = await Promise.all([
    import('kokoro-js'),
    probeWebGpu(),
  ])

  const device = hasWebGpu ? ('webgpu' as const) : ('wasm' as const)
  const dtype = hasWebGpu ? ('fp32' as const) : ('q8' as const)

  const promise = KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
    device,
    dtype,
    progress_callback: (info) => onProgress(info as ProgressInfo),
  })
  kokoroPromise = promise

  try {
    return await promise
  } catch (err) {
    kokoroPromise = null
    if (hasWebGpu) {
      const fallback = KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: (info) => onProgress(info as ProgressInfo),
      })
      kokoroPromise = fallback
      try {
        return await fallback
      } catch {
        kokoroPromise = null
        throw err
      }
    }
    throw err
  }
}

export function resetKokoroSession() {
  kokoroPromise = null
}
