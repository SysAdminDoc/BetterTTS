import { describe, expect, it } from 'vitest'
import { aacAudioSpecificConfig, buildM4bContainer, checkM4bCapability, normalizeM4bChapters } from './m4b.ts'

type ParsedBox = {
  type: string
  start: number
  size: number
  payloadStart: number
  end: number
  children: ParsedBox[]
}

const CONTAINER_BOXES = new Set(['moov', 'trak', 'tref', 'mdia', 'minf', 'stbl', 'udta', 'ilst'])

function makeBlob(): Blob {
  return new Blob(['audio'], { type: 'audio/wav' })
}

function parseBoxes(bytes: Uint8Array, start = 0, end = bytes.length): ParsedBox[] {
  const boxes: ParsedBox[] = []
  let offset = start
  while (offset + 8 <= end) {
    const size = readU32(bytes, offset)
    const type = readType(bytes, offset + 4)
    if (size < 8 || offset + size > end) break
    const payloadStart = offset + 8
    const childStart = type === 'meta' ? payloadStart + 4 : payloadStart
    const children = CONTAINER_BOXES.has(type) || type === 'meta' ? parseBoxes(bytes, childStart, offset + size) : []
    boxes.push({ type, start: offset, size, payloadStart, end: offset + size, children })
    offset += size
  }
  return boxes
}

function findBox(boxes: ParsedBox[], path: string[]): ParsedBox | null {
  let current = boxes
  let found: ParsedBox | undefined
  for (const part of path) {
    found = current.find((box) => box.type === part)
    if (!found) return null
    current = found.children
  }
  return found ?? null
}

function flatten(boxes: ParsedBox[]): ParsedBox[] {
  return boxes.flatMap((box) => [box, ...flatten(box.children)])
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0)
}

function readType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + 4))
}

function readChpl(bytes: Uint8Array, box: ParsedBox): Array<{ start100ns: bigint; title: string }> {
  let offset = box.payloadStart + 9
  const count = bytes[box.payloadStart + 8]
  const decoder = new TextDecoder()
  const chapters = []
  for (let i = 0; i < count; i += 1) {
    const start100ns = readU64(bytes, offset)
    offset += 8
    const titleLength = bytes[offset]
    offset += 1
    const title = decoder.decode(bytes.slice(offset, offset + titleLength))
    offset += titleLength
    chapters.push({ start100ns, title })
  }
  return chapters
}

describe('normalizeM4bChapters', () => {
  it('groups contiguous EPUB chunks by chapter index and keeps plain chunks separate', () => {
    const blob = makeBlob()
    const chapters = normalizeM4bChapters([
      { blob, chapterTitle: 'One', chapterIndex: 0, text: 'a' },
      { blob, chapterTitle: 'One', chapterIndex: 0, text: 'b' },
      { blob, chapterTitle: 'Two', chapterIndex: 1, text: 'c' },
      { blob, text: 'Loose text.' },
      { blob, text: 'Loose text.' },
    ])

    expect(chapters.map((chapter) => chapter.title)).toEqual(['One', 'Two', 'Chapter 4: Loose text.', 'Chapter 5: Loose text.'])
    expect(chapters.map((chapter) => chapter.chunks.length)).toEqual([2, 1, 1, 1])
  })
})

describe('aacAudioSpecificConfig', () => {
  it('writes AAC-LC config bytes for 24 kHz mono', () => {
    expect(Array.from(aacAudioSpecificConfig(24000, 1))).toEqual([0x13, 0x08])
  })

  it('maps every AAC frequency-table rate to its index (incl. the ≥88.2 kHz device rates)', () => {
    const table = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
    for (const [index, rate] of table.entries()) {
      const bytes = aacAudioSpecificConfig(rate, 1)
      expect(bytes.length).toBe(2)
      // AudioSpecificConfig: 5 bits object type (2=LC), 4 bits frequency index.
      const frequencyIndex = ((bytes[0] & 0x07) << 1) | (bytes[1] >> 7)
      expect(frequencyIndex).toBe(index)
    }
  })

  it('rejects rates outside the AAC frequency table before muxing', () => {
    expect(() => aacAudioSpecificConfig(192000, 1)).toThrow(/Unsupported AAC sample rate/)
    expect(() => aacAudioSpecificConfig(12345, 1)).toThrow(/Unsupported AAC sample rate/)
  })

  it('rejects impossible channel counts', () => {
    expect(() => aacAudioSpecificConfig(24000, 0)).toThrow(/channel count/)
    expect(() => aacAudioSpecificConfig(24000, 8)).toThrow(/channel count/)
  })
})

describe('checkM4bCapability', () => {
  it('reports the first supported AAC sample rate', async () => {
    const capability = await checkM4bCapability({
      audioData: {},
      audioContext: {},
      audioEncoder: {
        isConfigSupported: async (config: AudioEncoderConfig) => ({ supported: config.sampleRate === 44100 }),
      },
      navigator: { platform: 'Win32', userAgent: 'Chromium' },
    })

    expect(capability).toMatchObject({
      supported: true,
      codec: 'mp4a.40.2',
      sampleRate: 44100,
    })
  })

  it('explains missing WebCodecs with a Firefox-specific ZIP fallback', async () => {
    const capability = await checkM4bCapability({
      audioContext: {},
      navigator: { platform: 'Win32', userAgent: 'Firefox/140.0' },
    })

    expect(capability.supported).toBe(false)
    expect(capability.message).toContain('Firefox')
    expect(capability.message).toContain('chaptered ZIP fallback')
  })

  it('explains AAC gaps on Linux browser builds', async () => {
    const capability = await checkM4bCapability({
      audioData: {},
      audioContext: {},
      audioEncoder: {
        isConfigSupported: async () => ({ supported: false }),
      },
      navigator: { platform: 'Linux x86_64', userAgent: 'Chrome/140.0 Linux' },
    })

    expect(capability).toMatchObject({ supported: false, reason: 'aac-unsupported' })
    expect(capability.message).toContain('Linux')
    expect(capability.message).toContain('Opus/WebM')
  })
})

describe('buildM4bContainer', () => {
  it('writes an M4B with linked QuickTime chapters and Nero chpl metadata', async () => {
    const blob = buildM4bContainer({
      title: 'Test Book',
      sampleRate: 24000,
      bitrate: 128000,
      audioSpecificConfig: aacAudioSpecificConfig(24000, 1),
      frames: [
        { data: new Uint8Array([1, 2, 3]), duration: 1024 },
        { data: new Uint8Array([4, 5, 6]), duration: 1024 },
        { data: new Uint8Array([7, 8, 9]), duration: 1024 },
      ],
      chapters: [
        { title: 'Opening', startSample: 0 },
        { title: 'Middle', startSample: 1024 },
        { title: 'End', startSample: 2048 },
      ],
    })

    expect(blob.type).toBe('audio/mp4')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const boxes = parseBoxes(bytes)
    expect(findBox(boxes, ['ftyp'])).not.toBeNull()
    expect(readType(bytes, 8)).toBe('M4B ')
    expect(flatten(boxes).some((box) => box.type === 'chap')).toBe(true)

    const chpl = findBox(boxes, ['moov', 'udta', 'chpl'])
    expect(chpl).not.toBeNull()
    const parsedChapters = readChpl(bytes, chpl!)
    expect(parsedChapters.map((chapter) => chapter.title)).toEqual(['Opening', 'Middle', 'End'])
    expect(parsedChapters.map((chapter) => chapter.start100ns)).toEqual([0n, 426667n, 853333n])
  })
})
