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

export async function mixBgm(speech: Float32Array, bgmFile: File, bgmGain: number, sampleRate: number): Promise<Float32Array> {
  const arrayBuf = await bgmFile.arrayBuffer()
  const audioCtx = new OfflineAudioContext(1, speech.length, sampleRate)
  const bgmBuffer = await audioCtx.decodeAudioData(arrayBuf)

  const bgmMono = bgmBuffer.getChannelData(0)
  const looped = new Float32Array(speech.length)
  for (let i = 0; i < speech.length; i++) {
    looped[i] = bgmMono[i % bgmMono.length] * bgmGain
  }

  const mixed = new Float32Array(speech.length)
  for (let i = 0; i < speech.length; i++) {
    mixed[i] = Math.max(-1, Math.min(1, speech[i] + looped[i]))
  }
  return mixed
}

export async function shiftPitch(samples: Float32Array, semitones: number): Promise<Float32Array> {
  if (semitones === 0) return samples
  const { SoundTouch, SimpleFilter } = await import('soundtouchjs')

  const st = new SoundTouch()
  st.pitchSemitones = semitones

  const interleaved = new Float32Array(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    interleaved[i * 2] = samples[i]
    interleaved[i * 2 + 1] = samples[i]
  }

  const source = {
    extract(target: Float32Array, numFrames: number, position: number): number {
      const start = position * 2
      const end = Math.min(start + numFrames * 2, interleaved.length)
      const available = Math.floor((end - start) / 2)
      if (available <= 0) return 0
      target.set(interleaved.subarray(start, start + available * 2))
      return available
    },
  }

  const filter = new SimpleFilter(source, st)
  const outChunks: Float32Array[] = []
  const chunkSize = 4096
  const buf = new Float32Array(chunkSize * 2)

  let extracted: number
  do {
    extracted = filter.extract(buf, chunkSize)
    if (extracted > 0) {
      outChunks.push(new Float32Array(buf.subarray(0, extracted * 2)))
    }
  } while (extracted > 0)

  let totalLen = 0
  for (const c of outChunks) totalLen += c.length / 2
  const mono = new Float32Array(totalLen)
  let offset = 0
  for (const c of outChunks) {
    for (let i = 0; i < c.length; i += 2) {
      mono[offset++] = c[i]
    }
  }

  return mono
}
