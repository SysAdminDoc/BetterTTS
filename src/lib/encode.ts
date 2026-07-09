import { encodeWav } from './wav.ts'

export type AudioFormat = 'wav' | 'mp3' | 'opus'

// Kokoro output is 24 kHz → MPEG-2 LSF, whose bitrate table tops out at 160 kbps.
// lamejs silently clamps higher requests, so the UI must not offer them.
export const MAX_MP3_KBPS_24K = 160
// MPEG-1/2/2.5 define exactly these sample rates. lamejs behavior outside the
// table is undefined (silent garbage), so unsupported rates must fail loudly
// BEFORE encoding — the ≥88.2 kHz AAC crash class, one format over.
export const MP3_SUPPORTED_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000] as const
const DEFAULT_PITCH_SAMPLE_RATE = 24000
const SIGNALSMITH_RENDER_GUARD_SECONDS = 0.25

export function encodeAudio(samples: Float32Array, sampleRate: number, format: AudioFormat, bitrate = 128): Promise<Blob> {
  if (samples.length === 0) {
    return Promise.reject(new Error('No audio samples to encode — the export would be an empty file.'))
  }
  if (format === 'mp3' && !(MP3_SUPPORTED_RATES as readonly number[]).includes(sampleRate)) {
    return Promise.reject(new Error(`MP3 cannot encode ${sampleRate} Hz audio — export WAV or Opus instead.`))
  }
  if (format === 'mp3') return encodeMp3(samples, sampleRate, bitrate)
  if (format === 'opus') return encodeOpus(samples, sampleRate, bitrate)
  return Promise.resolve(new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' }))
}

export function opusSupported(): boolean {
  return typeof AudioEncoder !== 'undefined'
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

async function encodeOpus(samples: Float32Array, sampleRate: number, kbps: number): Promise<Blob> {
  if (typeof AudioEncoder === 'undefined') throw new Error('Opus encoding requires a browser with WebCodecs AudioEncoder')

  // WebCodecs Opus encoder works at 48 kHz; resample if source differs.
  let pcm = samples
  if (sampleRate !== 48000) {
    const ratio = 48000 / sampleRate
    const resampled = new Float32Array(Math.ceil(samples.length * ratio))
    for (let i = 0; i < resampled.length; i++) {
      const srcIdx = i / ratio
      const lo = Math.floor(srcIdx)
      const hi = Math.min(lo + 1, samples.length - 1)
      const frac = srcIdx - lo
      resampled[i] = samples[lo] * (1 - frac) + samples[hi] * frac
    }
    pcm = resampled
    sampleRate = 48000
  }

  const chunks: Uint8Array[] = []
  let codecDescription: Uint8Array | null = null

  const encoder = new AudioEncoder({
    output(chunk, metadata) {
      // The encoder's real OpusHead (with its actual pre-skip) arrives with the
      // first chunk — use it as CodecPrivate instead of a synthetic zero-skip one.
      const description = metadata?.decoderConfig?.description
      if (!codecDescription && description) {
        const bytes = ArrayBuffer.isView(description)
          ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
          : new Uint8Array(description)
        const copy = new Uint8Array(new ArrayBuffer(bytes.length))
        copy.set(bytes)
        codecDescription = copy
      }
      const buf = new Uint8Array(chunk.byteLength)
      chunk.copyTo(buf)
      chunks.push(buf)
    },
    error(err) {
      console.error('Opus encode error', err)
    },
  })

  encoder.configure({
    codec: 'opus',
    sampleRate,
    numberOfChannels: 1,
    bitrate: kbps * 1000,
  })

  const frameSize = 960
  for (let i = 0; i < pcm.length; i += frameSize) {
    const end = Math.min(i + frameSize, pcm.length)
    const frame = pcm.subarray(i, end)
    // Pad the last frame to a full 960 samples so the encoder accepts it.
    const padded = frame.length < frameSize ? (() => {
      const buf = new Float32Array(frameSize)
      buf.set(frame)
      return buf
    })() : frame
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: frameSize,
      numberOfChannels: 1,
      timestamp: Math.round((i / sampleRate) * 1_000_000),
      data: padded as Float32Array<ArrayBuffer>,
    })
    encoder.encode(audioData)
    audioData.close()
  }

  await encoder.flush()
  encoder.close()

  // Wrap raw Opus frames in a minimal WebM container (universally playable).
  const paddedSamples = pcm.length % frameSize === 0 ? 0 : frameSize - (pcm.length % frameSize)
  return buildWebmOpus(chunks as Uint8Array<ArrayBuffer>[], sampleRate, pcm.length, codecDescription, paddedSamples)
}

// Minimal WebM/Matroska container for Opus audio. The EBML header, Segment,
// Info, Tracks, and Cluster elements are hand-crafted to avoid pulling in a
// large muxer dependency for a single-track audio-only use case.
// Exported for tests (WebCodecs is unavailable in the test environment).
export function buildWebmOpus(
  opusFrames: Uint8Array[],
  sampleRate: number,
  totalSamples: number,
  codecDescription: Uint8Array | null = null,
  paddedSamples = 0,
): Blob {
  const durationMs = (totalSamples / sampleRate) * 1000

  // Prefer the encoder-provided OpusHead (carries the real pre-skip); fall
  // back to a synthetic RFC 7845 identification header.
  let codecPrivate = codecDescription
  if (!codecPrivate || codecPrivate.length < 19) {
    codecPrivate = new Uint8Array(19)
    const cpView = new DataView(codecPrivate.buffer)
    codecPrivate.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]) // "OpusHead"
    codecPrivate[8] = 1 // version
    codecPrivate[9] = 1 // channel count
    cpView.setUint16(10, 0, true) // pre-skip
    cpView.setUint32(12, sampleRate, true) // input sample rate
    cpView.setInt16(16, 0, true) // output gain
    codecPrivate[18] = 0 // mapping family
  }
  const preSkipSamples = new DataView(codecPrivate.buffer, codecPrivate.byteOffset).getUint16(10, true)

  const parts: Uint8Array[] = []

  // EBML header
  parts.push(ebml(0x1a45dfa3, [
    ebmlUint(0x4286, 1), // EBMLVersion
    ebmlUint(0x42f7, 1), // EBMLReadVersion
    ebmlUint(0x42f2, 4), // EBMLMaxIDLength
    ebmlUint(0x42f3, 8), // EBMLMaxSizeLength
    ebmlStr(0x4282, 'webm'), // DocType
    ebmlUint(0x4287, 4), // DocTypeVersion
    ebmlUint(0x4285, 2), // DocTypeReadVersion
  ]))

  // SimpleBlock timestamps are a SIGNED int16 relative to their Cluster's
  // timecode (max +32.767 s), so clusters must roll over well before that —
  // a single cluster silently corrupts timestamps past 32.7 s of audio.
  const frameDurationMs = 20 // 960 samples at 48 kHz
  const framesPerCluster = 250 // 5 s per cluster, matching common muxers
  const clusters: Uint8Array[] = []
  for (let start = 0; start < opusFrames.length; start += framesPerCluster) {
    const clusterTimeMs = start * frameDurationMs
    const end = Math.min(start + framesPerCluster, opusFrames.length)
    const clusterParts: Uint8Array[] = [ebmlUint(0xe7, clusterTimeMs)] // Timecode
    for (let i = start; i < end; i++) {
      const relativeTs = i * frameDurationMs - clusterTimeMs
      const isLastFrame = i === opusFrames.length - 1
      if (isLastFrame && paddedSamples > 0) {
        // Declare the zero-padding appended to fill the final frame so players
        // trim it instead of appending up to 20 ms of undeclared silence.
        const discardPaddingNs = Math.round((paddedSamples / 48000) * 1_000_000_000)
        clusterParts.push(ebml(0xa0, [ // BlockGroup
          buildBlock(0xa1, 1, relativeTs, opusFrames[i], 0x00),
          ebmlSint(0x75a2, discardPaddingNs), // DiscardPadding
        ]))
      } else {
        clusterParts.push(buildBlock(0xa3, 1, relativeTs, opusFrames[i], 0x80)) // SimpleBlock, keyframe
      }
    }
    clusters.push(ebml(0x1f43b675, clusterParts))
  }

  // Tracks element
  const trackEntry = ebml(0xae, [
    ebmlUint(0xd7, 1), // TrackNumber
    ebmlUint(0x73c5, 1), // TrackUID
    ebmlUint(0x83, 2), // TrackType = audio
    ebmlStr(0x86, 'A_OPUS'), // CodecID
    ebmlUint(0x56aa, Math.round((preSkipSamples / 48000) * 1_000_000_000)), // CodecDelay
    ebmlUint(0x56bb, 80_000_000), // SeekPreRoll (80 ms per WebM-Opus guidelines)
    ebmlBin(0x63a2, codecPrivate), // CodecPrivate
    ebml(0xe1, [ // Audio
      ebmlFloat(0xb5, sampleRate), // SamplingFrequency
      ebmlUint(0x9f, 1), // Channels
    ]),
  ])
  const tracks = ebml(0x1654ae6b, [trackEntry])

  // Info element
  const info = ebml(0x1549a966, [
    ebmlUint(0x2ad7b1, 1000000), // TimecodeScale = 1ms
    ebmlFloat(0x4489, durationMs), // Duration
    ebmlStr(0x4d80, 'BetterTTS'), // MuxingApp
    ebmlStr(0x5741, 'BetterTTS'), // WritingApp
  ])

  // Segment (unknown size)
  const segmentContent = concat([info, tracks, ...clusters])
  parts.push(ebmlUnknownSize(0x18538067, segmentContent))

  return new Blob(parts as Uint8Array<ArrayBuffer>[], { type: 'audio/webm;codecs=opus' })
}

function ebmlId(id: number): Uint8Array {
  if (id <= 0xff) return new Uint8Array([id])
  if (id <= 0xffff) return new Uint8Array([(id >> 8) & 0xff, id & 0xff])
  if (id <= 0xffffff) return new Uint8Array([(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff])
  return new Uint8Array([(id >> 24) & 0xff, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff])
}

function ebmlSize(size: number): Uint8Array {
  if (size < 0x7f) return new Uint8Array([size | 0x80])
  if (size < 0x3fff) return new Uint8Array([((size >> 8) & 0x3f) | 0x40, size & 0xff])
  if (size < 0x1fffff) return new Uint8Array([((size >> 16) & 0x1f) | 0x20, (size >> 8) & 0xff, size & 0xff])
  if (size < 0x0fffffff) return new Uint8Array([((size >> 24) & 0x0f) | 0x10, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff])
  const buf = new Uint8Array(8)
  buf[0] = 0x01
  const dv = new DataView(buf.buffer)
  dv.setUint32(4, size)
  return buf
}

function ebml(id: number, children: Uint8Array[]): Uint8Array {
  const body = concat(children)
  return concat([ebmlId(id), ebmlSize(body.length), body])
}

function ebmlUnknownSize(id: number, body: Uint8Array): Uint8Array {
  // Write the body with its actual known size rather than the EBML unknown-size
  // marker, so players can seek. This is valid Matroska.
  return concat([ebmlId(id), ebmlSize(body.length), body])
}

function ebmlUint(id: number, value: number): Uint8Array {
  const bytes: number[] = []
  let v = value
  do {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  } while (v > 0)
  return concat([ebmlId(id), ebmlSize(bytes.length), new Uint8Array(bytes)])
}

function ebmlFloat(id: number, value: number): Uint8Array {
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setFloat64(0, value)
  return concat([ebmlId(id), ebmlSize(8), buf])
}

function ebmlStr(id: number, value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value)
  return concat([ebmlId(id), ebmlSize(encoded.length), encoded])
}

function ebmlBin(id: number, data: Uint8Array): Uint8Array {
  return concat([ebmlId(id), ebmlSize(data.length), data])
}

// Shared layout for SimpleBlock (0xa3, flags carry keyframe bit) and Block
// (0xa1, inside a BlockGroup, flags 0). Relative timestamps are signed int16;
// callers must keep them within a cluster's ±32767 ms window.
function buildBlock(id: number, trackNum: number, timestampMs: number, frameData: Uint8Array, flags: number): Uint8Array {
  const header = new Uint8Array(4)
  header[0] = 0x80 | trackNum // track number VINT
  header[1] = (timestampMs >> 8) & 0xff
  header[2] = timestampMs & 0xff
  header[3] = flags
  const body = concat([header, frameData])
  return concat([ebmlId(id), ebmlSize(body.length), body])
}

// EBML signed integer (big-endian two's complement, minimal length).
function ebmlSint(id: number, value: number): Uint8Array {
  const bytes: number[] = []
  let v = value
  do {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  } while (v > 0)
  // Prepend a zero byte if the high bit is set, so a positive value is not
  // misread as negative two's complement.
  if (bytes[0] & 0x80) bytes.unshift(0)
  return concat([ebmlId(id), ebmlSize(bytes.length), new Uint8Array(bytes)])
}

function concat(arrays: Uint8Array[]): Uint8Array {
  let total = 0
  for (const a of arrays) total += a.length
  const result = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    result.set(a, offset)
    offset += a.length
  }
  return result
}

export function formatExtension(format: AudioFormat): string {
  if (format === 'mp3') return '.mp3'
  if (format === 'opus') return '.webm'
  return '.wav'
}

export function formatMime(format: AudioFormat): string {
  if (format === 'mp3') return 'audio/mpeg'
  if (format === 'opus') return 'audio/webm'
  return 'audio/wav'
}

export function formatFromFilename(filename: string): AudioFormat {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.mp3')) return 'mp3'
  if (lower.endsWith('.webm')) return 'opus'
  return 'wav'
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

export async function shiftPitch(samples: Float32Array, semitones: number, sampleRate = DEFAULT_PITCH_SAMPLE_RATE): Promise<Float32Array> {
  if (semitones === 0) return samples
  if (canRenderSignalsmithOffline()) {
    try {
      return await shiftPitchWithSignalsmith(samples, semitones, sampleRate)
    } catch (err) {
      if (typeof window !== 'undefined') throw err
    }
  }

  return shiftPitchFallback(samples, semitones)
}

function canRenderSignalsmithOffline(): boolean {
  return typeof OfflineAudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined'
}

async function shiftPitchWithSignalsmith(samples: Float32Array, semitones: number, sampleRate: number): Promise<Float32Array> {
  const guardSamples = Math.ceil(sampleRate * SIGNALSMITH_RENDER_GUARD_SECONDS)
  const audioCtx = new OfflineAudioContext(1, samples.length + guardSamples, sampleRate)
  if (!audioCtx.audioWorklet) throw new Error('Signalsmith Stretch requires OfflineAudioContext.audioWorklet')

  const { default: SignalsmithStretch } = await import('signalsmith-stretch')
  const stretch = await SignalsmithStretch(audioCtx, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  })

  await stretch.addBuffers([new Float32Array(samples)])
  stretch.connect(audioCtx.destination)
  await stretch.start(0, 0, undefined, 1, semitones)

  const rendered = await audioCtx.startRendering()
  stretch.disconnect()
  return copyExactLength(rendered.getChannelData(0), samples.length)
}

function copyExactLength(samples: Float32Array, length: number): Float32Array {
  const out = new Float32Array(length)
  out.set(samples.subarray(0, length))
  return out
}

function shiftPitchFallback(samples: Float32Array, semitones: number): Float32Array {
  const out = new Float32Array(samples.length)
  if (samples.length === 0) return out

  const factor = Math.pow(2, semitones / 12)
  for (let i = 0; i < out.length; i++) {
    const src = Math.min(i * factor, samples.length - 1)
    const lo = Math.floor(src)
    const hi = Math.min(lo + 1, samples.length - 1)
    const frac = src - lo
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac
  }
  return out
}
