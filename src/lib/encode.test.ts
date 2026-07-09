import { describe, expect, it } from 'vitest'
import { MAX_MP3_KBPS_24K, buildWebmOpus, encodeAudio, formatExtension, formatFromFilename, formatMime, shiftPitch } from './encode.ts'

// mixBgm is not covered here: it requires OfflineAudioContext, which has no
// Node implementation. Its zero-length and stereo guards are exercised in-app.

const SAMPLE_RATE = 24000

function sine(seconds: number, hz = 440): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * 0.5
  }
  return out
}

describe('formatExtension / formatMime', () => {
  it('maps wav', () => {
    expect(formatExtension('wav')).toBe('.wav')
    expect(formatMime('wav')).toBe('audio/wav')
  })

  it('maps mp3', () => {
    expect(formatExtension('mp3')).toBe('.mp3')
    expect(formatMime('mp3')).toBe('audio/mpeg')
  })

  it('maps opus webm', () => {
    expect(formatExtension('opus')).toBe('.webm')
    expect(formatMime('opus')).toBe('audio/webm')
  })

  it('infers generated audio formats from filenames', () => {
    expect(formatFromFilename('chapter.wav')).toBe('wav')
    expect(formatFromFilename('chapter.MP3')).toBe('mp3')
    expect(formatFromFilename('chapter.webm')).toBe('opus')
    expect(formatFromFilename('chapter')).toBe('wav')
  })
})

describe('encodeAudio wav', () => {
  it('produces a RIFF/WAVE blob of the expected size', async () => {
    const samples = sine(0.1)
    const blob = await encodeAudio(samples, SAMPLE_RATE, 'wav')
    expect(blob.type).toBe('audio/wav')
    expect(blob.size).toBe(44 + samples.length * 2)
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
    expect(String.fromCharCode(...head.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...head.slice(8, 12))).toBe('WAVE')
  })
})

describe('encodeAudio mp3', () => {
  it('produces frame-synced MPEG audio', async () => {
    const blob = await encodeAudio(sine(0.5), SAMPLE_RATE, 'mp3', 128)
    expect(blob.type).toBe('audio/mpeg')
    expect(blob.size).toBeGreaterThan(1000)
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer())
    expect(head[0]).toBe(0xff)
    expect(head[1] & 0xe0).toBe(0xe0)
  })

  it('clamps bitrates above the 24 kHz MPEG-2 ceiling', async () => {
    const samples = sine(1)
    const at320 = await encodeAudio(samples, SAMPLE_RATE, 'mp3', 320)
    const atMax = await encodeAudio(samples, SAMPLE_RATE, 'mp3', MAX_MP3_KBPS_24K)
    const at96 = await encodeAudio(samples, SAMPLE_RATE, 'mp3', 96)
    expect(at320.size).toBe(atMax.size)
    expect(at96.size).toBeLessThan(atMax.size)
  })

  it('keeps every chunk intact across encoder calls', async () => {
    // Regression guard for the buffer-aliasing class: distinct frames must not
    // collapse into repeats of the final encoder write.
    const blob = await encodeAudio(sine(0.3, 220), SAMPLE_RATE, 'mp3', 128)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const quarter = Math.floor(bytes.length / 4)
    const first = bytes.slice(0, quarter).join(',')
    const last = bytes.slice(bytes.length - quarter).join(',')
    expect(first).not.toBe(last)
  })
})

function countSubsequence(haystack: Uint8Array, needle: number[]): number {
  let count = 0
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    count++
  }
  return count
}

describe('buildWebmOpus', () => {
  const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75]

  // Frames of constant zero bytes can never alias an EBML element ID.
  function frames(count: number): Uint8Array[] {
    return Array.from({ length: count }, () => new Uint8Array(2))
  }

  it('rolls clusters so relative block timestamps never exceed signed int16', async () => {
    // 2000 frames × 20 ms = 40 s — a single cluster would overflow at 32.767 s.
    const blob = buildWebmOpus(frames(2000), 48000, 2000 * 960)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(countSubsequence(bytes, CLUSTER_ID)).toBe(Math.ceil(2000 / 250))
  })

  it('keeps a short export in a single cluster', async () => {
    const blob = buildWebmOpus(frames(100), 48000, 100 * 960)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(countSubsequence(bytes, CLUSTER_ID)).toBe(1)
  })

  it('adopts the encoder OpusHead and declares its pre-skip as CodecDelay', async () => {
    const head = new Uint8Array(19)
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64])
    head[8] = 1
    head[9] = 1
    new DataView(head.buffer).setUint16(10, 312, true) // pre-skip samples
    const blob = buildWebmOpus(frames(10), 48000, 10 * 960, head)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    // CodecDelay (0x56aa) = round(312 / 48000 * 1e9) = 6,500,000 ns = 0x632ea0.
    expect(countSubsequence(bytes, [0x56, 0xaa, 0x83, 0x63, 0x2e, 0xa0])).toBe(1)
  })

  it('declares final-frame zero padding as DiscardPadding', async () => {
    // 480 padded samples = 10,000,000 ns = 0x989680; the sint encoding
    // prepends 0x00 because the leading byte has its high bit set.
    const blob = buildWebmOpus(frames(10), 48000, 10 * 960 - 480, null, 480)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(countSubsequence(bytes, [0x75, 0xa2, 0x84, 0x00, 0x98, 0x96, 0x80])).toBe(1)
  })
})

// Codec boundaries are where this pipeline has historically shipped bugs (MP3
// bitrate ceiling, Opus timestamp rollover, ≥88.2 kHz AAC, truncated WAV) —
// exercise the full sample-rate matrix instead of one happy-path rate.
describe('codec boundary matrix', () => {
  const engineRates = [22050, 24000, 44100, 48000] as const
  const deviceRates = [88200, 96000] as const

  function sineAt(rate: number, seconds: number): Float32Array {
    const out = new Float32Array(Math.round(seconds * rate))
    for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5
    return out
  }

  it.each([...engineRates, ...deviceRates])('WAV headers round-trip %d Hz exactly', async (rate) => {
    const samples = sineAt(rate, 0.01)
    const blob = await encodeAudio(samples, rate, 'wav')
    const view = new DataView(await blob.arrayBuffer())
    expect(view.getUint32(24, true)).toBe(rate)
    expect(view.getUint32(28, true)).toBe(rate * 2)
    expect(view.getUint32(40, true)).toBe(samples.length * 2)
    expect(blob.size).toBe(44 + samples.length * 2)
  })

  it.each(engineRates)('MP3 encodes MPEG-supported rate %d Hz to frame-synced audio', async (rate) => {
    const blob = await encodeAudio(sineAt(rate, 0.2), rate, 'mp3', 128)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes[0]).toBe(0xff)
    expect(bytes[1] & 0xe0).toBe(0xe0)
  })

  it('MP3 accepts the full MPEG-1 bitrate range at 44.1 kHz', async () => {
    const blob = await encodeAudio(sineAt(44100, 0.1), 44100, 'mp3', 320)
    expect(blob.size).toBeGreaterThan(0)
  })

  it.each(deviceRates)('MP3 rejects non-MPEG rate %d Hz before encoding', async (rate) => {
    await expect(encodeAudio(sineAt(rate, 0.01), rate, 'mp3', 128)).rejects.toThrow(/MP3 cannot encode/)
  })

  it.each(['wav', 'mp3', 'opus'] as const)('rejects empty input for %s instead of writing an empty file', async (format) => {
    await expect(encodeAudio(new Float32Array(0), 24000, format)).rejects.toThrow(/No audio samples/)
  })

  it('survives a multi-rollover Opus duration (>65.5 s)', async () => {
    // Two full int16 timestamp ranges: every relative block timestamp must
    // still fit signed int16 after cluster rolls.
    const frameCount = Math.ceil((70 * 48000) / 960)
    const opusFrames = Array.from({ length: frameCount }, () => new Uint8Array([0xfc, 0xff, 0xfe]) as Uint8Array<ArrayBuffer>)
    const blob = buildWebmOpus(opusFrames, 48000, frameCount * 960, null, 0)
    expect(blob.size).toBeGreaterThan(0)
  })
})

describe('shiftPitch', () => {
  it('returns the input untouched at 0 semitones', async () => {
    const samples = sine(0.2)
    expect(await shiftPitch(samples, 0)).toBe(samples)
  })

  it('preserves length so subtitle timing stays valid', async () => {
    const samples = sine(1)
    const shifted = await shiftPitch(samples, 4)
    expect(shifted.length).toBe(samples.length)
  })

  it('keeps audible content through the end (flushed tail)', async () => {
    const samples = sine(1)
    const shifted = await shiftPitch(samples, -3)
    const tail = shifted.subarray(shifted.length - 2400)
    let peak = 0
    for (const s of tail) peak = Math.max(peak, Math.abs(s))
    expect(peak).toBeGreaterThan(0.05)
  })
})
