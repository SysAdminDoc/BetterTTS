import { basename, dirname, extname, join, resolve } from 'node:path'
import { splitIntoSentences } from '../src/lib/text.ts'

export const CLI_MAX_INPUT_CHARS = 10_000_000
export const CLI_MAX_CHUNKS = 10_000
export const CLI_MAX_M4B_CHUNKS = 500

export type CliFormat = 'wav' | 'mp3' | 'opus' | 'flac' | 'm4b'
export type CliProgressMode = 'text' | 'json'

export type CliChapter = {
  title: string
  text: string
}

export type CliChunk = {
  title: string
  chapterIndex: number
  text: string
}

export type CliCueSource = {
  text: string
  duration: number
  title: string
  chapterIndex: number
}

export type CliOptions = {
  inputPath: string
  outputPath: string
  format: CliFormat
  voice: string
  engine: 'kokoro' | 'piper'
  speed: number
  bitrate: number
  title: string
  srtPath: string | null
  vttPath: string | null
  force: boolean
  json: boolean
  dryRun: boolean
}

export type CliParseResult =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'synth'; options: CliOptions }

export class CliUsageError extends Error {
  readonly exitCode = 2

  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

const FORMAT_EXTENSIONS: Record<CliFormat, string> = {
  wav: '.wav',
  mp3: '.mp3',
  opus: '.opus',
  flac: '.flac',
  m4b: '.m4b',
}

const FORMAT_VALUES = new Set<CliFormat>(Object.keys(FORMAT_EXTENSIONS) as CliFormat[])

export const CLI_USAGE = `Usage:
  bettertts synth --in <book.txt|book.epub> [options]

Options:
  --out <path>          Audio destination (defaults beside the input)
  --format <format>     wav, mp3, opus, flac, or m4b (default: wav)
  --m4b                 Shorthand for --format m4b
  --voice <id>          Kokoro voice id (default: af_heart)
  --engine <id>         kokoro or piper (default: kokoro)
  --speed <number>      Synthesis speed from 0.5 to 2 (default: 1)
  --bitrate <kbps>      MP3/Opus/M4B bitrate from 32 to 320 (default: 128)
  --title <title>       Audio/audiobook title
  --srt <path>          SRT captions (default: beside audio)
  --vtt <path>          WebVTT captions (default: beside audio)
  --no-captions         Skip SRT and VTT output
  --force               Replace existing output files
  --json                Emit machine-readable progress and result lines
  --dry-run             Parse and report the plan without loading a model
  -h, --help            Show this help
  -v, --version         Show the CLI version`

function usageError(message: string): never {
  throw new CliUsageError(`${message}\n\n${CLI_USAGE}`)
}

function valueFor(args: string[], index: number, key: string, inlineValue: string | undefined): string {
  if (inlineValue !== undefined) return inlineValue
  const next = args[index + 1]
  if (!next || (next.startsWith('-') && next !== '-')) usageError(`${key} needs a value.`)
  return next
}

function parseFiniteNumber(value: string, label: string, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    usageError(`${label} must be a number from ${min} to ${max}.`)
  }
  return parsed
}

function inferFormat(outputPath: string | undefined): CliFormat | undefined {
  const extension = extname(outputPath ?? '').toLowerCase()
  if (extension === '.m4a') return 'm4b'
  return [...FORMAT_VALUES].find((format) => FORMAT_EXTENSIONS[format] === extension)
}

function replaceExtension(path: string, extension: string): string {
  const currentExtension = extname(path)
  return join(dirname(path), `${basename(path, currentExtension)}${extension}`)
}

export function parseCliArgs(args: readonly string[]): CliParseResult {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') return { kind: 'help' }
  if (args[0] === '-v' || args[0] === '--version') return { kind: 'version' }
  if (args[0] !== 'synth') usageError(`Unknown command: ${args[0]}`)

  let inputPath: string | undefined
  let outputPath: string | undefined
  let explicitFormat: CliFormat | undefined
  let voice = 'af_heart'
  let engine: 'kokoro' | 'piper' = 'kokoro'
  let speed = 1
  let bitrate = 128
  let title: string | undefined
  let srtPath: string | undefined
  let vttPath: string | undefined
  let noCaptions = false
  let force = false
  let json = false
  let dryRun = false

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    const equals = argument.indexOf('=')
    const key = equals >= 0 ? argument.slice(0, equals) : argument
    const inlineValue = equals >= 0 ? argument.slice(equals + 1) : undefined
    if (key === '-h' || key === '--help') return { kind: 'help' }
    if (key === '--in' || key === '--input') {
      inputPath = valueFor([...args], index, key, inlineValue)
      if (inlineValue === undefined) index += 1
    } else if (key === '--out') {
      outputPath = valueFor([...args], index, key, inlineValue)
      if (inlineValue === undefined) index += 1
    } else if (key === '--format') {
      const value = valueFor([...args], index, key, inlineValue).toLowerCase() as CliFormat
      if (!FORMAT_VALUES.has(value)) usageError(`Unsupported format: ${value}`)
      explicitFormat = value
      if (inlineValue === undefined) index += 1
    } else if (key === '--m4b') {
      if (inlineValue !== undefined) usageError('--m4b does not take a value.')
      explicitFormat = 'm4b'
    } else if (key === '--voice') {
      voice = valueFor([...args], index, key, inlineValue).trim()
      if (!voice || voice.length > 100) usageError('--voice must be a non-empty id no longer than 100 characters.')
      if (inlineValue === undefined) index += 1
    } else if (key === '--engine') {
      const value = valueFor([...args], index, key, inlineValue).toLowerCase()
      if (value !== 'kokoro' && value !== 'piper') usageError('--engine must be kokoro or piper.')
      engine = value
      if (inlineValue === undefined) index += 1
    } else if (key === '--speed') {
      speed = parseFiniteNumber(valueFor([...args], index, key, inlineValue), '--speed', 0.5, 2)
      if (inlineValue === undefined) index += 1
    } else if (key === '--bitrate') {
      const value = parseFiniteNumber(valueFor([...args], index, key, inlineValue), '--bitrate', 32, 320)
      if (!Number.isInteger(value)) usageError('--bitrate must be a whole number of kilobits per second.')
      bitrate = value
      if (inlineValue === undefined) index += 1
    } else if (key === '--title') {
      title = valueFor([...args], index, key, inlineValue).trim()
      if (!title || title.length > 160) usageError('--title must be from 1 to 160 characters.')
      if (inlineValue === undefined) index += 1
    } else if (key === '--srt') {
      srtPath = valueFor([...args], index, key, inlineValue)
      if (inlineValue === undefined) index += 1
    } else if (key === '--vtt') {
      vttPath = valueFor([...args], index, key, inlineValue)
      if (inlineValue === undefined) index += 1
    } else if (key === '--no-captions') {
      if (inlineValue !== undefined) usageError('--no-captions does not take a value.')
      noCaptions = true
    } else if (key === '--force') {
      if (inlineValue !== undefined) usageError('--force does not take a value.')
      force = true
    } else if (key === '--json' || (key === '--progress' && inlineValue === 'json')) {
      if (key === '--json' && inlineValue !== undefined) usageError('--json does not take a value.')
      json = true
    } else if (key === '--progress') {
      const value = valueFor([...args], index, key, inlineValue)
      if (value !== 'text' && value !== 'json') usageError('--progress must be text or json.')
      json = value === 'json'
      if (inlineValue === undefined) index += 1
    } else if (key === '--dry-run') {
      if (inlineValue !== undefined) usageError('--dry-run does not take a value.')
      dryRun = true
    } else if (key === '--version' || key === '-v') {
      return { kind: 'version' }
    } else {
      usageError(`Unknown option: ${argument}`)
    }
  }

  if (!inputPath) usageError('synth requires --in <path>.')
  if (srtPath && noCaptions || vttPath && noCaptions) usageError('--srt/--vtt cannot be combined with --no-captions.')

  const format = explicitFormat ?? inferFormat(outputPath) ?? 'wav'
  const inputAbsolute = inputPath === '-' ? '-' : resolve(inputPath)
  const outputAbsolute = outputPath
    ? resolve(outputPath)
    : inputAbsolute === '-'
      ? usageError('stdin input requires --out <path>.')
      : replaceExtension(inputAbsolute, FORMAT_EXTENSIONS[format])
  const defaultTitle = inputAbsolute === '-' ? 'BetterTTS audiobook' : basename(inputAbsolute, extname(inputAbsolute)) || 'BetterTTS audiobook'
  const resolvedSrt = noCaptions ? null : resolve(srtPath ?? replaceExtension(outputAbsolute, '.srt'))
  const resolvedVtt = noCaptions ? null : resolve(vttPath ?? replaceExtension(outputAbsolute, '.vtt'))

  return {
    kind: 'synth',
    options: {
      inputPath: inputAbsolute,
      outputPath: outputAbsolute,
      format,
      voice,
      engine,
      speed,
      bitrate,
      title: title ?? defaultTitle,
      srtPath: resolvedSrt,
      vttPath: resolvedVtt,
      force,
      json,
      dryRun,
    },
  }
}

export function buildCliChunks(chapters: readonly CliChapter[]): CliChunk[] {
  let totalChars = 0
  const chunks: CliChunk[] = []
  for (const [chapterIndex, chapter] of chapters.entries()) {
    const text = chapter.text.trim()
    totalChars += text.length
    if (totalChars > CLI_MAX_INPUT_CHARS) {
      throw new CliUsageError(`Input exceeds the ${CLI_MAX_INPUT_CHARS.toLocaleString()}-character limit.`)
    }
    for (const sentence of splitIntoSentences(text)) {
      if (!sentence.trim()) continue
      if (chunks.length >= CLI_MAX_CHUNKS) throw new CliUsageError(`Input would create more than ${CLI_MAX_CHUNKS.toLocaleString()} audio chunks.`)
      chunks.push({ title: chapter.title.trim() || `Chapter ${chapterIndex + 1}`, chapterIndex, text: sentence.trim() })
    }
  }
  if (chunks.length === 0) throw new CliUsageError('Input contains no readable text.')
  return chunks
}

function captionParts(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?।॥。！？])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean)
}

export function buildCliCues(sources: readonly CliCueSource[]) {
  const cues: Array<{ index: number; startSec: number; endSec: number; text: string }> = []
  let cursor = 0
  let index = 1
  for (const source of sources) {
    const duration = Number.isFinite(source.duration) && source.duration > 0 ? source.duration : 0.001
    const parts = captionParts(source.text)
    const cueTexts = parts.length > 0 ? parts : [source.text.trim()]
    const totalWeight = cueTexts.reduce((sum, text) => sum + Math.max(1, text.length), 0)
    let offset = 0
    for (const [partIndex, text] of cueTexts.entries()) {
      offset += duration * Math.max(1, text.length) / totalWeight
      const end = partIndex === cueTexts.length - 1 ? cursor + duration : cursor + offset
      cues.push({ index, startSec: cursor + (partIndex === 0 ? 0 : offset - duration * Math.max(1, text.length) / totalWeight), endSec: end, text })
      index += 1
    }
    cursor += duration
  }
  return cues
}

export function formatExtension(format: CliFormat): string {
  return FORMAT_EXTENSIONS[format]
}
