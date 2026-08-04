import { encodeWav } from './wav.ts'

export type AudioFormat = 'wav' | 'mp3' | 'opus' | 'flac' | 'm4b'

export type LoudnessPresetId = 'off' | 'audiobook-mono' | 'podcast-stereo'

export type LoudnessPreset = {
  id: LoudnessPresetId
  label: string
  targetLufs: number | null
  description: string
}

export const LOUDNESS_PRESETS: readonly LoudnessPreset[] = [
  { id: 'off', label: 'Off', targetLufs: null, description: 'Keep the generated level unchanged.' },
  { id: 'audiobook-mono', label: 'Audiobook / mono · -19 LUFS', targetLufs: -19, description: 'A speech-forward mono listening target.' },
  { id: 'podcast-stereo', label: 'Podcast / stereo · -16 LUFS', targetLufs: -16, description: 'A general stereo podcast listening target.' },
]

export const TRUE_PEAK_CEILING_DBTP = -1.5

export type LoudnessMeasurement = {
  integratedLufs: number | null
  truePeakDbtp: number | null
  targetLufs: number | null
  gainDb: number
  limited: boolean
}

export type BgmDuckOptions = {
  enabled?: boolean
  depth?: number
  attackMs?: number
  releaseMs?: number
}

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
  if (format === 'flac' || format === 'm4b') return Promise.reject(new Error(`${format.toUpperCase()} export requires the Windows desktop FFmpeg path.`))
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
  if (format === 'flac') return '.flac'
  if (format === 'm4b') return '.m4b'
  return '.wav'
}

export function formatMime(format: AudioFormat): string {
  if (format === 'mp3') return 'audio/mpeg'
  if (format === 'opus') return 'audio/webm'
  if (format === 'flac') return 'audio/flac'
  if (format === 'm4b') return 'audio/mp4'
  return 'audio/wav'
}

export function formatFromFilename(filename: string): AudioFormat {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.mp3')) return 'mp3'
  if (lower.endsWith('.webm') || lower.endsWith('.opus')) return 'opus'
  if (lower.endsWith('.flac')) return 'flac'
  if (lower.endsWith('.m4b')) return 'm4b'
  return 'wav'
}

export function loudnessTargetForPreset(preset: LoudnessPresetId): number | undefined {
  return LOUDNESS_PRESETS.find((entry) => entry.id === preset)?.targetLufs ?? undefined
}

/**
 * Fast client-side integrated-loudness estimate. It uses the BS.1770 window
 * and gating shape with a fixed calibration, without shipping a large filter
 * implementation. The native FFmpeg path remains the exact EBU R128 meter.
 */
export function measureIntegratedLufs(samples: Float32Array, sampleRate: number, channels = 1): number | null {
  const channelCount = normalizeChannelCount(channels)
  const frameCount = Math.floor(samples.length / channelCount)
  if (frameCount === 0) return null

  const safeRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24000
  const windowFrames = Math.max(1, Math.round(safeRate * 0.4))
  const hopFrames = Math.max(1, Math.round(safeRate * 0.1))
  const energies: number[] = []

  if (frameCount <= windowFrames) {
    energies.push(frameEnergy(samples, 0, frameCount, channelCount))
  } else {
    for (let start = 0; start + windowFrames <= frameCount; start += hopFrames) {
      energies.push(frameEnergy(samples, start, start + windowFrames, channelCount))
    }
  }

  const absoluteGateEnergy = Math.pow(10, (-70 + 0.691) / 10)
  const absoluteGated = energies.filter((energy) => energy > absoluteGateEnergy)
  if (absoluteGated.length === 0) return null

  const absoluteMean = mean(absoluteGated)
  const relativeGateLufs = -0.691 + 10 * Math.log10(absoluteMean) - 10
  const relativeGateEnergy = Math.pow(10, (relativeGateLufs + 0.691) / 10)
  const gated = absoluteGated.filter((energy) => energy > relativeGateEnergy)
  if (gated.length === 0) return null

  const integratedEnergy = mean(gated)
  return -0.691 + 10 * Math.log10(integratedEnergy)
}

/**
 * Estimate dBTP with cubic interpolation at 4x oversampling. This is a
 * conservative browser-side guard for inter-sample peaks; FFmpeg applies its
 * true-peak limiter on the native path.
 */
export function measureTruePeakDbtp(samples: Float32Array, channels = 1): number | null {
  const channelCount = normalizeChannelCount(channels)
  const frameCount = Math.floor(samples.length / channelCount)
  if (frameCount === 0) return null

  let peak = 0
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      peak = Math.max(peak, Math.abs(readSample(samples, frame, channel, channelCount)))
      if (frame >= frameCount - 1) continue

      const y0 = readSample(samples, Math.max(0, frame - 1), channel, channelCount)
      const y1 = readSample(samples, frame, channel, channelCount)
      const y2 = readSample(samples, frame + 1, channel, channelCount)
      const y3 = readSample(samples, Math.min(frameCount - 1, frame + 2), channel, channelCount)
      for (const fraction of [0.25, 0.5, 0.75]) {
        peak = Math.max(peak, Math.abs(cubicInterpolate(y0, y1, y2, y3, fraction)))
      }
    }
  }
  return peak > 1e-12 ? 20 * Math.log10(peak) : null
}

export function normalizeLoudness(
  samples: Float32Array,
  sampleRate: number,
  targetLufs: number,
  options: { channels?: number; truePeakDbtp?: number } = {},
): { samples: Float32Array; measurement: LoudnessMeasurement } {
  const channels = normalizeChannelCount(options.channels ?? 1)
  const ceiling = Number.isFinite(options.truePeakDbtp) ? Number(options.truePeakDbtp) : TRUE_PEAK_CEILING_DBTP
  const currentLufs = measureIntegratedLufs(samples, sampleRate, channels)
  if (currentLufs === null || !Number.isFinite(targetLufs)) {
    const copy = sanitizeSamples(samples)
    return {
      samples: copy,
      measurement: {
        integratedLufs: measureIntegratedLufs(copy, sampleRate, channels),
        truePeakDbtp: measureTruePeakDbtp(copy, channels),
        targetLufs: Number.isFinite(targetLufs) ? targetLufs : null,
        gainDb: 0,
        limited: false,
      },
    }
  }

  const gainDb = Math.max(-60, Math.min(60, targetLufs - currentLufs))
  const gain = Math.pow(10, gainDb / 20)
  const scaled = sanitizeSamples(samples, gain)
  const requestedPeak = Math.pow(10, ceiling / 20)
  const measuredPeak = measureTruePeakDbtp(scaled, channels)
  const limiterScale = measuredPeak !== null && measuredPeak > ceiling ? requestedPeak / Math.pow(10, measuredPeak / 20) : 1
  const limited = limiterScale < 1
  const output = sanitizeSamples(scaled, limiterScale)

  return {
    samples: output,
    measurement: {
      integratedLufs: measureIntegratedLufs(output, sampleRate, channels),
      truePeakDbtp: measureTruePeakDbtp(output, channels),
      targetLufs,
      gainDb,
      limited,
    },
  }
}

export function mixBgmSamples(
  speech: Float32Array,
  bgm: Float32Array,
  bgmGain: number,
  sampleRate: number,
  options: BgmDuckOptions = {},
): Float32Array {
  const mixed = new Float32Array(speech.length)
  if (speech.length === 0 || bgm.length === 0) {
    mixed.set(speech)
    return mixed
  }

  const gain = Number.isFinite(bgmGain) ? Math.max(0, bgmGain) : 0
  const duckEnabled = options.enabled === true
  const depth = Math.max(0, Math.min(1, Number.isFinite(options.depth) ? Number(options.depth) : 0.65))
  const safeRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24000
  const attackMs = Math.max(1, Number.isFinite(options.attackMs) ? Number(options.attackMs) : 20)
  const releaseMs = Math.max(1, Number.isFinite(options.releaseMs) ? Number(options.releaseMs) : 180)
  const attackCoefficient = Math.exp(-1 / (safeRate * attackMs / 1000))
  const releaseCoefficient = Math.exp(-1 / (safeRate * releaseMs / 1000))
  let envelope = 0

  for (let i = 0; i < speech.length; i += 1) {
    const speechSample = finiteSample(speech[i])
    if (duckEnabled) {
      const level = Math.abs(speechSample)
      const coefficient = level > envelope ? attackCoefficient : releaseCoefficient
      envelope = coefficient * envelope + (1 - coefficient) * level
    }
    const presence = duckEnabled ? Math.max(0, Math.min(1, (envelope - 0.01) / 0.14)) : 0
    const duckDb = depth * 18 * presence
    const duckGain = Math.pow(10, -duckDb / 20)
    const bgmSample = finiteSample(bgm[i % bgm.length])
    mixed[i] = Math.max(-1, Math.min(1, speechSample + bgmSample * gain * duckGain))
  }
  return mixed
}

export type BgmMixResult = {
  mixed: Float32Array
  bgmEmpty: boolean
}

export async function mixBgm(
  speech: Float32Array,
  bgmFile: File,
  bgmGain: number,
  sampleRate: number,
  options: BgmDuckOptions = {},
): Promise<BgmMixResult> {
  const arrayBuf = await bgmFile.arrayBuffer()
  const audioCtx = new OfflineAudioContext(1, speech.length, sampleRate)
  const bgmBuffer = await audioCtx.decodeAudioData(arrayBuf)

  const bgmLen = bgmBuffer.length
  if (bgmLen === 0) {
    return { mixed: speech, bgmEmpty: true }
  }

  const ch0 = bgmBuffer.getChannelData(0)
  const ch1 = bgmBuffer.numberOfChannels > 1 ? bgmBuffer.getChannelData(1) : null

  const bgm = new Float32Array(bgmLen)
  for (let i = 0; i < bgmLen; i += 1) bgm[i] = ch1 ? (ch0[i] + ch1[i]) / 2 : ch0[i]
  const mixed = mixBgmSamples(speech, bgm, bgmGain, sampleRate, options)
  return { mixed, bgmEmpty: false }
}

function normalizeChannelCount(channels: number): number {
  return Number.isSafeInteger(channels) && channels > 0 ? channels : 1
}

function frameEnergy(samples: Float32Array, start: number, end: number, channels: number): number {
  let total = 0
  let frames = 0
  for (let frame = start; frame < end; frame += 1) {
    let channelTotal = 0
    for (let channel = 0; channel < channels; channel += 1) {
      const value = readSample(samples, frame, channel, channels)
      channelTotal += value * value
    }
    total += channelTotal / channels
    frames += 1
  }
  return frames > 0 ? total / frames : 0
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

function readSample(samples: Float32Array, frame: number, channel: number, channels: number): number {
  return finiteSample(samples[frame * channels + channel])
}

function finiteSample(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function sanitizeSamples(samples: Float32Array, scale = 1): Float32Array {
  const output = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    output[i] = Math.max(-1, Math.min(1, finiteSample(samples[i]) * scale))
  }
  return output
}

function cubicInterpolate(y0: number, y1: number, y2: number, y3: number, fraction: number): number {
  const a0 = y3 - y2 - y0 + y1
  const a1 = y0 - y1 - a0
  const a2 = y2 - y0
  return a0 * fraction * fraction * fraction + a1 * fraction * fraction + a2 * fraction + y1
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
