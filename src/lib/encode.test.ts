import { describe, expect, it } from 'vitest'
import { MAX_MP3_KBPS_24K, encodeAudio, formatExtension, formatMime, shiftPitch } from './encode.ts'

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
