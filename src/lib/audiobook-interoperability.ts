import { unzipSync } from 'fflate'
import {
  AUDIOBOOK_INTEROP_CONSUMERS,
  type AudiobookInteropConsumerId,
} from './audiobook-interoperability.fixtures.ts'

export type AudiobookExportFormat = 'epub' | 'm4b' | 'zip'

export type AudiobookInteropExpectation = {
  title: string
  language: string
  narrator?: string
  chapterTitles: readonly string[]
  requireCover?: boolean
}

export type AudiobookInteropIssue = {
  code: string
  message: string
  severity: 'error' | 'warning'
}

export type AudiobookPlayerSmoke = {
  ok: boolean
  steps: number
  firstTarget?: string
  lastTarget?: string
  reason?: string
}

export type AudiobookConsumerResult = {
  label: string
  supported: boolean
  valid: boolean
  issueCodes: readonly string[]
}

export type AudiobookInteropReport = {
  format: AudiobookExportFormat
  valid: boolean
  issues: readonly AudiobookInteropIssue[]
  chapterTitles: readonly string[]
  playerSmoke: AudiobookPlayerSmoke
  consumers: Readonly<Record<AudiobookInteropConsumerId, AudiobookConsumerResult>>
}

export type ChapteredZipChunk = {
  index: number
  filename: string
  text?: string
  synthesisText?: string
  chapterTitle?: string
  chapterIndex?: number
}

export type ChapteredZipManifest = {
  schemaVersion: 2
  app: 'BetterTTS'
  title: string
  language?: string
  format?: string
  cover?: { filename: string; mimeType: 'image/jpeg' | 'image/png' }
  chunks: readonly ChapteredZipChunk[]
}

type Mp4Box = {
  type: string
  start: number
  size: number
  payloadStart: number
  end: number
  children: Mp4Box[]
}

const MP4_CONTAINERS = new Set([
  'moov', 'trak', 'tref', 'mdia', 'minf', 'stbl', 'udta', 'meta', 'ilst',
  '©nam', '©ART', '©lan', '©cmt', 'covr',
])

export function validateAudiobookExport(
  format: AudiobookExportFormat,
  bytes: Uint8Array,
  expectation: AudiobookInteropExpectation,
): AudiobookInteropReport {
  if (format === 'epub') return validateEpubMediaOverlay(bytes, expectation)
  if (format === 'm4b') return validateM4bExport(bytes, expectation)
  return validateChapteredZip(bytes, expectation)
}

export function validateEpubMediaOverlay(
  bytes: Uint8Array,
  expectation: AudiobookInteropExpectation,
): AudiobookInteropReport {
  const issues: AudiobookInteropIssue[] = []
  const add = (code: string, message: string, severity: AudiobookInteropIssue['severity'] = 'error') => issues.push({ code, message, severity })
  let entries: Record<string, Uint8Array>
  let chapterTitles: string[] = []
  const playback: Array<{ start: number; end: number; target: string }> = []

  try {
    entries = unzipSync(bytes) as Record<string, Uint8Array>
  } catch {
    add('zip-invalid', 'The EPUB archive could not be opened as a ZIP container.')
    return createReport('epub', issues, chapterTitles, failedPlayerSmoke('EPUB ZIP could not be opened.'))
  }

  const names = Object.keys(entries)
  if (names[0] !== 'mimetype') add('mimetype-order', 'EPUB mimetype must be the first archive entry.')
  if (readEntry(entries, 'mimetype') !== 'application/epub+zip') add('mimetype-value', 'EPUB mimetype must be the exact application/epub+zip string.')
  if (!mimetypeIsStoredFirst(bytes)) add('mimetype-compression', 'EPUB mimetype must be the first uncompressed ZIP entry.')

  const container = readEntry(entries, 'META-INF/container.xml')
  const rootfile = container ? getStartTagAttribute(container, 'rootfile', 'full-path') : null
  if (!rootfile) {
    add('container-rootfile', 'EPUB container.xml does not identify a package document.')
    return createReport('epub', issues, chapterTitles, failedPlayerSmoke('EPUB package path is missing.'))
  }
  const opf = readEntry(entries, rootfile)
  if (!opf) {
    add('package-missing', `EPUB package document ${rootfile} is missing.`)
    return createReport('epub', issues, chapterTitles, failedPlayerSmoke('EPUB package document is missing.'))
  }

  if (getStartTagAttribute(opf, 'package', 'version') !== '3.0') add('package-version', 'EPUB package must declare version 3.0.')
  const title = readElementText(opf, 'dc:title')
  const language = readElementText(opf, 'dc:language')
  const narrator = readElementText(opf, 'dc:creator')
  if (title !== expectation.title) add('metadata-title', `EPUB title does not match the fixture (${title || 'missing'}).`)
  if (!language || language.toLowerCase() !== expectation.language.toLowerCase()) add('metadata-language', `EPUB language does not match the fixture (${language || 'missing'}).`)
  if (expectation.narrator && narrator !== expectation.narrator) add('metadata-narrator', `EPUB narrator does not match the fixture (${narrator || 'missing'}).`)
  if (!readElementText(opf, 'dc:identifier')) add('metadata-identifier', 'EPUB package is missing a dc:identifier.')
  if (!getStartTagAttribute(opf, 'meta', 'property') || !opf.includes('property="dcterms:modified"')) add('metadata-modified', 'EPUB package is missing dcterms:modified metadata.')
  if (!opf.includes('property="media:duration"')) add('metadata-duration', 'EPUB package is missing the total media duration metadata.')
  if (!opf.includes('property="media:active-class"')) add('metadata-active-class', 'EPUB package is missing media:active-class metadata.')

  const manifest = extractStartTags(opf, 'item').map((tag) => ({
    id: getAttribute(tag, 'id'),
    href: getAttribute(tag, 'href'),
    mediaType: getAttribute(tag, 'media-type'),
    mediaOverlay: getAttribute(tag, 'media-overlay'),
    properties: (getAttribute(tag, 'properties') ?? '').split(/\s+/u).filter(Boolean),
  }))
  const byId = new Map(manifest.flatMap((item) => item.id ? [[item.id, item] as const] : []))
  const opfBase = rootfile
  const resourcePath = (href: string | null) => href ? resolveArchivePath(opfBase, href) : null
  const spineIds = extractStartTags(opf, 'itemref').flatMap((tag) => {
    const idref = getAttribute(tag, 'idref')
    return idref ? [idref] : []
  })
  const textItems = spineIds.map((id) => byId.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item))
  if (textItems.length !== expectation.chapterTitles.length) add('chapter-count', `EPUB spine has ${textItems.length} text documents; expected ${expectation.chapterTitles.length}.`)
  chapterTitles = textItems.map((item) => {
    const path = resourcePath(item.href) ?? ''
    const xhtml = readEntry(entries, path) ?? ''
    return readElementText(xhtml, 'h1') || `Chapter ${textItems.indexOf(item) + 1}`
  })
  compareChapterTitles(chapterTitles, expectation.chapterTitles, add)

  const navItem = manifest.find((item) => item.properties.includes('nav'))
  if (!navItem) add('nav-missing', 'EPUB package is missing its navigation item.')
  const nav = navItem ? readEntry(entries, resourcePath(navItem.href) ?? '') ?? '' : ''
  const navLinks = extractStartTags(nav, 'a').map((tag) => getAttribute(tag, 'href')).filter((href): href is string => Boolean(href))
  if (navLinks.length !== expectation.chapterTitles.length) add('nav-order', 'EPUB navigation does not contain one link per chapter.')
  const navTitles = extractBlocks(nav, 'a').map((block) => stripMarkup(block.body).trim()).filter(Boolean)
  compareChapterTitles(navTitles, expectation.chapterTitles, add, 'nav-title')

  const cover = manifest.find((item) => item.properties.includes('cover-image'))
  if (expectation.requireCover && !cover) add('cover-missing', 'EPUB fixture requires a cover-image manifest property.')
  if (cover) {
    const coverPath = resourcePath(cover.href)
    const coverBytes = coverPath ? entries[coverPath] : undefined
    if (!coverPath || !coverBytes || !isImageBytes(coverBytes, cover.mediaType)) add('cover-invalid', 'EPUB cover-image does not reference a valid JPEG or PNG resource.')
    if (!opf.includes('name="cover"') || !opf.includes('content="cover-image"')) add('cover-legacy-metadata', 'EPUB cover-image should also expose the legacy cover metadata for older readers.')
  }

  let chapterPlaybackOffset = 0
  for (const [chapterIndex, item] of textItems.entries()) {
    const textPath = resourcePath(item.href)
    const xhtml = textPath ? readEntry(entries, textPath) ?? '' : ''
    const overlayId = item.mediaOverlay
    const overlay = overlayId ? byId.get(overlayId) : undefined
    if (item.mediaType !== 'application/xhtml+xml') add('text-media-type', `Spine item ${chapterIndex + 1} is not XHTML.`)
    if (!overlayId || !overlay || overlay.mediaType !== 'application/smil+xml') {
      add('overlay-link', `Chapter ${chapterIndex + 1} does not point to an application/smil+xml manifest item.`)
      continue
    }
    const smilPath = resourcePath(overlay.href)
    const smil = smilPath ? readEntry(entries, smilPath) ?? '' : ''
    if (!smilPath || !smil) {
      add('overlay-missing', `Chapter ${chapterIndex + 1} media overlay is missing.`)
      continue
    }
    if (getStartTagAttribute(smil, 'smil', 'version') !== '3.0') add('overlay-version', `Chapter ${chapterIndex + 1} SMIL must declare version 3.0.`)
    const sequence = extractBlocks(smil, 'seq')[0]
    if (!sequence) {
      add('overlay-sequence', `Chapter ${chapterIndex + 1} SMIL has no sequence.`)
      continue
    }
    const textRef = getAttribute(sequence.tag, 'epub:textref')
    if (!textRef) add('overlay-textref', `Chapter ${chapterIndex + 1} SMIL sequence is missing epub:textref.`)
    else if (resolveArchivePath(smilPath, textRef) !== textPath) add('overlay-textref-path', `Chapter ${chapterIndex + 1} SMIL epub:textref does not resolve to its XHTML document.`)

    const declaredDuration = parseClock(readRefinedDuration(opf, overlayId))
    let previousEnd = 0
    let parCount = 0
    for (const par of extractBlocks(sequence.body, 'par')) {
      const textTag = extractStartTags(par.body, 'text')[0]
      const audioTag = extractStartTags(par.body, 'audio')[0]
      const textRefValue = textTag ? getAttribute(textTag, 'src') : null
      const audioRef = audioTag ? getAttribute(audioTag, 'src') : null
      const targetPath = textRefValue ? resolveArchivePath(smilPath, textRefValue) : null
      const targetId = textRefValue?.split('#')[1]
      if (!textTag || !textRefValue || !targetId || targetPath !== textPath || !hasXmlId(xhtml, targetId)) add('cue-text-reference', `Chapter ${chapterIndex + 1} has an SMIL text reference that does not resolve to an XHTML fragment.`)
      const audioPath = audioRef ? resolveArchivePath(smilPath, audioRef) : null
      if (!audioTag || !audioPath || !entries[audioPath] || entries[audioPath].length === 0) add('cue-audio-reference', `Chapter ${chapterIndex + 1} has an SMIL audio reference without a packaged audio resource.`)
      const start = parseClock(audioTag ? getAttribute(audioTag, 'clipBegin') : null)
      const end = parseClock(audioTag ? getAttribute(audioTag, 'clipEnd') : null)
      if (start == null || end == null || end <= start || start < previousEnd - 0.01) add('cue-timing', `Chapter ${chapterIndex + 1} has non-monotonic or invalid SMIL timing.`)
      else {
        previousEnd = end
        playback.push({ start: start + chapterPlaybackOffset, end: end + chapterPlaybackOffset, target: targetId ?? '' })
        if (declaredDuration != null && end > declaredDuration + 0.1) add('cue-duration', `Chapter ${chapterIndex + 1} SMIL timing exceeds its declared overlay duration.`)
      }
      parCount += 1
    }
    if (parCount === 0) add('cue-coverage', `Chapter ${chapterIndex + 1} media overlay has no playable par elements.`)
    const refinedDuration = readRefinedDuration(opf, overlayId)
    if (!refinedDuration) add('overlay-duration', `Chapter ${chapterIndex + 1} is missing its refined media duration.`)
    chapterPlaybackOffset += declaredDuration ?? previousEnd
  }

  const playerSmoke = runPlayerSmoke(playback)
  if (!playerSmoke.ok) add('player-smoke', playerSmoke.reason ?? 'EPUB player smoke failed.')
  return createReport('epub', issues, chapterTitles, playerSmoke)
}

export function validateChapteredZip(
  bytes: Uint8Array,
  expectation: AudiobookInteropExpectation,
): AudiobookInteropReport {
  const issues: AudiobookInteropIssue[] = []
  const add = (code: string, message: string, severity: AudiobookInteropIssue['severity'] = 'error') => issues.push({ code, message, severity })
  let entries: Record<string, Uint8Array>
  let manifest: ChapteredZipManifest | null = null
  try {
    entries = unzipSync(bytes) as Record<string, Uint8Array>
    const raw = parseJson(readEntry(entries, 'chapters.json'))
    manifest = migrateChapteredZipManifest(raw)
  } catch (error) {
    add('zip-manifest', error instanceof Error ? error.message : 'Chaptered ZIP manifest is invalid.')
    return createReport('zip', issues, [], failedPlayerSmoke('Chaptered ZIP manifest could not be read.'))
  }

  if (manifest.app !== 'BetterTTS') add('zip-app', 'Chaptered ZIP manifest has an unexpected app identifier.')
  if (manifest.title !== expectation.title) add('metadata-title', `Chaptered ZIP title does not match the fixture (${manifest.title || 'missing'}).`)
  if (expectation.language && manifest.language && manifest.language.toLowerCase() !== expectation.language.toLowerCase()) add('metadata-language', `Chaptered ZIP language does not match the fixture (${manifest.language}).`)
  const chunks = [...manifest.chunks]
  if (chunks.length === 0) add('chunk-count', 'Chaptered ZIP manifest contains no audio chunks.')
  const indexes = chunks.map((chunk) => chunk.index)
  if (indexes.some((index, position) => !Number.isSafeInteger(index) || index !== position)) add('chunk-order', 'Chaptered ZIP chunk indexes must be contiguous and ordered.')
  const chapterTitles = chapterTitlesFromZip(chunks)
  compareChapterTitles(chapterTitles, expectation.chapterTitles, add)
  const playback: Array<{ start: number; end: number; target: string }> = []
  for (const chunk of chunks) {
    if (!isSafeArchivePath(chunk.filename) || !entries[chunk.filename] || entries[chunk.filename].length === 0) add('chunk-audio', `Chaptered ZIP chunk ${chunk.index + 1} does not reference a packaged audio file.`)
    playback.push({ start: chunk.index, end: chunk.index + 1, target: chunk.filename })
  }

  if (manifest.cover) {
    const coverBytes = entries[manifest.cover.filename]
    if (!isSafeArchivePath(manifest.cover.filename) || !coverBytes || !isImageBytes(coverBytes, manifest.cover.mimeType)) add('cover-invalid', 'Chaptered ZIP cover metadata does not reference a valid JPEG or PNG resource.')
  } else if (expectation.requireCover) add('cover-missing', 'Chaptered ZIP fixture requires cover metadata.')
  const provenance = readEntry(entries, 'provenance.json')
  if (provenance) {
    const parsed = parseJson(provenance)
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.manifest)) add('provenance-invalid', 'Chaptered ZIP provenance.json does not use the current schema.')
  }

  const playerSmoke = runPlayerSmoke(playback)
  if (!playerSmoke.ok) add('player-smoke', playerSmoke.reason ?? 'Chaptered ZIP player smoke failed.')
  return createReport('zip', issues, chapterTitles, playerSmoke)
}

export function validateM4bExport(
  bytes: Uint8Array,
  expectation: AudiobookInteropExpectation,
): AudiobookInteropReport {
  const issues: AudiobookInteropIssue[] = []
  const add = (code: string, message: string, severity: AudiobookInteropIssue['severity'] = 'error') => issues.push({ code, message, severity })
  let boxes: Mp4Box[]
  try {
    boxes = parseMp4Boxes(bytes)
  } catch (error) {
    add('m4b-parse', error instanceof Error ? error.message : 'M4B container could not be parsed.')
    return createReport('m4b', issues, [], failedPlayerSmoke('M4B parser failed.'))
  }
  const ftyp = boxes.find((box) => box.type === 'ftyp')
  const moov = boxes.find((box) => box.type === 'moov')
  if (!ftyp || readAscii(bytes, ftyp.payloadStart, 4) !== 'M4B ') add('m4b-brand', 'M4B must advertise the M4B file type brand.')
  if (!moov) {
    add('m4b-moov', 'M4B is missing its moov box.')
    return createReport('m4b', issues, [], failedPlayerSmoke('M4B moov box is missing.'))
  }
  const tracks = moov.children.filter((box) => box.type === 'trak')
  const trackInfo = tracks.map((track) => {
    const tkhd = child(track, 'tkhd')
    const mdia = child(track, 'mdia')
    const hdlr = mdia ? child(mdia, 'hdlr') : undefined
    const mdhd = mdia ? child(mdia, 'mdhd') : undefined
    const stbl = mdia ? child(child(mdia, 'minf'), 'stbl') : undefined
    const stsz = stbl ? child(stbl, 'stsz') : undefined
    return {
      id: tkhd ? readU32(bytes, tkhd.payloadStart + 12) : 0,
      handler: hdlr ? readAscii(bytes, hdlr.payloadStart + 8, 4) : '',
      sampleCount: stsz && stsz.payloadStart + 12 <= stsz.end ? readU32(bytes, stsz.payloadStart + 8) : 0,
      track,
      mdhd,
    }
  })
  const audio = trackInfo.find((track) => track.handler === 'soun')
  const chapter = trackInfo.find((track) => track.handler === 'text')
  if (!audio) add('m4b-track-types', 'M4B must contain an audio track.')
  if (trackInfo[0]?.handler !== 'soun' || audio?.id !== 1 || (chapter && (chapter.id !== 2 || trackInfo.indexOf(chapter) !== 1))) add('m4b-track-order', 'M4B audio must be the first track, with an optional chapter track immediately after it.')
  if (!audio || audio.sampleCount === 0) add('m4b-track-coverage', 'M4B audio track does not contain any samples.')
  if (chapter && chapter.sampleCount !== expectation.chapterTitles.length) add('m4b-track-coverage', 'M4B chapter track sample counts do not cover the expected chapter set.')
  const chapterRef = audio ? child(child(audio.track, 'tref'), 'chap') : undefined
  if (chapter && (!chapterRef || readU32(bytes, chapterRef.payloadStart) !== 2)) add('m4b-track-reference', 'M4B audio track must reference chapter track 2 through tref/chap.')

  const udta = child(moov, 'udta')
  const ilst = child(child(udta, 'meta'), 'ilst')
  const title = metadataText(bytes, ilst, '©nam')
  const narrator = metadataText(bytes, ilst, '©ART')
  const language = metadataText(bytes, ilst, '©lan')
  if (title !== expectation.title) add('metadata-title', `M4B title does not match the fixture (${title || 'missing'}).`)
  if (!language || language.toLowerCase() !== expectation.language.toLowerCase()) add('metadata-language', `M4B language metadata does not match the fixture (${language || 'missing'}).`)
  if (expectation.narrator && narrator !== expectation.narrator) add('metadata-narrator', `M4B narrator does not match the fixture (${narrator || 'missing'}).`)
  const cover = ilst ? child(ilst, 'covr') : undefined
  const coverData = cover ? child(cover, 'data') : undefined
  if (expectation.requireCover && !coverData && !trackInfo.some((track) => track.handler === 'vide')) add('cover-missing', 'M4B fixture requires attached cover metadata.')
  if (coverData && !isImageBytes(bytes.slice(coverData.payloadStart + 8, coverData.end), readU32(bytes, coverData.payloadStart) === 14 ? 'image/png' : 'image/jpeg')) add('cover-invalid', 'M4B attached cover metadata is not a valid JPEG or PNG.')

  const chpl = child(udta, 'chpl')
  const chapterTitles = chpl ? readChplTitles(bytes, chpl) : []
  if (!chapter && chapterTitles.length !== expectation.chapterTitles.length) add('m4b-track-coverage', 'M4B chapter metadata does not cover the expected chapter set.')
  compareChapterTitles(chapterTitles, expectation.chapterTitles, add)
  const playback = chapterTitles.map((title, index) => ({ start: index, end: index + 1, target: title }))
  const playerSmoke = runPlayerSmoke(playback)
  if (!playerSmoke.ok) add('player-smoke', playerSmoke.reason ?? 'M4B player smoke failed.')
  return createReport('m4b', issues, chapterTitles, playerSmoke)
}

export function migrateChapteredZipManifest(input: unknown): ChapteredZipManifest {
  if (!isRecord(input)) throw new Error('Chaptered ZIP manifest must be a JSON object.')
  const version = input.schemaVersion === undefined ? 1 : input.schemaVersion
  if (version !== 1 && version !== 2) throw new Error(`Unsupported chaptered ZIP manifest schema: ${String(version)}.`)
  if (input.app !== 'BetterTTS' || typeof input.title !== 'string' || !Array.isArray(input.chunks)) throw new Error('Chaptered ZIP manifest is missing required fields.')
  const chunks = input.chunks.map((chunk) => {
    if (!isRecord(chunk) || typeof chunk.index !== 'number' || !Number.isSafeInteger(chunk.index) || typeof chunk.filename !== 'string') throw new Error('Chaptered ZIP manifest contains an invalid chunk.')
    return {
      index: chunk.index,
      filename: chunk.filename,
      ...(typeof chunk.text === 'string' ? { text: chunk.text } : {}),
      ...(typeof chunk.synthesisText === 'string' ? { synthesisText: chunk.synthesisText } : {}),
      ...(typeof chunk.chapterTitle === 'string' ? { chapterTitle: chunk.chapterTitle } : {}),
      ...(typeof chunk.chapterIndex === 'number' && Number.isSafeInteger(chunk.chapterIndex) ? { chapterIndex: chunk.chapterIndex } : {}),
    }
  })
  let cover: ChapteredZipManifest['cover']
  if (input.cover !== undefined) {
    if (!isRecord(input.cover) || typeof input.cover.filename !== 'string' || (input.cover.mimeType !== 'image/jpeg' && input.cover.mimeType !== 'image/png')) {
      throw new Error('Chaptered ZIP manifest cover metadata is invalid.')
    }
    cover = { filename: input.cover.filename, mimeType: input.cover.mimeType }
  }
  return {
    schemaVersion: 2,
    app: 'BetterTTS',
    title: input.title,
    ...(typeof input.language === 'string' ? { language: input.language } : {}),
    ...(typeof input.format === 'string' ? { format: input.format } : {}),
    ...(cover ? { cover } : {}),
    chunks,
  }
}

function createReport(format: AudiobookExportFormat, issues: AudiobookInteropIssue[], chapterTitles: string[], playerSmoke: AudiobookPlayerSmoke): AudiobookInteropReport {
  const valid = issues.every((issue) => issue.severity !== 'error') && playerSmoke.ok
  const issueCodes = issues.map((issue) => issue.code)
  const consumers = Object.fromEntries(AUDIOBOOK_INTEROP_CONSUMERS.map((consumer) => {
    const supported = (consumer.formats as readonly string[]).includes(format)
    return [consumer.id, {
      label: consumer.label,
      supported,
      valid: !supported || valid,
      issueCodes: supported ? issueCodes : [],
    }]
  })) as unknown as Readonly<Record<AudiobookInteropConsumerId, AudiobookConsumerResult>>
  return { format, valid, issues, chapterTitles, playerSmoke, consumers }
}

function compareChapterTitles(actual: readonly string[], expected: readonly string[], add: (code: string, message: string) => void, code = 'chapter-order'): void {
  if (actual.length !== expected.length || actual.some((title, index) => title !== expected[index])) add(code, `Chapter order does not match the golden fixture (${actual.join(' | ') || 'missing'}).`)
}

function runPlayerSmoke(events: ReadonlyArray<{ start: number; end: number; target: string }>): AudiobookPlayerSmoke {
  if (events.length === 0) return failedPlayerSmoke('No playable timeline events were found.')
  let previousEnd = -Infinity
  for (const event of events) {
    if (!event.target || !Number.isFinite(event.start) || !Number.isFinite(event.end) || event.end <= event.start || event.start < previousEnd - 0.01) return failedPlayerSmoke('Playback events are not monotonic and playable.')
    previousEnd = event.end
  }
  return { ok: true, steps: events.length, firstTarget: events[0].target, lastTarget: events.at(-1)?.target }
}

function failedPlayerSmoke(reason: string): AudiobookPlayerSmoke {
  return { ok: false, steps: 0, reason }
}

function readEntry(entries: Record<string, Uint8Array>, path: string): string | null {
  const bytes = entries[path]
  return bytes ? new TextDecoder().decode(bytes) : null
}

function mimetypeIsStoredFirst(bytes: Uint8Array): boolean {
  if (bytes.length < 30 || readU32LittleEndian(bytes, 0) !== 0x04034b50) return false
  const compression = readU16LittleEndian(bytes, 8)
  const nameLength = readU16LittleEndian(bytes, 26)
  const extraLength = readU16LittleEndian(bytes, 28)
  const nameStart = 30
  const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + nameLength))
  return compression === 0 && name === 'mimetype' && nameStart + nameLength + extraLength <= bytes.length && extraLength === 0
}

function extractStartTags(xml: string, name: string): string[] {
  const tags: string[] = []
  const pattern = new RegExp(`<${escapeRegExp(name)}\\b[^>]*?>`, 'giu')
  for (const match of xml.matchAll(pattern)) tags.push(match[0])
  return tags
}

function extractBlocks(xml: string, name: string): Array<{ tag: string; body: string }> {
  const blocks: Array<{ tag: string; body: string }> = []
  const pattern = new RegExp(`(<${escapeRegExp(name)}\\b[^>]*>)([\\s\\S]*?)</${escapeRegExp(name)}>`, 'giu')
  for (const match of xml.matchAll(pattern)) blocks.push({ tag: match[1], body: match[2] })
  return blocks
}

function getStartTagAttribute(xml: string, name: string, attribute: string): string | null {
  const tag = extractStartTags(xml, name)[0]
  return tag ? getAttribute(tag, attribute) : null
}

function getAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])(.*?)\\1`, 'iu')
  const match = tag.match(pattern)
  return match ? decodeXml(match[2]) : null
}

function readElementText(xml: string, name: string): string {
  const pattern = new RegExp(`<${escapeRegExp(name)}\\b[^>]*>([\\s\\S]*?)</${escapeRegExp(name)}>`, 'iu')
  const match = xml.match(pattern)
  return match ? stripMarkup(match[1]).trim() : ''
}

function stripMarkup(value: string): string {
  return decodeXml(value.replace(/<[^>]+>/gu, ''))
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
}

function resolveArchivePath(base: string, reference: string): string {
  const raw = reference.split('#')[0].split('?')[0]
  const parts = `${base.slice(0, base.lastIndexOf('/') + 1)}${raw}`.split('/')
  const normalized: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') normalized.pop()
    else normalized.push(decodeUriPart(part))
  }
  return normalized.join('/')
}

function decodeUriPart(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

function hasXmlId(xml: string, id: string): boolean {
  const escaped = escapeRegExp(id)
  return new RegExp(`\\bid\\s*=\\s*["']${escaped}["']`, 'u').test(xml)
}

function readRefinedDuration(opf: string, overlayId: string): string | null {
  const tags = extractStartTags(opf, 'meta')
  const tag = tags.find((candidate) => getAttribute(candidate, 'property') === 'media:duration' && getAttribute(candidate, 'refines') === `#${overlayId}`)
  return findElementTextAfterTag(opf, tag)
}

function findElementTextAfterTag(xml: string, tag: string | undefined): string | null {
  if (!tag) return null
  const position = xml.indexOf(tag)
  if (position < 0) return null
  const after = xml.slice(position + tag.length)
  const close = after.indexOf('</meta>')
  return close >= 0 ? stripMarkup(after.slice(0, close)).trim() : null
}

function parseClock(value: string | null): number | null {
  if (!value) return null
  const trimmed = value.trim().replace(/s$/iu, '')
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed)
  const match = trimmed.match(/^(?:(\d+):)?(\d{1,2}):([0-5]\d(?:\.\d+)?)$/u)
  if (!match) return null
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

function chapterTitlesFromZip(chunks: readonly ChapteredZipChunk[]): string[] {
  const titles: string[] = []
  let previousKey: string | null = null
  for (const chunk of chunks) {
    const key = Number.isSafeInteger(chunk.chapterIndex) ? `index:${chunk.chapterIndex}` : `title:${chunk.chapterTitle ?? `Chapter ${chunk.index + 1}`}`
    if (key !== previousKey) titles.push(chunk.chapterTitle?.trim() || `Chapter ${chunk.index + 1}`)
    previousKey = key
  }
  return titles
}

function parseJson(value: string | null): unknown {
  if (!value) throw new Error('Required JSON entry is missing.')
  try { return JSON.parse(value) as unknown } catch { throw new Error('Required JSON entry is not valid JSON.') }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isSafeArchivePath(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !value.startsWith('/') && !value.split('/').some((part) => part === '..' || part === '.')
}

function isImageBytes(bytes: Uint8Array, mimeType: string | null): boolean {
  if (mimeType === 'image/png') return bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return false
}

function parseMp4Boxes(bytes: Uint8Array, start = 0, end = bytes.length): Mp4Box[] {
  const boxes: Mp4Box[] = []
  let offset = start
  while (offset < end) {
    if (offset + 8 > end) throw new Error('MP4 box header is truncated.')
    const size = readU32(bytes, offset)
    if (size < 8 || offset + size > end) throw new Error('MP4 box size is invalid.')
    const type = readAscii(bytes, offset + 4, 4)
    const payloadStart = offset + 8
    const childStart = type === 'meta' ? payloadStart + 4 : payloadStart
    const children = MP4_CONTAINERS.has(type) ? parseMp4Boxes(bytes, childStart, offset + size) : []
    boxes.push({ type, start: offset, size, payloadStart, end: offset + size, children })
    offset += size
  }
  return boxes
}

function child(box: Mp4Box | undefined, type: string): Mp4Box | undefined {
  return box?.children.find((candidate) => candidate.type === type)
}

function metadataText(bytes: Uint8Array, ilst: Mp4Box | undefined, type: string): string | null {
  const item = child(ilst, type)
  const data = child(item, 'data')
  if (!data || data.payloadStart + 8 > data.end) return null
  return stripNul(new TextDecoder().decode(bytes.slice(data.payloadStart + 8, data.end)))
}

function readChplTitles(bytes: Uint8Array, box: Mp4Box): string[] {
  if (box.payloadStart + 9 > box.end) return []
  const count = bytes[box.payloadStart + 8]
  const titles: string[] = []
  let offset = box.payloadStart + 9
  for (let index = 0; index < count && offset + 9 <= box.end; index += 1) {
    offset += 8
    const length = bytes[offset]
    offset += 1
    if (offset + length > box.end) break
    titles.push(new TextDecoder().decode(bytes.slice(offset, offset + length)))
    offset += length
  }
  return titles
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) return 0
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
}

function readU32LittleEndian(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) return 0
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true)
}

function readU16LittleEndian(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) return 0
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true)
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function stripNul(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 0) end -= 1
  return value.slice(0, end)
}

function escapeRegExp(value: string): string {
  const special = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])
  return [...value].map((character) => special.has(character) ? `\\${character}` : character).join('')
}
