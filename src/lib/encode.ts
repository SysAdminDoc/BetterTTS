import { encodeWav } from './wav.ts'

export type AudioFormat = 'wav' | 'mp3'

// Kokoro output is 24 kHz → MPEG-2 LSF, whose bitrate table tops out at 160 kbps.
// lamejs silently clamps higher requests, so the UI must not offer them.
export const MAX_MP3_KBPS_24K = 160

export function encodeAudio(samples: Float32Array, sampleRate: number, format: AudioFormat, bitrate = 128): Promise<Blob> {
  if (format === 'mp3') return encodeMp3(samples, sampleRate, bitrate)
  return Promise.resolve(new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' }))
}

async function encodeMp3(samples: Float32Array, sampleRate: number, kbps: number): Promise<Blob> {
  const { Mp3Encoder } = await import('@breezystack/lamejs')
  const effectiveKbps = sampleRate <= 24000 ? Math.min(kbps, MAX_MP3_KBPS_24K) : kbps
  const encoder = new Mp3Encoder(1, sampleRate, effectiveKbps)
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }

  // lamejs allocates a fresh exact-size buffer per call, so pushing the view
  // (not .buffer, whose type/lifetime the encoder owns) is safe and zero-copy.
  const chunks: BlobPart[] = []
  const blockSize = 1152
  for (let i = 0; i < pcm.length; i += blockSize) {
    const block = pcm.subarray(i, i + blockSize)
    const mp3buf = encoder.encodeBuffer(block)
    if (mp3buf.length > 0) chunks.push(mp3buf as Uint8Array<ArrayBuffer>)
  }
  const tail = encoder.flush()
  if (tail.length > 0) chunks.push(tail as Uint8Array<ArrayBuffer>)

  return new Blob(chunks, { type: 'audio/mpeg' })
}

export function formatExtension(format: AudioFormat): string {
  return format === 'mp3' ? '.mp3' : '.wav'
}

export function formatMime(format: AudioFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/wav'
}

export type BgmMixResult = {
  mixed: Float32Array
  bgmEmpty: boolean
}

export async function mixBgm(speech: Float32Array, bgmFile: File, bgmGain: number, sampleRate: number): Promise<BgmMixResult> {
  const arrayBuf = await bgmFile.arrayBuffer()
  const audioCtx = new OfflineAudioContext(1, speech.length, sampleRate)
  const bgmBuffer = await audioCtx.decodeAudioData(arrayBuf)

  const bgmLen = bgmBuffer.length
  if (bgmLen === 0) {
    return { mixed: speech, bgmEmpty: true }
  }

  const ch0 = bgmBuffer.getChannelData(0)
  const ch1 = bgmBuffer.numberOfChannels > 1 ? bgmBuffer.getChannelData(1) : null

  const mixed = new Float32Array(speech.length)
  for (let i = 0; i < speech.length; i++) {
    const j = i % bgmLen
    const bgmSample = ch1 ? (ch0[j] + ch1[j]) / 2 : ch0[j]
    mixed[i] = Math.max(-1, Math.min(1, speech[i] + bgmSample * bgmGain))
  }
  return { mixed, bgmEmpty: false }
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

  // After the real samples run out, keep feeding silence so SoundTouch's
  // pipeline latency is flushed — otherwise the final ~100 ms never leaves the
  // filter. The output loop stops once the original length is reached.
  const source = {
    extract(target: Float32Array, numFrames: number, position: number): number {
      const start = position * 2
      if (start < interleaved.length) {
        const end = Math.min(start + numFrames * 2, interleaved.length)
        const available = Math.floor((end - start) / 2)
        target.set(interleaved.subarray(start, start + available * 2))
        target.fill(0, available * 2, numFrames * 2)
        return available
      }
      target.fill(0, 0, numFrames * 2)
      return numFrames
    },
  }

  const filter = new SimpleFilter(source, st)
  const mono = new Float32Array(samples.length)
  const chunkSize = 4096
  const buf = new Float32Array(chunkSize * 2)

  let produced = 0
  // Hard cap keeps a misbehaving filter from looping forever on silence.
  let remainingIterations = Math.ceil(samples.length / chunkSize) * 4 + 64
  while (produced < samples.length && remainingIterations-- > 0) {
    const extracted = filter.extract(buf, chunkSize)
    if (extracted <= 0) break
    const usable = Math.min(extracted, samples.length - produced)
    for (let i = 0; i < usable; i++) {
      mono[produced + i] = buf[i * 2]
    }
    produced += usable
  }

  return mono
}
