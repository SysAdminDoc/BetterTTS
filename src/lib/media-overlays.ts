import { encodeAudio, MP3_SUPPORTED_RATES, type AudioFormat } from './encode.ts'
import {
  buildReaderCueBindings,
  createReaderDocument,
  type ReaderCueBinding,
  type ReaderDocument,
  type ReaderSentence,
} from './reader.ts'
import type { Cue } from './subtitles.ts'

export const MAX_MEDIA_OVERLAY_CHUNKS = 1_000
export const MAX_MEDIA_OVERLAY_TEXT_CHARS = 5_000_000
export const MAX_MEDIA_OVERLAY_AUDIO_BYTES = 256 * 1024 * 1024

export type EpubMediaOverlayChunk = {
  index: number
  text: string
  title?: string
  chapterIndex?: number
  format: AudioFormat
  blob: Blob
  cues?: readonly Cue[]
  duration?: string
}

export type EpubMediaOverlayOptions = {
  title: string
  jobId: string
  chunks: readonly EpubMediaOverlayChunk[]
  language?: string
  narrator?: string
  bitrate?: number
}

export async function buildEpubMediaOverlay(options: EpubMediaOverlayOptions): Promise<{ blob: Blob; chunkCount: number }> {
  const chunks = [...options.chunks].sort((a, b) => a.index - b.index)
  validateChunks(chunks)
  const { zipSync, strToU8 } = await import('fflate')
  const entries: Record<string, Uint8Array> = {}
  const manifestRows: string[] = []
  const spineRows: string[] = []
  const navRows: string[] = []
  const overlayDurations: Array<{ smilId: string; duration: string }> = []
  let totalDuration = 0

  entries.mimetype = strToU8('application/epub+zip')
  entries['META-INF/container.xml'] = strToU8(containerXml())
  entries['OEBPS/styles.css'] = strToU8(stylesCss())
  manifestRows.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')
  manifestRows.push('<item id="style" href="styles.css" media-type="text/css"/>')

  for (const [position, chunk] of chunks.entries()) {
    const fileNumber = String(position + 1).padStart(4, '0')
    const textPath = `text/${fileNumber}.xhtml`
    const smilPath = `media/${fileNumber}.smil`
    const textId = `text-${position}`
    const audioId = `audio-${position}`
    const smilId = `smil-${position}`
    const chapterTitle = chunk.title ?? `Chapter ${position + 1}`
    const document = createReaderDocument({ kind: 'epub', title: chapterTitle, text: chunk.text })
    const cues = sanitizeCues(chunk.cues)
    const duration = Math.max(cues.at(-1)?.endSec ?? parseDuration(chunk.duration), 0.001)
    const bindings = buildReaderCueBindings(document, chunk.text, cues)
    const overlayBindings = bindings.length > 0 ? bindings : fallbackBindings(document, duration)
    const packagedAudio = await packageAudio(chunk, options.bitrate)
    const audioPath = `audio/${fileNumber}.${packagedAudio.extension}`
    totalDuration += duration
    overlayDurations.push({ smilId, duration: formatDuration(duration) })

    entries[`OEBPS/${textPath}`] = strToU8(renderTextXhtml(document, chapterTitle))
    entries[`OEBPS/${smilPath}`] = strToU8(renderSmil(textPath, audioPath, smilId, overlayBindings))
    entries[`OEBPS/${audioPath}`] = packagedAudio.bytes
    manifestRows.push(`<item id="${textId}" href="${textPath}" media-type="application/xhtml+xml" media-overlay="${smilId}"/>`)
    manifestRows.push(`<item id="${smilId}" href="${smilPath}" media-type="application/smil+xml"/>`)
    manifestRows.push(`<item id="${audioId}" href="${audioPath}" media-type="${packagedAudio.mimeType}"/>`)
    spineRows.push(`<itemref idref="${textId}"/>`)
    navRows.push(`<li><a href="${textPath}">${escapeXml(chapterTitle)}</a></li>`)
  }

  entries['OEBPS/nav.xhtml'] = strToU8(renderNav(options.title, navRows))
  entries['OEBPS/package.opf'] = strToU8(renderPackage({
    title: options.title,
    jobId: options.jobId,
    language: options.language,
    narrator: options.narrator,
    duration: formatDuration(totalDuration),
    overlayDurations,
    manifestRows,
    spineRows,
  }))

  const zipped = zipSync(entries, { level: 0 })
  return {
    blob: new Blob([zipped as Uint8Array<ArrayBuffer>], { type: 'application/epub+zip' }),
    chunkCount: chunks.length,
  }
}

function validateChunks(chunks: readonly EpubMediaOverlayChunk[]): void {
  if (chunks.length === 0) throw new Error('No completed EPUB chunks are available for media-overlay export.')
  if (chunks.length > MAX_MEDIA_OVERLAY_CHUNKS) throw new Error(`Media-overlay export is limited to ${MAX_MEDIA_OVERLAY_CHUNKS.toLocaleString()} chunks.`)
  let textChars = 0
  let audioBytes = 0
  let previousIndex = -1
  for (const chunk of chunks) {
    if (!Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index <= previousIndex) throw new Error('EPUB chunks must have unique increasing indexes.')
    previousIndex = chunk.index
    if (!chunk.text.trim() || chunk.text.length > 10_000) throw new Error(`EPUB chunk ${chunk.index + 1} has invalid text.`)
    if (!(chunk.blob instanceof Blob) || chunk.blob.size <= 0) throw new Error(`EPUB chunk ${chunk.index + 1} has no audio.`)
    if (chunk.format === 'flac') throw new Error('EPUB media-overlay export does not support FLAC audio. Choose WAV, MP3, or Opus for the queued EPUB.')
    textChars += chunk.text.length
    audioBytes += chunk.blob.size
    if (textChars > MAX_MEDIA_OVERLAY_TEXT_CHARS) throw new Error(`EPUB media-overlay text exceeds ${MAX_MEDIA_OVERLAY_TEXT_CHARS.toLocaleString()} characters.`)
    if (audioBytes > MAX_MEDIA_OVERLAY_AUDIO_BYTES) throw new Error('EPUB media-overlay audio exceeds the 256 MB export limit.')
  }
}

function renderTextXhtml(document: ReaderDocument, title: string): string {
  const paragraphs = document.chapters.flatMap((chapter) => chapter.paragraphs)
    .map((paragraph) => `<p>${paragraph.sentences.map((sentence) => renderSentence(sentence)).join(' ')}</p>`)
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="../styles.css"/></head>
  <body epub:type="bodymatter"><h1>${escapeXml(title)}</h1>${paragraphs}</body>
</html>
`
}

function renderSentence(sentence: ReaderSentence): string {
  if (sentence.words.length === 0) return `<span id="${sentence.id}" class="sentence">${escapeXml(sentence.text)}</span>`
  let cursor = 0
  const parts: string[] = []
  for (const word of sentence.words) {
    const start = Math.max(0, word.start - sentence.start)
    const end = Math.max(start, word.end - sentence.start)
    if (start > cursor) parts.push(escapeXml(sentence.text.slice(cursor, start)))
    parts.push(`<span id="${word.id}" class="word">${escapeXml(sentence.text.slice(start, end))}</span>`)
    cursor = end
  }
  if (cursor < sentence.text.length) parts.push(escapeXml(sentence.text.slice(cursor)))
  return `<span id="${sentence.id}" class="sentence">${parts.join('')}</span>`
}

function fallbackBindings(document: ReaderDocument, duration: number): ReaderCueBinding[] {
  const sentences = document.chapters.flatMap((chapter) => chapter.paragraphs.flatMap((paragraph) => paragraph.sentences))
  if (sentences.length === 0) return []
  const totalCharacters = sentences.reduce((sum, sentence) => sum + Math.max(1, sentence.text.length), 0)
  let elapsed = 0
  return sentences.map((sentence, index) => {
    const end = index === sentences.length - 1
      ? duration
      : elapsed + duration * (Math.max(1, sentence.text.length) / totalCharacters)
    const binding = {
      cueIndex: index + 1,
      sentenceId: sentence.id,
      startSec: elapsed,
      endSec: Math.max(elapsed, end),
      text: sentence.text,
    }
    elapsed = binding.endSec
    return binding
  })
}

function renderSmil(textPath: string, audioPath: string, smilId: string, bindings: ReturnType<typeof buildReaderCueBindings>): string {
  const pars = bindings.map((binding, index) => {
    const target = binding.wordId ?? binding.sentenceId
    return `    <par id="par-${index}"><text src="../${textPath}#${target}"/><audio src="../${audioPath}" clipBegin="${formatClip(binding.startSec)}" clipEnd="${formatClip(binding.endSec)}"/></par>`
  }).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<smil xmlns="http://www.w3.org/ns/SMIL" xmlns:epub="http://www.idpf.org/2007/ops" version="3.0">
  <body><seq id="${smilId}" epub:textref="../${textPath}">
${pars}
  </seq></body>
</smil>
`
}

function renderNav(title: string, rows: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>${escapeXml(title)} contents</title></head>
  <body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${rows.join('')}</ol></nav></body>
</html>
`
}

function renderPackage(input: {
  title: string
  jobId: string
  language?: string
  narrator?: string
  duration: string
  overlayDurations: ReadonlyArray<{ smilId: string; duration: string }>
  manifestRows: string[]
  spineRows: string[]
}): string {
  const identifier = `urn:uuid:${uuidFromJobId(input.jobId)}`
  const overlayMetadata = input.overlayDurations
    .map((overlay) => `    <meta property="media:duration" refines="#${escapeXml(overlay.smilId)}">${overlay.duration}</meta>`)
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:media="http://www.idpf.org/2007/03/media-overlay">
    <dc:identifier id="pub-id">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(input.title || 'BetterTTS audiobook')}</dc:title>
    <dc:language>${escapeXml(input.language || 'en')}</dc:language>
    <dc:creator>${escapeXml(input.narrator || 'BetterTTS')}</dc:creator>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z')}</meta>
    <meta property="media:duration">${input.duration}</meta>
    <meta property="media:active-class">-epub-media-overlay-active</meta>
${overlayMetadata}
  </metadata>
  <manifest>${input.manifestRows.join('')}</manifest>
  <spine>${input.spineRows.join('')}</spine>
</package>
`
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>
`
}

function stylesCss(): string {
  return `.sentence { display: inline; }
.word { display: inline; }
.-epub-media-overlay-active { background: #ffeb3b; color: #111; }
`
}

function sanitizeCues(cues: readonly Cue[] | undefined): Cue[] {
  return (cues ?? [])
    .filter((cue) => Number.isSafeInteger(cue.index) && cue.index > 0 && Number.isFinite(cue.startSec) && Number.isFinite(cue.endSec) && cue.startSec >= 0 && cue.endSec > cue.startSec && typeof cue.text === 'string' && cue.text.trim().length > 0)
    .map((cue) => ({ ...cue, startSec: Math.max(0, cue.startSec), endSec: Math.max(cue.startSec, cue.endSec), text: cue.text.slice(0, 1_000) }))
    .sort((a, b) => a.startSec - b.startSec || a.index - b.index)
}

async function packageAudio(chunk: EpubMediaOverlayChunk, bitrate = 128): Promise<{ extension: string; mimeType: string; bytes: Uint8Array }> {
  if (chunk.format !== 'wav') {
    const source = new Uint8Array(await chunk.blob.arrayBuffer())
    return { ...audioPackageForFormat(chunk.format), bytes: source }
  }

  const decoded = decodePcmWav(new Uint8Array(await chunk.blob.arrayBuffer()))
  const targetRate = (MP3_SUPPORTED_RATES as readonly number[]).includes(decoded.sampleRate) ? decoded.sampleRate : 24000
  const samples = targetRate === decoded.sampleRate ? decoded.samples : resampleMono(decoded.samples, decoded.sampleRate, targetRate)
  const encoded = await encodeAudio(samples, targetRate, 'mp3', Math.max(32, Math.min(160, Math.round(bitrate))))
  return {
    extension: 'mp3',
    mimeType: 'audio/mpeg',
    bytes: new Uint8Array(await encoded.arrayBuffer()),
  }
}

function audioPackageForFormat(format: AudioFormat): { extension: string; mimeType: string } {
  if (format === 'mp3') return { extension: 'mp3', mimeType: 'audio/mpeg' }
  if (format === 'opus') return { extension: 'webm', mimeType: 'audio/webm' }
  if (format === 'm4b') return { extension: 'm4b', mimeType: 'audio/mp4' }
  if (format === 'flac') throw new Error('EPUB media-overlay export does not support FLAC audio.')
  throw new Error('WAV audio must be transcoded before EPUB packaging.')
}

function decodePcmWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  if (bytes.length < 44) throw new Error('WAV audio is too short for EPUB MP3 conversion.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') throw new Error('EPUB overlay export requires a RIFF/WAVE audio blob.')
  let formatCode = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let blockAlign = 0
  let dataOffset = -1
  let dataLength = 0
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const size = view.getUint32(offset + 4, true)
    const contentOffset = offset + 8
    if (contentOffset + size > view.byteLength) throw new Error('WAV audio contains a truncated chunk.')
    const id = ascii(view, offset, 4)
    if (id === 'fmt ' && size >= 16) {
      formatCode = view.getUint16(contentOffset, true)
      channels = view.getUint16(contentOffset + 2, true)
      sampleRate = view.getUint32(contentOffset + 4, true)
      blockAlign = view.getUint16(contentOffset + 12, true)
      bitsPerSample = view.getUint16(contentOffset + 14, true)
    } else if (id === 'data' && dataOffset < 0) {
      dataOffset = contentOffset
      dataLength = size
    }
    offset = contentOffset + size + (size % 2)
  }
  if (formatCode !== 1 && formatCode !== 3) throw new Error('EPUB overlay WAV conversion supports PCM or IEEE-float WAV audio only.')
  if (channels < 1 || channels > 8 || sampleRate < 1 || bitsPerSample < 8 || bitsPerSample > 32 || dataOffset < 0) {
    throw new Error('EPUB overlay WAV audio has unsupported format metadata.')
  }
  const bytesPerSample = Math.ceil(bitsPerSample / 8)
  if (blockAlign < channels * bytesPerSample || dataLength < blockAlign) throw new Error('EPUB overlay WAV audio has invalid frame alignment.')
  const frameCount = Math.floor(dataLength / blockAlign)
  const samples = new Float32Array(frameCount)
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      const sampleOffset = dataOffset + frame * blockAlign + channel * bytesPerSample
      sum += readWavSample(view, sampleOffset, formatCode, bitsPerSample)
    }
    samples[frame] = Math.max(-1, Math.min(1, sum / channels))
  }
  if (samples.length === 0) throw new Error('WAV audio has no PCM samples.')
  return { samples, sampleRate }
}

function readWavSample(view: DataView, offset: number, formatCode: number, bitsPerSample: number): number {
  if (formatCode === 3) {
    if (bitsPerSample !== 32) throw new Error(`WAV audio bit depth ${bitsPerSample} is unsupported for float conversion.`)
    return view.getFloat32(offset, true)
  }
  if (bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128
  if (bitsPerSample === 16) return view.getInt16(offset, true) / 0x8000
  if (bitsPerSample === 24) {
    let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
    if (value & 0x800000) value -= 0x1000000
    return value / 0x800000
  }
  if (bitsPerSample === 32) return view.getInt32(offset, true) / 0x80000000
  throw new Error(`WAV audio bit depth ${bitsPerSample} is unsupported for EPUB conversion.`)
}

function resampleMono(samples: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  const output = new Float32Array(Math.max(1, Math.round(samples.length * targetRate / sourceRate)))
  for (let index = 0; index < output.length; index += 1) {
    const sourceIndex = index * sourceRate / targetRate
    const low = Math.floor(sourceIndex)
    const high = Math.min(low + 1, samples.length - 1)
    const fraction = sourceIndex - low
    output[index] = samples[low] * (1 - fraction) + samples[high] * fraction
  }
  return output
}

function ascii(view: DataView, offset: number, length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(view.getUint8(offset + index))
  return value
}

function formatClip(seconds: number): string {
  return `${Math.max(0, seconds).toFixed(3)}s`
}

function parseDuration(value: string | undefined): number {
  const match = value?.match(/(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/iu)
  if (!match) return 0
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2] ?? 0)
  const seconds = Number(match[3] ?? 0)
  return Number.isFinite(hours + minutes + seconds) ? hours * 3600 + minutes * 60 + seconds : 0
}

function formatDuration(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(totalMs / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const remainder = (totalMs % 60_000) / 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${remainder.toFixed(3).padStart(6, '0')}`
}

function uuidFromJobId(value: string): string {
  const hex = `${hashString(value)}${hashString(`${value}:1`)}${hashString(`${value}:2`)}${hashString(`${value}:3`)}`
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4]
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function hashString(value: string): string {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] ?? character)
}
