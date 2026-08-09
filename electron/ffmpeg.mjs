import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_PCM_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_DURATION_SECONDS = 24 * 60 * 60
const DEFAULT_MAX_TEMP_BYTES = 4 * 1024 * 1024 * 1024
const DISK_RESERVE_BYTES = 64 * 1024 * 1024
const FORMAT_ARGS = {
  wav: ['-c:a', 'pcm_s16le'],
  mp3: ['-c:a', 'libmp3lame'],
  opus: ['-c:a', 'libopus'],
  flac: ['-c:a', 'flac'],
  m4b: ['-c:a', 'aac', '-movflags', '+faststart'],
}
const EXTENSIONS = { wav: '.wav', mp3: '.mp3', opus: '.opus', flac: '.flac', m4b: '.m4b' }
const MIMES = { wav: 'audio/wav', mp3: 'audio/mpeg', opus: 'audio/ogg;codecs=opus', flac: 'audio/flac', m4b: 'audio/mp4' }
const AUDIO_CLEANUP_FILTERS = {
  denoise: 'afftdn=nr=12:nf=-50:tn=1',
  studio: 'afftdn=nr=16:nf=-50:tn=1,agate=threshold=0.02:ratio=4:attack=20:release=250:range=0.2',
}

export function audioCleanupFilter(mode = 'off') {
  if (mode === 'off' || mode === undefined || mode === null) return null
  const filter = typeof mode === 'string' && Object.prototype.hasOwnProperty.call(AUDIO_CLEANUP_FILTERS, mode)
    ? AUDIO_CLEANUP_FILTERS[mode]
    : null
  if (!filter) throw new Error(`Unsupported audio cleanup mode: ${String(mode)}`)
  return filter
}

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

function configuredPositiveNumber(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function outputUpperBound(format, durationSeconds, sampleCount, bitrate) {
  if (format === 'wav') return sampleCount * 2 + 1024 * 1024
  if (format === 'flac') return sampleCount * 4 + 8 * 1024 * 1024
  return Math.ceil(durationSeconds * Math.max(32, Math.min(320, bitrate)) * 1000 / 8 * 1.25) + 16 * 1024 * 1024
}

export function buildExportResourcePlan({
  durationSeconds,
  decodedBytes,
  inputBytes,
  outputBytes,
  label = 'Native export',
}) {
  const tempBytes = inputBytes + decodedBytes + outputBytes + DISK_RESERVE_BYTES
  return { label, durationSeconds, decodedBytes, inputBytes, outputBytes, tempBytes }
}

export function formatByteEstimate(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.ceil(bytes / 1024 ** 2)} MB`
}

export function assertExportResourcePlan(plan, availableBytes = Number.POSITIVE_INFINITY) {
  const maxDuration = configuredPositiveNumber('BETTERTTS_MAX_EXPORT_DURATION_SECONDS', DEFAULT_MAX_DURATION_SECONDS)
  const maxTempBytes = configuredPositiveNumber('BETTERTTS_MAX_EXPORT_TEMP_BYTES', DEFAULT_MAX_TEMP_BYTES)
  if (!Number.isFinite(plan.durationSeconds) || plan.durationSeconds <= 0 || plan.durationSeconds > maxDuration) {
    throw new Error(`${plan.label} needs ${Math.ceil(plan.durationSeconds / 60)} minutes of decoded audio; the configured limit is ${Math.ceil(maxDuration / 60)} minutes. Destination unchanged.`)
  }
  if (!Number.isSafeInteger(Math.ceil(plan.decodedBytes)) || plan.decodedBytes <= 0 || plan.tempBytes > maxTempBytes) {
    throw new Error(`${plan.label} needs about ${formatByteEstimate(plan.tempBytes)} of temporary space; the configured limit is ${formatByteEstimate(maxTempBytes)}. Destination unchanged.`)
  }
  if (Number.isFinite(availableBytes) && availableBytes < plan.tempBytes) {
    throw new Error(`${plan.label} needs about ${formatByteEstimate(plan.tempBytes)} of temporary space, but only ${formatByteEstimate(availableBytes)} is available. Free disk space or shorten the export. Destination unchanged.`)
  }
  return plan
}

async function availableTemporaryBytes() {
  const info = await statfs(tmpdir())
  return Number(info.bavail) * Number(info.bsize)
}

async function preflightExport(plan) {
  return assertExportResourcePlan(plan, await availableTemporaryBytes())
}

async function cleanupOperationRoot(root, prefix) {
  const expectedParent = resolve(await realpath(tmpdir())).toLowerCase()
  const actualParent = resolve(await realpath(dirname(root))).toLowerCase()
  if (actualParent !== expectedParent || !basename(root).startsWith(prefix)) {
    throw new Error('Refusing to clean an unverified export temporary path.')
  }
  await rm(root, { recursive: true, force: true })
}

export async function transcodePcm({ samples, sampleRate, format, bitrate, title, loudnessTarget, cleanupMode }) {
  const pcm = samples instanceof Float32Array ? samples : new Float32Array(samples)
  if (pcm.byteLength === 0 || pcm.byteLength > MAX_PCM_BYTES) throw new Error('Native export PCM must be between 1 byte and 512 MB.')
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Native export sample rate is invalid.')
  const extension = EXTENSIONS[format]
  if (!extension) throw new Error(`Unsupported native audio format: ${format}`)
  const durationSeconds = pcm.length / sampleRate
  await preflightExport(buildExportResourcePlan({
    durationSeconds,
    decodedBytes: pcm.byteLength,
    inputBytes: pcm.byteLength,
    outputBytes: outputUpperBound(format, durationSeconds, pcm.length, bitrate),
    label: `${String(format).toUpperCase()} export`,
  }))

  const root = await mkdtemp(join(tmpdir(), 'bettertts-ffmpeg-'))
  const input = join(root, 'input.f32le')
  const output = join(root, `output${extension}`)
  try {
    await writeFile(input, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    const inputArgs = ['-hide_banner', '-nostdin', '-y', '-f', 'f32le', '-ar', String(sampleRate), '-ac', '1', '-i', input]
    const cleanupFilter = audioCleanupFilter(cleanupMode)
    const filter = loudnessTarget
      ? await measuredLoudnorm(inputArgs, loudnessTarget, cleanupFilter)
      : cleanupFilter
    const args = [...inputArgs]
    if (filter) args.push('-af', filter)
    args.push(...outputArguments(format, bitrate, title), output)
    await run(args, 5 * 60 * 1000)
    return { bytes: await readFile(output), extension, mime: MIMES[format] }
  } finally {
    await cleanupOperationRoot(root, 'bettertts-ffmpeg-')
  }
}

export async function buildM4bAudiobook({ chunks, title, language, narrator, bitrate = 128, loudnessTarget, cover, provenanceManifest }) {
  if (!Array.isArray(chunks) || chunks.length === 0 || chunks.length > 500) throw new Error('Native M4B needs between 1 and 500 audio chunks.')
  const total = chunks.reduce((sum, chunk) => sum + (chunk.bytes?.byteLength ?? 0), 0)
  if (total === 0 || total > MAX_PCM_BYTES) throw new Error('Native M4B inputs must total 512 MB or less.')
  const root = await mkdtemp(join(tmpdir(), 'bettertts-m4b-'))
  try {
    const inputs = []
    const durations = []
    const audioInfo = []
    for (let index = 0; index < chunks.length; index += 1) {
      const bytes = chunks[index].bytes instanceof Uint8Array ? chunks[index].bytes : new Uint8Array(chunks[index].bytes)
      const path = join(root, `chunk-${String(index).padStart(4, '0')}.audio`)
      await writeFile(path, bytes)
      inputs.push(path)
      const info = await probeAudio(path)
      durations.push(info.duration)
      audioInfo.push(info)
    }
    const durationSeconds = audioInfo.reduce((sum, info) => sum + info.duration, 0)
    const decodedBytes = audioInfo.reduce(
      (sum, info) => sum + Math.ceil(info.duration * info.sampleRate * info.channels * Float32Array.BYTES_PER_ELEMENT),
      0,
    )
    await preflightExport(buildExportResourcePlan({
      durationSeconds,
      decodedBytes,
      inputBytes: total + (cover?.bytes?.byteLength ?? 0),
      outputBytes: outputUpperBound('m4b', durationSeconds, Math.ceil(decodedBytes / 4), bitrate),
      label: 'M4B audiobook export',
    }))
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
    await writeFile(metadataPath, buildChapterMetadata(title, chunks, durations, provenanceManifest, language, narrator))
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
    await cleanupOperationRoot(root, 'bettertts-m4b-')
  }
}

export function buildChapterMetadata(title, chunks, durations, provenanceManifest, language, narrator) {
  const escape = (value) => String(value).replaceAll('\\', '\\\\').replace(/([=;#\n])/g, '\\$1')
  let start = 0
  const lines = [';FFMETADATA1', `title=${escape(title)}`]
  if (narrator) lines.push(`artist=${escape(narrator)}`)
  if (language) lines.push(`language=${escape(language)}`)
  if (provenanceManifest !== undefined) {
    const json = typeof provenanceManifest === 'string' ? provenanceManifest : JSON.stringify(provenanceManifest)
    if (json) lines.push(`comment=${escape(json.slice(0, 64 * 1024))}`)
  }
  for (let index = 0; index < chunks.length; index += 1) {
    const end = start + Math.max(1, Math.round(durations[index] * 1000))
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=${escape(chunks[index].title || `Chapter ${index + 1}`)}`)
    start = end
  }
  return `${lines.join('\n')}\n`
}

async function probeAudio(path) {
  const executable = process.env.BETTERTTS_FFPROBE_PATH || ffmpegExecutable().replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
  try {
    const { stdout } = await execFileAsync(executable, [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channels:format=duration',
      '-of', 'json',
      path,
    ], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 })
    const parsed = JSON.parse(stdout)
    const duration = Number(parsed.format?.duration)
    const sampleRate = Number(parsed.streams?.[0]?.sample_rate)
    const channels = Number(parsed.streams?.[0]?.channels)
    if (
      !Number.isFinite(duration) || duration <= 0
      || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000
      || !Number.isInteger(channels) || channels < 1 || channels > 32
    ) throw new Error('invalid audio metadata')
    return { duration, sampleRate, channels }
  } catch {
    throw new Error('FFprobe could not read an audiobook chunk. Install the complete FFmpeg package and retry.')
  }
}

async function measuredLoudnorm(inputArgs, target, preFilter) {
  const integrated = Math.max(-24, Math.min(-9, Number(target)))
  const filter = `loudnorm=I=${integrated}:TP=-1.5:LRA=11:print_format=json`
  const analysisFilter = [preFilter, filter].filter(Boolean).join(',')
  const { stderr } = await run([...inputArgs, '-af', analysisFilter, '-f', 'null', 'NUL'], 5 * 60 * 1000, true)
  const json = stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0]
  if (!json) throw new Error('FFmpeg loudness analysis did not return measurements.')
  const measured = JSON.parse(json)
  const measuredFilter = [
    `loudnorm=I=${integrated}:TP=-1.5:LRA=11`,
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    'linear=true:print_format=summary',
  ].join(':')
  return [preFilter, measuredFilter].filter(Boolean).join(',')
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
    throw new Error(`FFmpeg export failed: ${message.replaceAll(process.cwd(), '<app>').slice(-500)} Destination unchanged.`)
  }
}
