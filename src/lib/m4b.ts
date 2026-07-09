export type M4bChunkSource = {
  blob: Blob
  text?: string
  chapterTitle?: string
  chapterIndex?: number
}

export type M4bChapterSource = {
  title: string
  chunks: M4bChunkSource[]
}

export type M4bProgress = {
  phase: 'decode' | 'encode' | 'mux'
  done: number
  total: number
}

export type M4bCapability =
  | {
    supported: true
    codec: typeof AAC_CODEC
    sampleRate: number
    message: string
  }
  | {
    supported: false
    reason: 'missing-webcodecs' | 'missing-audio-context' | 'aac-unsupported' | 'check-failed'
    message: string
  }

type AudioEncoderSupportProbe = {
  isConfigSupported(config: AudioEncoderConfig): Promise<{ supported?: boolean }>
}

export type M4bCapabilityEnvironment = {
  audioEncoder?: AudioEncoderSupportProbe
  audioData?: unknown
  audioContext?: unknown
  navigator?: Pick<Navigator, 'platform' | 'userAgent'>
}

export type AacFrame = {
  data: Uint8Array
  duration: number
}

export type M4bContainerOptions = {
  title: string
  sampleRate: number
  bitrate: number
  audioSpecificConfig: Uint8Array
  frames: AacFrame[]
  chapters: Array<{
    title: string
    startSample: number
  }>
}

type DecodedChapter = {
  title: string
  samples: Float32Array
}

type DecodeResult = {
  chapters: DecodedChapter[]
  sampleRate: number
}

const AAC_CODEC = 'mp4a.40.2'
const AAC_FRAME_SAMPLES = 1024
const MOVIE_TIMESCALE = 1000
const MAX_UINT32 = 0xffffffff
const MAX_CHPL_TITLE_BYTES = 255
const AAC_SUPPORT_TIMEOUT_MS = 5000
const AUDIO_DECODE_TIMEOUT_MS = 15000
const AAC_FLUSH_TIMEOUT_MS = 20000
const AAC_CANDIDATE_SAMPLE_RATES = [48000, 44100, 32000, 24000]
const TEXT_SAMPLE_ENTRY_STUB = new Uint8Array([
  0x00, 0x00, 0x00, 0x01,
  0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x01,
  0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x0d,
  0x66, 0x74, 0x61, 0x62,
  0x00, 0x01,
  0x00, 0x01,
  0x00,
])
const ENCD_BOX = new Uint8Array([
  0x00, 0x00, 0x00, 0x0c,
  0x65, 0x6e, 0x63, 0x64,
  0x00, 0x00, 0x01, 0x00,
])

export function m4bSupported(): boolean {
  return hasM4bBaseSupport(readM4bEnvironment())
}

export async function checkM4bCapability(env = readM4bEnvironment()): Promise<M4bCapability> {
  if (!env.audioEncoder || !env.audioData) {
    return {
      supported: false,
      reason: 'missing-webcodecs',
      message: m4bFallbackMessage(env.navigator, 'This browser does not expose WebCodecs AudioEncoder/AudioData.'),
    }
  }

  if (!env.audioContext) {
    return {
      supported: false,
      reason: 'missing-audio-context',
      message: m4bFallbackMessage(env.navigator, 'This browser does not expose AudioContext for decoding queue chunks.'),
    }
  }

  try {
    const sampleRate = await findSupportedAacSampleRate(env.audioEncoder)
    if (sampleRate != null) {
      return {
        supported: true,
        codec: AAC_CODEC,
        sampleRate,
        message: `M4B AAC export available (${sampleRate} Hz AAC-LC).`,
      }
    }
    return {
      supported: false,
      reason: 'aac-unsupported',
      message: m4bFallbackMessage(env.navigator, 'This browser does not expose the AAC encoder required for M4B.'),
    }
  } catch (err) {
    return {
      supported: false,
      reason: 'check-failed',
      message: m4bFallbackMessage(
        env.navigator,
        err instanceof Error ? err.message : 'Could not verify this browser\'s AAC encoder.',
      ),
    }
  }
}

export function normalizeM4bChapters(chunks: M4bChunkSource[]): M4bChapterSource[] {
  const chapters: M4bChapterSource[] = []
  let previousKey: string | null = null

  chunks.forEach((chunk, index) => {
    const fallbackTitle = chunk.text ? `Chapter ${index + 1}: ${chunk.text}` : `Chapter ${index + 1}`
    const rawTitle = chunk.chapterTitle || fallbackTitle
    const title = cleanChapterTitle(rawTitle, index + 1)
    const key = typeof chunk.chapterIndex === 'number'
      ? `index:${chunk.chapterIndex}`
      : chunk.chapterTitle
        ? `title:${chunk.chapterTitle}`
        : `chunk:${index}`

    if (chapters.length > 0 && previousKey === key) {
      chapters[chapters.length - 1].chunks.push(chunk)
    } else {
      chapters.push({ title, chunks: [chunk] })
      previousKey = key
    }
  })

  return chapters
}

export async function buildM4bFromBlobs(opts: {
  title: string
  chunks: M4bChunkSource[]
  bitrate?: number
  onProgress?: (progress: M4bProgress) => void
}): Promise<{ blob: Blob; chapterCount: number }> {
  if (!m4bSupported()) {
    throw new Error('M4B export requires a browser with WebCodecs AAC support.')
  }

  const chapters = normalizeM4bChapters(opts.chunks)
  if (chapters.length === 0) throw new Error('No completed chunks are available for M4B export.')

  const decoded = await decodeChapterSources(chapters, opts.onProgress)
  const sampleRate = await chooseAacSampleRate(decoded.sampleRate)
  const chaptersForEncoding = sampleRate === decoded.sampleRate
    ? decoded.chapters
    : decoded.chapters.map((chapter) => ({
      title: chapter.title,
      samples: resampleLinear(chapter.samples, decoded.sampleRate, sampleRate),
    }))
  const encoded = await encodeAacChapters(chaptersForEncoding, sampleRate, opts.bitrate ?? 128000, opts.onProgress)
  opts.onProgress?.({ phase: 'mux', done: 0, total: 1 })
  const blob = buildM4bContainer({
    title: opts.title,
    sampleRate,
    bitrate: opts.bitrate ?? 128000,
    audioSpecificConfig: encoded.audioSpecificConfig,
    frames: encoded.frames,
    chapters: encoded.chapters,
  })
  opts.onProgress?.({ phase: 'mux', done: 1, total: 1 })
  return { blob, chapterCount: chapters.length }
}

async function decodeChapterSources(
  chapters: M4bChapterSource[],
  onProgress?: (progress: M4bProgress) => void,
): Promise<DecodeResult> {
  const totalChunks = chapters.reduce((sum, chapter) => sum + chapter.chunks.length, 0)
  let done = 0
  let sampleRate = 0
  const audioCtx = new AudioContext()

  try {
    const decoded: DecodedChapter[] = []
    for (const chapter of chapters) {
      const parts: Float32Array[] = []
      for (const chunk of chapter.chunks) {
        const buffer = await withTimeout(
          audioCtx.decodeAudioData(await chunk.blob.arrayBuffer()),
          AUDIO_DECODE_TIMEOUT_MS,
          'Timed out decoding a queue chunk for M4B export.',
        )
        if (sampleRate === 0) sampleRate = buffer.sampleRate
        const mono = audioBufferToMono(buffer)
        parts.push(buffer.sampleRate === sampleRate ? mono : resampleLinear(mono, buffer.sampleRate, sampleRate))
        done += 1
        onProgress?.({ phase: 'decode', done, total: totalChunks })
      }
      decoded.push({ title: chapter.title, samples: concatFloat32(parts) })
    }
    if (sampleRate === 0) throw new Error('No decodable audio chunks are available for M4B export.')
    return { chapters: decoded, sampleRate }
  } finally {
    audioCtx.close().catch(() => {})
  }
}

async function chooseAacSampleRate(preferredRate: number): Promise<number> {
  const rates = Array.from(new Set([preferredRate, ...AAC_CANDIDATE_SAMPLE_RATES]))
  const sampleRate = await findSupportedAacSampleRate(AudioEncoder, rates)
  if (sampleRate != null) return sampleRate
  throw new Error('This browser does not expose a WebCodecs AAC encoder.')
}

async function findSupportedAacSampleRate(
  audioEncoder: AudioEncoderSupportProbe,
  rates = AAC_CANDIDATE_SAMPLE_RATES,
): Promise<number | null> {
  for (const sampleRate of rates) {
    try {
      const support = await withTimeout(
        audioEncoder.isConfigSupported({
          codec: AAC_CODEC,
          sampleRate,
          numberOfChannels: 1,
          bitrate: 128000,
        }),
        AAC_SUPPORT_TIMEOUT_MS,
        'Timed out checking this browser\'s AAC encoder support.',
      )
      if (support.supported) return sampleRate
    } catch (err) {
      if (err instanceof Error && err.message.includes('Timed out')) throw err
    }
  }
  return null
}

function hasM4bBaseSupport(env: M4bCapabilityEnvironment): boolean {
  return Boolean(env.audioEncoder && env.audioData && env.audioContext)
}

function readM4bEnvironment(): M4bCapabilityEnvironment {
  return {
    audioEncoder: typeof AudioEncoder === 'undefined' ? undefined : AudioEncoder,
    audioData: typeof AudioData === 'undefined' ? undefined : AudioData,
    audioContext: typeof AudioContext === 'undefined' ? undefined : AudioContext,
    navigator: typeof navigator === 'undefined' ? undefined : navigator,
  }
}

function m4bFallbackMessage(navigatorLike: M4bCapabilityEnvironment['navigator'], reason: string): string {
  const userAgent = navigatorLike?.userAgent ?? ''
  const platform = navigatorLike?.platform ?? ''
  const lowerUserAgent = userAgent.toLowerCase()
  const lowerPlatform = platform.toLowerCase()
  const fallback = 'Use the chaptered ZIP fallback; choose Opus/WebM for smaller files when the browser supports Opus.'

  if (lowerUserAgent.includes('firefox')) {
    return `${reason} Firefox does not provide WebCodecs AAC export here. ${fallback}`
  }
  if (lowerUserAgent.includes('linux') || lowerPlatform.includes('linux')) {
    return `${reason} Some Linux browser builds omit AAC encoding. ${fallback}`
  }
  if (lowerUserAgent.includes('safari') && !lowerUserAgent.includes('chrome') && !lowerUserAgent.includes('chromium')) {
    return `${reason} Safari/WebKit support varies by version. ${fallback}`
  }
  return `${reason} ${fallback}`
}

async function encodeAacChapters(
  chapters: DecodedChapter[],
  sampleRate: number,
  bitrate: number,
  onProgress?: (progress: M4bProgress) => void,
): Promise<{
  frames: AacFrame[]
  chapters: Array<{ title: string; startSample: number }>
  audioSpecificConfig: Uint8Array
}> {
  const frames: AacFrame[] = []
  let audioSpecificConfig: Uint8Array | null = null
  let rejectEncoding: (err: Error) => void = () => {}
  const errorPromise = new Promise<never>((_, reject) => {
    rejectEncoding = reject
  })
  const totalSamples = chapters.reduce((sum, chapter) => sum + chapter.samples.length, 0)
  let emittedSamples = 0
  const normalizedBitrate = Math.max(64000, Math.min(192000, bitrate))

  const encoder = new AudioEncoder({
    output(chunk, metadata) {
      if (metadata?.decoderConfig?.description) {
        audioSpecificConfig = copyBufferSource(metadata.decoderConfig.description)
      }
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      frames.push({ data, duration: AAC_FRAME_SAMPLES })
      emittedSamples += AAC_FRAME_SAMPLES
      onProgress?.({ phase: 'encode', done: Math.min(emittedSamples, totalSamples), total: totalSamples })
    },
    error(err) {
      rejectEncoding(err instanceof Error ? err : new Error(String(err)))
    },
  })

  encoder.configure({
    codec: AAC_CODEC,
    sampleRate,
    numberOfChannels: 1,
    bitrate: normalizedBitrate,
  })

  const chapterMarks: Array<{ title: string; startSample: number }> = []
  let pending = new Float32Array(0)
  let sourceSamplesSeen = 0
  for (const chapter of chapters) {
    chapterMarks.push({ title: chapter.title, startSample: sourceSamplesSeen })
    pending = appendAndEncode(encoder, pending, chapter.samples, sampleRate, sourceSamplesSeen - pending.length)
    sourceSamplesSeen += chapter.samples.length
  }

  if (pending.length > 0 || frames.length === 0) {
    const padded = new Float32Array(AAC_FRAME_SAMPLES)
    padded.set(pending)
    encodeFrame(encoder, padded, sampleRate, sourceSamplesSeen - pending.length)
  }

  await withTimeout(
    Promise.race([encoder.flush(), errorPromise]),
    AAC_FLUSH_TIMEOUT_MS,
    'Timed out finalizing AAC frames for M4B export.',
  )
  encoder.close()
  if (frames.length === 0) throw new Error('No AAC frames were produced.')

  return {
    frames,
    chapters: chapterMarks,
    audioSpecificConfig: audioSpecificConfig ?? aacAudioSpecificConfig(sampleRate, 1),
  }
}

function appendAndEncode(
  encoder: AudioEncoder,
  pending: Float32Array,
  next: Float32Array,
  sampleRate: number,
  absoluteSampleOffset: number,
): Float32Array<ArrayBuffer> {
  const combined = new Float32Array(pending.length + next.length)
  combined.set(pending)
  combined.set(next, pending.length)

  let cursor = 0
  while (combined.length - cursor >= AAC_FRAME_SAMPLES) {
    encodeFrame(encoder, combined.subarray(cursor, cursor + AAC_FRAME_SAMPLES), sampleRate, absoluteSampleOffset + cursor)
    cursor += AAC_FRAME_SAMPLES
  }
  const remainder = new Float32Array(new ArrayBuffer((combined.length - cursor) * Float32Array.BYTES_PER_ELEMENT))
  remainder.set(combined.subarray(cursor))
  return remainder
}

function encodeFrame(encoder: AudioEncoder, samples: Float32Array, sampleRate: number, startSample: number): void {
  const frame = new Float32Array(AAC_FRAME_SAMPLES)
  frame.set(samples.subarray(0, AAC_FRAME_SAMPLES))
  const audioData = new AudioData({
    format: 'f32-planar',
    sampleRate,
    numberOfFrames: AAC_FRAME_SAMPLES,
    numberOfChannels: 1,
    timestamp: Math.round((startSample / sampleRate) * 1_000_000),
    data: frame,
  })
  encoder.encode(audioData)
  audioData.close()
}

export function buildM4bContainer(opts: M4bContainerOptions): Blob {
  if (opts.frames.length === 0) throw new Error('M4B export needs at least one AAC frame.')
  if (opts.chapters.length === 0) throw new Error('M4B export needs at least one chapter.')

  const audioSamples = opts.frames.map((frame) => frame.data)
  const audioBytes = byteLength(audioSamples)
  const totalAudioDuration = opts.frames.reduce((sum, frame) => sum + frame.duration, 0)
  const movieDuration = mediaToMovieDuration(totalAudioDuration, opts.sampleRate)
  const chapterSamples = makeChapterSamples(opts.chapters, totalAudioDuration, opts.sampleRate)
  const mdatParts = [...audioSamples, ...chapterSamples.map((sample) => sample.data)]
  const ftyp = makeFtyp()
  let moov = makeMoov(opts, movieDuration, totalAudioDuration, chapterSamples, 0, 0)
  const audioOffset = ftyp.length + moov.length + 8
  const chapterOffset = audioOffset + audioBytes
  if (chapterOffset > MAX_UINT32) throw new Error('M4B export is too large for the browser muxer.')

  moov = makeMoov(opts, movieDuration, totalAudioDuration, chapterSamples, audioOffset, chapterOffset)
  const mdat = box('mdat', ...mdatParts)
  return new Blob([ftyp as Uint8Array<ArrayBuffer>, moov as Uint8Array<ArrayBuffer>, mdat as Uint8Array<ArrayBuffer>], { type: 'audio/mp4' })
}

function makeMoov(
  opts: M4bContainerOptions,
  movieDuration: number,
  audioDuration: number,
  chapterSamples: Array<{ data: Uint8Array; duration: number; start100ns: bigint; title: string }>,
  audioOffset: number,
  chapterOffset: number,
): Uint8Array {
  return box(
    'moov',
    makeMvhd(movieDuration, 3),
    makeAudioTrack(opts, movieDuration, audioDuration, audioOffset),
    makeChapterTrack(movieDuration, chapterSamples, chapterOffset),
    makeUdta(opts.title, chapterSamples),
  )
}

function makeAudioTrack(opts: M4bContainerOptions, movieDuration: number, audioDuration: number, chunkOffset: number): Uint8Array {
  return box(
    'trak',
    makeTkhd(1, movieDuration, 0x0100),
    box('tref', box('chap', u32(2))),
    box(
      'mdia',
      makeMdhd(opts.sampleRate, audioDuration),
      makeHdlr('soun', 'SoundHandler'),
      box(
        'minf',
        fullBox('smhd', 0, 0, u16(0), u16(0)),
        makeDinf(),
        makeStbl(
          makeMp4aSampleEntry(opts.sampleRate, opts.audioSpecificConfig, opts.bitrate),
          opts.frames.map((frame) => ({ data: frame.data, duration: frame.duration })),
          chunkOffset,
        ),
      ),
    ),
  )
}

function makeChapterTrack(
  movieDuration: number,
  chapterSamples: Array<{ data: Uint8Array; duration: number; start100ns: bigint; title: string }>,
  chunkOffset: number,
): Uint8Array {
  return box(
    'trak',
    makeTkhd(2, movieDuration, 0),
    box(
      'mdia',
      makeMdhd(MOVIE_TIMESCALE, movieDuration),
      makeHdlr('text', 'TextHandler'),
      box(
        'minf',
        makeGmhd(),
        makeDinf(),
        makeStbl(makeTextSampleEntry(), chapterSamples, chunkOffset),
      ),
    ),
  )
}

function makeFtyp(): Uint8Array {
  return box('ftyp', ascii('M4B '), u32(0), ascii('M4B '), ascii('M4A '), ascii('isom'), ascii('mp42'))
}

function makeMvhd(duration: number, nextTrackId: number): Uint8Array {
  return fullBox(
    'mvhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(MOVIE_TIMESCALE),
    u32(duration),
    u32(0x00010000),
    u16(0x0100),
    u16(0),
    u32(0),
    u32(0),
    matrix(),
    zeros(24),
    u32(nextTrackId),
  )
}

function makeTkhd(trackId: number, duration: number, volume: number): Uint8Array {
  return fullBox(
    'tkhd',
    0,
    0x000007,
    u32(0),
    u32(0),
    u32(trackId),
    u32(0),
    u32(duration),
    u32(0),
    u32(0),
    u16(0),
    u16(0),
    u16(volume),
    u16(0),
    matrix(),
    u32(0),
    u32(0),
  )
}

function makeMdhd(timescale: number, duration: number): Uint8Array {
  return fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(languageCode('und')), u16(0))
}

function makeHdlr(handler: string, name: string): Uint8Array {
  return fullBox('hdlr', 0, 0, u32(0), ascii(handler), u32(0), u32(0), u32(0), utf8(`${name}\0`))
}

function makeDinf(): Uint8Array {
  return box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)))
}

function makeStbl(sampleEntry: Uint8Array, samples: Array<{ data: Uint8Array; duration: number }>, chunkOffset: number): Uint8Array {
  return box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), sampleEntry),
    makeStts(samples.map((sample) => sample.duration)),
    fullBox('stsc', 0, 0, u32(samples.length > 0 ? 1 : 0), samples.length > 0 ? concat([u32(1), u32(samples.length), u32(1)]) : new Uint8Array(0)),
    fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((sample) => u32(sample.data.length))),
    fullBox('stco', 0, 0, u32(samples.length > 0 ? 1 : 0), samples.length > 0 ? u32(chunkOffset) : new Uint8Array(0)),
  )
}

function makeStts(durations: number[]): Uint8Array {
  const entries: Array<{ count: number; duration: number }> = []
  for (const duration of durations) {
    const previous = entries[entries.length - 1]
    if (previous && previous.duration === duration) previous.count += 1
    else entries.push({ count: 1, duration })
  }
  return fullBox('stts', 0, 0, u32(entries.length), ...entries.flatMap((entry) => [u32(entry.count), u32(entry.duration)]))
}

function makeMp4aSampleEntry(sampleRate: number, audioSpecificConfig: Uint8Array, bitrate: number): Uint8Array {
  return box(
    'mp4a',
    zeros(6),
    u16(1),
    u32(0),
    u32(0),
    u16(1),
    u16(16),
    u16(0),
    u16(0),
    u32(sampleRate * 65536),
    makeEsds(audioSpecificConfig, bitrate),
  )
}

function makeEsds(audioSpecificConfig: Uint8Array, bitrate: number): Uint8Array {
  const decoderSpecific = descriptor(0x05, audioSpecificConfig)
  const decoderConfig = descriptor(
    0x04,
    u8(0x40),
    u8(0x15),
    u24(Math.ceil(bitrate / 8)),
    u32(bitrate),
    u32(bitrate),
    decoderSpecific,
  )
  const slConfig = descriptor(0x06, u8(0x02))
  return fullBox('esds', 0, 0, descriptor(0x03, u16(1), u8(0), decoderConfig, slConfig))
}

function makeTextSampleEntry(): Uint8Array {
  return box('text', zeros(6), u16(1), TEXT_SAMPLE_ENTRY_STUB)
}

function makeGmhd(): Uint8Array {
  return box(
    'gmhd',
    box('gmin', u32(0), u16(0x40), u16(0x8000), u16(0x8000), u16(0x8000), u16(0), u16(0)),
    box(
      'text',
      u16(0x01),
      u32(0x00),
      u32(0x00),
      u32(0x00),
      u32(0x01),
      u32(0x00),
      u32(0x00),
      u32(0x00),
      u32(0x00004000),
      u16(0x0000),
    ),
  )
}

function makeUdta(title: string, chapters: Array<{ start100ns: bigint; title: string }>): Uint8Array {
  return box('udta', makeMeta(title), makeChpl(chapters))
}

function makeMeta(title: string): Uint8Array {
  return fullBox(
    'meta',
    0,
    0,
    makeHdlr('mdir', 'appl'),
    box('ilst', box([0xa9, 0x6e, 0x61, 0x6d], box('data', u32(1), u32(0), utf8(title)))),
  )
}

function makeChpl(chapters: Array<{ start100ns: bigint; title: string }>): Uint8Array {
  const count = Math.min(chapters.length, 255)
  const entries: Uint8Array[] = []
  for (let i = 0; i < count; i += 1) {
    const title = truncateUtf8(chapters[i].title, MAX_CHPL_TITLE_BYTES)
    entries.push(u64(chapters[i].start100ns), u8(title.length), title)
  }
  return box('chpl', u32(0x01000000), u32(0), u8(count), ...entries)
}

function makeChapterSamples(
  chapters: Array<{ title: string; startSample: number }>,
  totalAudioDuration: number,
  sampleRate: number,
): Array<{ data: Uint8Array; duration: number; startMs: number; start100ns: bigint; title: string }> {
  return chapters.map((chapter, index) => {
    const nextStart = chapters[index + 1]?.startSample ?? totalAudioDuration
    const startMs = Math.round((chapter.startSample / sampleRate) * MOVIE_TIMESCALE)
    const endMs = Math.max(startMs + 1, Math.round((nextStart / sampleRate) * MOVIE_TIMESCALE))
    return {
      data: makeChapterTextSample(chapter.title),
      duration: endMs - startMs,
      startMs,
      start100ns: BigInt(Math.max(0, Math.round((chapter.startSample / sampleRate) * 10_000_000))),
      title: chapter.title,
    }
  })
}

function makeChapterTextSample(title: string): Uint8Array {
  const titleBytes = truncateUtf8(title, 65535)
  return concat([u16(titleBytes.length), titleBytes, ENCD_BOX])
}

export function aacAudioSpecificConfig(sampleRate: number, channels: number): Uint8Array<ArrayBuffer> {
  const frequencyIndex = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
    16000, 12000, 11025, 8000, 7350,
  ].indexOf(sampleRate)
  if (frequencyIndex < 0) throw new Error(`Unsupported AAC sample rate: ${sampleRate}`)
  if (channels < 1 || channels > 7) throw new Error(`Unsupported AAC channel count: ${channels}`)
  const bits = (2 << 11) | (frequencyIndex << 7) | (channels << 3)
  return new Uint8Array([(bits >> 8) & 0xff, bits & 0xff])
}

function audioBufferToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return new Float32Array(buffer.getChannelData(0))
  const out = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < out.length; i += 1) out[i] += data[i] / buffer.numberOfChannels
  }
  return out
}

function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples
  const ratio = toRate / fromRate
  const out = new Float32Array(Math.max(1, Math.round(samples.length * ratio)))
  for (let i = 0; i < out.length; i += 1) {
    const source = i / ratio
    const lo = Math.floor(source)
    const hi = Math.min(lo + 1, samples.length - 1)
    const frac = source - lo
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac
  }
  return out
}

function concatFloat32(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function cleanChapterTitle(title: string, index: number): string {
  const cleaned = title.replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : `Chapter ${index}`
}

function mediaToMovieDuration(duration: number, timescale: number): number {
  return Math.max(1, Math.ceil((duration / timescale) * MOVIE_TIMESCALE))
}

function descriptor(tag: number, ...payloadParts: Uint8Array[]): Uint8Array {
  const payload = concat(payloadParts)
  return concat([u8(tag), descriptorLength(payload.length), payload])
}

function descriptorLength(size: number): Uint8Array {
  if (size < 0x80) return u8(size)
  if (size < 0x4000) return u8(0x80 | (size >> 7), size & 0x7f)
  if (size < 0x200000) return u8(0x80 | (size >> 14), 0x80 | ((size >> 7) & 0x7f), size & 0x7f)
  return u8(0x80 | (size >> 21), 0x80 | ((size >> 14) & 0x7f), 0x80 | ((size >> 7) & 0x7f), size & 0x7f)
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function languageCode(language: string): number {
  const chars = language.slice(0, 3).padEnd(3, 'd')
  return ((chars.charCodeAt(0) - 0x60) << 10) | ((chars.charCodeAt(1) - 0x60) << 5) | (chars.charCodeAt(2) - 0x60)
}

function box(type: string | [number, number, number, number], ...payloadParts: Uint8Array[]): Uint8Array {
  const payload = concat(payloadParts)
  const size = 8 + payload.length
  if (size > MAX_UINT32) throw new Error(`MP4 box ${typeof type === 'string' ? type : 'raw'} is too large.`)
  return concat([u32(size), boxType(type), payload])
}

function fullBox(type: string, version: number, flags: number, ...payloadParts: Uint8Array[]): Uint8Array {
  return box(type, u8(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...payloadParts)
}

function boxType(type: string | [number, number, number, number]): Uint8Array {
  return Array.isArray(type) ? new Uint8Array(type) : ascii(type)
}

function ascii(value: string): Uint8Array {
  const out = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 0xff
  return out
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function truncateUtf8(value: string, maxBytes: number): Uint8Array {
  const encoder = new TextEncoder()
  let out = encoder.encode(value)
  if (out.length <= maxBytes) return out
  let end = value.length
  do {
    end -= 1
    out = encoder.encode(value.slice(0, end))
  } while (out.length > maxBytes && end > 0)
  return out
}

function matrix(): Uint8Array {
  return concat([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
  ])
}

function zeros(length: number): Uint8Array {
  return new Uint8Array(length)
}

function u8(...values: number[]): Uint8Array {
  return new Uint8Array(values.map((value) => value & 0xff))
}

function u16(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff])
}

function u24(value: number): Uint8Array {
  return new Uint8Array([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff])
}

function u32(value: number): Uint8Array {
  if (!Number.isFinite(value) || value < 0 || value > MAX_UINT32) throw new Error(`Value does not fit uint32: ${value}`)
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = byteLength(parts)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function byteLength(parts: Uint8Array[]): number {
  return parts.reduce((sum, part) => sum + part.length, 0)
}

function copyBufferSource(source: AllowSharedBufferSource): Uint8Array<ArrayBuffer> {
  const bytes = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source)
  const copy = new Uint8Array(new ArrayBuffer(bytes.length))
  copy.set(bytes)
  return copy
}
