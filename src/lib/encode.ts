import { encodeWav } from './wav.ts'

export type AudioFormat = 'wav' | 'mp3'

export function encodeAudio(samples: Float32Array, sampleRate: number, format: AudioFormat, bitrate = 192): Promise<Blob> {
  if (format === 'mp3') return encodeMp3(samples, sampleRate, bitrate)
  return Promise.resolve(new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' }))
}

async function encodeMp3(samples: Float32Array, sampleRate: number, kbps: number): Promise<Blob> {
  const { Mp3Encoder } = await import('@breezystack/lamejs')
  const encoder = new Mp3Encoder(1, sampleRate, kbps)
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }

  const chunks: ArrayBuffer[] = []
  const blockSize = 1152
  for (let i = 0; i < pcm.length; i += blockSize) {
    const block = pcm.subarray(i, i + blockSize)
    const mp3buf = encoder.encodeBuffer(block)
    if (mp3buf.length > 0) chunks.push(mp3buf.buffer as ArrayBuffer)
  }
  const tail = encoder.flush()
  if (tail.length > 0) chunks.push(tail.buffer as ArrayBuffer)

  return new Blob(chunks, { type: 'audio/mpeg' })
}

export function formatExtension(format: AudioFormat): string {
  return format === 'mp3' ? '.mp3' : '.wav'
}

export function formatMime(format: AudioFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/wav'
}
