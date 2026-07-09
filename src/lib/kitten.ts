export const KITTEN_SAMPLE_RATE = 24000
export const KITTEN_DEFAULT_MODEL = 'nano'
export const KITTEN_PREVIEW_TEXT = 'This is KittenTTS running locally in your browser.'

export type KittenVoiceId = 'Bella' | 'Luna' | 'Rosie' | 'Kiki' | 'Jasper' | 'Bruno' | 'Hugo' | 'Leo'
export type KittenModelSize = 'nano' | 'micro' | 'mini'

export type KittenVoice = {
  id: KittenVoiceId
  name: string
  gender: 'Female' | 'Male'
}

export type KittenModel = {
  id: KittenModelSize
  label: string
  params: string
  weightSize: string
}

export const KITTEN_VOICES: KittenVoice[] = [
  { id: 'Bella', name: 'Bella', gender: 'Female' },
  { id: 'Luna', name: 'Luna', gender: 'Female' },
  { id: 'Rosie', name: 'Rosie', gender: 'Female' },
  { id: 'Kiki', name: 'Kiki', gender: 'Female' },
  { id: 'Jasper', name: 'Jasper', gender: 'Male' },
  { id: 'Bruno', name: 'Bruno', gender: 'Male' },
  { id: 'Hugo', name: 'Hugo', gender: 'Male' },
  { id: 'Leo', name: 'Leo', gender: 'Male' },
]

export const KITTEN_MODELS: KittenModel[] = [
  { id: 'nano', label: 'Nano', params: '15M', weightSize: '24 MB' },
  { id: 'micro', label: 'Micro', params: '40M', weightSize: '41 MB' },
  { id: 'mini', label: 'Mini', params: '80M', weightSize: '78 MB' },
]

export type KittenSynthesizedAudio = {
  samples: Float32Array
  sampleRate: number
}

export function clampKittenSpeed(speed: number): number {
  return Math.min(2, Math.max(0.5, speed))
}

export function hasKittenWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

export async function synthesizeKitten(
  text: string,
  voiceId: KittenVoiceId,
  speed: number,
  model: KittenModelSize = KITTEN_DEFAULT_MODEL,
  onProgress: (stage: string) => void = () => {},
): Promise<KittenSynthesizedAudio | null> {
  if (!hasKittenWebGpu()) throw new Error('KittenTTS requires WebGPU. Use Kokoro or Browser fallback on this device.')
  const { textToSpeech } = await import('kitten-tts-webgpu')
  const wav = await textToSpeech(text, {
    voice: voiceId,
    speed: clampKittenSpeed(speed),
    model,
    onProgress,
  })
  return wavBlobToFloat32(wav)
}

export async function wavBlobToFloat32(blob: Blob): Promise<KittenSynthesizedAudio> {
  const buffer = await blob.arrayBuffer()
  const view = new DataView(buffer)
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('KittenTTS returned an invalid WAV payload.')
  }

  let format = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = 0
  let dataLength = 0
  let offset = 12

  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(start, true)
      channels = view.getUint16(start + 2, true)
      sampleRate = view.getUint32(start + 4, true)
      bitsPerSample = view.getUint16(start + 14, true)
    } else if (id === 'data') {
      dataOffset = start
      dataLength = size
    }
    offset = start + size + (size % 2)
  }

  if (format !== 1 || channels < 1 || sampleRate <= 0 || bitsPerSample !== 16 || dataLength <= 0) {
    throw new Error('KittenTTS returned an unsupported WAV format.')
  }

  const bytesPerSample = bitsPerSample / 8
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels))
  const samples = new Float32Array(frameCount)
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0
    for (let ch = 0; ch < channels; ch += 1) {
      const sampleOffset = dataOffset + (frame * channels + ch) * bytesPerSample
      sum += view.getInt16(sampleOffset, true) / 0x8000
    }
    samples[frame] = sum / channels
  }

  return { samples, sampleRate }
}

function readAscii(view: DataView, offset: number, length: number): string {
  let value = ''
  for (let i = 0; i < length; i += 1) value += String.fromCharCode(view.getUint8(offset + i))
  return value
}
