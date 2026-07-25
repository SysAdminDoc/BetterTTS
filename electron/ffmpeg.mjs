import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_PCM_BYTES = 512 * 1024 * 1024
const FORMAT_ARGS = {
  wav: ['-c:a', 'pcm_s16le'],
  mp3: ['-c:a', 'libmp3lame'],
  opus: ['-c:a', 'libopus'],
  flac: ['-c:a', 'flac'],
  m4b: ['-c:a', 'aac', '-movflags', '+faststart'],
}
const EXTENSIONS = { wav: '.wav', mp3: '.mp3', opus: '.opus', flac: '.flac', m4b: '.m4b' }
const MIMES = { wav: 'audio/wav', mp3: 'audio/mpeg', opus: 'audio/ogg;codecs=opus', flac: 'audio/flac', m4b: 'audio/mp4' }

export function ffmpegExecutable() {
  return process.env.BETTERTTS_FFMPEG_PATH || 'ffmpeg'
}

export async function probeFfmpeg() {
  try {
    const { stdout } = await execFileAsync(ffmpegExecutable(), ['-version'], {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    const firstLine = stdout.split(/\r?\n/, 1)[0] ?? ''
    return { available: true, version: firstLine.replace(/^ffmpeg version\s+/i, '').slice(0, 100) }
  } catch {
    return {
      available: false,
      message: 'FFmpeg was not found. Install it with “winget install Gyan.FFmpeg” or set BETTERTTS_FFMPEG_PATH, then restart BetterTTS.',
    }
  }
}

export function outputArguments(format, bitrate = 128, title = '') {
  const codec = FORMAT_ARGS[format]
  if (!codec) throw new Error(`Unsupported native audio format: ${format}`)
  const args = [...codec]
  if (['mp3', 'opus', 'm4b'].includes(format)) args.push('-b:a', `${Math.max(32, Math.min(320, bitrate))}k`)
  if (title.trim()) args.push('-metadata', `title=${title.replace(/[\r\n]/g, ' ').slice(0, 160)}`)
  return args
}

export async function transcodePcm({ samples, sampleRate, format, bitrate, title, loudnessTarget }) {
  const pcm = samples instanceof Float32Array ? samples : new Float32Array(samples)
  if (pcm.byteLength === 0 || pcm.byteLength > MAX_PCM_BYTES) throw new Error('Native export PCM must be between 1 byte and 512 MB.')
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Native export sample rate is invalid.')
  const extension = EXTENSIONS[format]
  if (!extension) throw new Error(`Unsupported native audio format: ${format}`)

  const root = await mkdtemp(join(tmpdir(), 'bettertts-ffmpeg-'))
  const input = join(root, 'input.f32le')
  const output = join(root, `output${extension}`)
  try {
    await writeFile(input, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    const inputArgs = ['-hide_banner', '-nostdin', '-y', '-f', 'f32le', '-ar', String(sampleRate), '-ac', '1', '-i', input]
    const filter = loudnessTarget ? await measuredLoudnorm(inputArgs, loudnessTarget) : null
    const args = [...inputArgs]
    if (filter) args.push('-af', filter)
    args.push(...outputArguments(format, bitrate, title), output)
    await run(args, 5 * 60 * 1000)
    return { bytes: await readFile(output), extension, mime: MIMES[format] }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function buildM4bAudiobook({ chunks, title, bitrate = 128, loudnessTarget, cover }) {
  if (!Array.isArray(chunks) || chunks.length === 0 || chunks.length > 500) throw new Error('Native M4B needs between 1 and 500 audio chunks.')
  const total = chunks.reduce((sum, chunk) => sum + (chunk.bytes?.byteLength ?? 0), 0)
  if (total === 0 || total > MAX_PCM_BYTES) throw new Error('Native M4B inputs must total 512 MB or less.')
  const root = await mkdtemp(join(tmpdir(), 'bettertts-m4b-'))
  try {
    const inputs = []
    const durations = []
    for (let index = 0; index < chunks.length; index += 1) {
      const bytes = chunks[index].bytes instanceof Uint8Array ? chunks[index].bytes : new Uint8Array(chunks[index].bytes)
      const path = join(root, `chunk-${String(index).padStart(4, '0')}.audio`)
      await writeFile(path, bytes)
      inputs.push(path)
      durations.push(await probeDuration(path))
    }
    const combined = join(root, 'combined.wav')
    const concatArgs = ['-hide_banner', '-nostdin', '-y']
    for (const input of inputs) concatArgs.push('-i', input)
    concatArgs.push(
      '-filter_complex',
      `${inputs.map((_, index) => `[${index}:a]`).join('')}concat=n=${inputs.length}:v=0:a=1[out]`,
      '-map', '[out]', '-c:a', 'pcm_f32le', combined,
    )
    await run(concatArgs, 10 * 60 * 1000)

    const metadataPath = join(root, 'chapters.ffmeta')
    await writeFile(metadataPath, buildChapterMetadata(title, chunks, durations))
    const output = join(root, 'output.m4b')
    const inputArgs = ['-hide_banner', '-nostdin', '-y', '-i', combined]
    const filter = loudnessTarget ? await measuredLoudnorm(inputArgs, loudnessTarget) : null
    const args = [...inputArgs, '-f', 'ffmetadata', '-i', metadataPath]
    if (cover?.bytes) {
      const coverBytes = cover.bytes instanceof Uint8Array ? cover.bytes : new Uint8Array(cover.bytes)
      const jpeg = coverBytes[0] === 0xff && coverBytes[1] === 0xd8
      const png = coverBytes[0] === 0x89 && coverBytes[1] === 0x50 && coverBytes[2] === 0x4e && coverBytes[3] === 0x47
      if ((!jpeg && !png) || coverBytes.byteLength > 10 * 1024 * 1024) throw new Error('Cover art must be a JPEG or PNG no larger than 10 MB.')
      const coverPath = join(root, jpeg ? 'cover.jpg' : 'cover.png')
      await writeFile(coverPath, coverBytes)
      args.push('-i', coverPath)
    }
    args.push('-map', '0:a', '-map_metadata', '1', '-map_chapters', '1')
    if (cover?.bytes) args.push('-map', '2:v', '-c:v', 'copy', '-disposition:v', 'attached_pic')
    if (filter) args.push('-af', filter)
    args.push(...outputArguments('m4b', bitrate, title), output)
    await run(args, 10 * 60 * 1000)
    return { bytes: await readFile(output), extension: '.m4b', mime: MIMES.m4b, chapterCount: chunks.length }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export function buildChapterMetadata(title, chunks, durations) {
  const escape = (value) => String(value).replaceAll('\\', '\\\\').replace(/([=;#\n])/g, '\\$1')
  let start = 0
  const lines = [';FFMETADATA1', `title=${escape(title)}`]
  for (let index = 0; index < chunks.length; index += 1) {
    const end = start + Math.max(1, Math.round(durations[index] * 1000))
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=${escape(chunks[index].title || `Chapter ${index + 1}`)}`)
    start = end
  }
  return `${lines.join('\n')}\n`
}

async function probeDuration(path) {
  const executable = process.env.BETTERTTS_FFPROBE_PATH || ffmpegExecutable().replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
  try {
    const { stdout } = await execFileAsync(executable, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path,
    ], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 })
    const duration = Number(stdout.trim())
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('invalid duration')
    return duration
  } catch {
    throw new Error('FFprobe could not read an audiobook chunk. Install the complete FFmpeg package and retry.')
  }
}

async function measuredLoudnorm(inputArgs, target) {
  const integrated = Math.max(-24, Math.min(-9, Number(target)))
  const filter = `loudnorm=I=${integrated}:TP=-1.5:LRA=11:print_format=json`
  const { stderr } = await run([...inputArgs, '-af', filter, '-f', 'null', 'NUL'], 5 * 60 * 1000, true)
  const json = stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0]
  if (!json) throw new Error('FFmpeg loudness analysis did not return measurements.')
  const measured = JSON.parse(json)
  return [
    `loudnorm=I=${integrated}:TP=-1.5:LRA=11`,
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    'linear=true:print_format=summary',
  ].join(':')
}

async function run(args, timeout, allowFailure = false) {
  try {
    return await execFileAsync(ffmpegExecutable(), args, {
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (error) {
    if (allowFailure && error && typeof error === 'object' && 'stderr' in error) return error
    const message = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : String(error)
    throw new Error(`FFmpeg export failed: ${message.replaceAll(process.cwd(), '<app>').slice(-500)}`)
  }
}
