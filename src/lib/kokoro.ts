import { KOKORO_MODEL_ID, KOKORO_SAMPLE_RATE, installKokoro } from './kokoro-assets.ts'
import { probeWebGpuCapability, type WebGpuProbeResult } from './runtime-readiness.ts'

export { KOKORO_MODEL_ID, KOKORO_SAMPLE_RATE }

export type KokoroWebGpuDtype = 'fp32' | 'fp16'
export const KOKORO_WEBGPU_DTYPE_STORAGE_KEY = 'bettertts-kokoro-webgpu-dtype'
let sessionKokoroWebGpuDtype: KokoroWebGpuDtype | null = null

export function parseKokoroWebGpuDtype(value: string | null): KokoroWebGpuDtype {
  return value === 'fp16' ? 'fp16' : 'fp32'
}

export function getKokoroWebGpuDtype(): KokoroWebGpuDtype {
  if (sessionKokoroWebGpuDtype) return sessionKokoroWebGpuDtype
  if (typeof window === 'undefined') return 'fp32'
  try {
    return parseKokoroWebGpuDtype(window.localStorage.getItem(KOKORO_WEBGPU_DTYPE_STORAGE_KEY))
  } catch {
    return 'fp32'
  }
}

export function setKokoroWebGpuDtype(value: KokoroWebGpuDtype) {
  sessionKokoroWebGpuDtype = value
  try {
    window.localStorage.setItem(KOKORO_WEBGPU_DTYPE_STORAGE_KEY, value)
  } catch {
    // The in-memory preference still applies when browser storage is blocked.
  }
}

type KokoroModule = typeof import('kokoro-js')
export type KokoroInstance = Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>

export type RawAudioLike = {
  audio?: Float32Array
  sampling_rate?: number
  toBlob?: () => Blob
}

export type ProgressInfo = {
  status?: string
  name?: string
  file?: string
  progress?: number
  loaded?: number
  total?: number
  files?: Record<string, { loaded: number; total: number }>
}

let kokoroPromise: Promise<KokoroInstance> | null = null

export async function probeWebGpu(): Promise<boolean> {
  return (await probeWebGpuCapability()).usable
}

export async function probeWebGpuDetails(): Promise<WebGpuProbeResult> {
  return probeWebGpuCapability()
}

export async function loadKokoro(onProgress: (info: ProgressInfo) => void, webGpuDtype: KokoroWebGpuDtype = getKokoroWebGpuDtype()): Promise<KokoroInstance> {
  if (kokoroPromise) return kokoroPromise

  await installKokoro()

  const [{ KokoroTTS }, hasWebGpu] = await Promise.all([
    import('kokoro-js'),
    probeWebGpu(),
  ])

  const device = hasWebGpu ? ('webgpu' as const) : ('wasm' as const)
  const dtype = hasWebGpu ? webGpuDtype : ('q8' as const)

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
