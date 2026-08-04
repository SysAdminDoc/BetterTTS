import { fork } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { DOMParser as LinkedomDOMParser } from 'linkedom'
import { buildM4bAudiobook, transcodePcm } from './ffmpeg.mjs'
import { buildCliChunks, buildCliCues, CLI_MAX_M4B_CHUNKS, CliUsageError, parseCliArgs, CLI_USAGE } from './cli-core.ts'
import { parseEpubFromArrayBuffer } from '../src/lib/epub.ts'
import { toSRT, toVTT } from '../src/lib/subtitles.ts'
import { concatFloat32Arrays, encodeWav } from '../src/lib/wav.ts'

globalThis.DOMParser ??= LinkedomDOMParser

let activeHost = null
let interrupted = false

process.once('SIGINT', () => {
  interrupted = true
  activeHost?.close()
  process.exitCode = 130
})

function version() {
  const candidates = [
    resolve(dirname(process.argv[1] ?? ''), '..', 'package.json'),
    resolve(process.cwd(), 'package.json'),
  ]
  for (const path of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof manifest.version === 'string') return manifest.version
    } catch {
      // Try the next package location.
    }
  }
  return 'unknown'
}

function emit(options, event) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ type: 'progress', ...event })}\n`)
  } else {
    process.stdout.write(`[bettertts] ${event.message}\n`)
  }
}

function emitResult(options, result) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ type: 'result', ok: true, ...result })}\n`)
    return
  }
  process.stdout.write(`[bettertts] wrote ${result.audioPath ?? result.outputPath}\n`)
  if (result.srtPath) process.stdout.write(`[bettertts] wrote ${result.srtPath}\n`)
  if (result.vttPath) process.stdout.write(`[bettertts] wrote ${result.vttPath}\n`)
  process.stdout.write(`[bettertts] ${result.chunkCount} chunks · ${Math.round(result.durationSeconds)} seconds\n`)
}

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

async function readStdin() {
  const chunks = []
  let total = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > 4 * 10_000_000) throw new CliUsageError('stdin input exceeds the 10,000,000-character safety limit.')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function loadChapters(inputPath) {
  if (inputPath === '-') return [{ title: 'stdin', text: (await readStdin()).replace(/^\uFEFF/u, '') }]
  const inputInfo = await stat(inputPath)
  if (!inputInfo.isFile()) throw new CliUsageError(`Input is not a regular file: ${inputPath}`)
  if (inputInfo.size > 4 * 10_000_000) throw new CliUsageError('Input file exceeds the 10,000,000-character safety limit.')
  const inputBytes = await readFile(inputPath)
  if (extname(inputPath).toLowerCase() === '.epub') {
    return parseEpubFromArrayBuffer(toArrayBuffer(inputBytes))
  }
  const title = basename(inputPath, extname(inputPath)) || 'BetterTTS audiobook'
  return [{ title, text: inputBytes.toString('utf8').replace(/^\uFEFF/u, '') }]
}

function hostCandidates() {
  const cliPath = process.argv[1] ? resolve(process.argv[1]) : ''
  return [
    process.env.BETTERTTS_TTS_HOST,
    cliPath ? resolve(dirname(cliPath), 'tts-host.mjs') : undefined,
    resolve(process.cwd(), 'dist-electron', 'tts-host.mjs'),
  ].filter(Boolean)
}

function modelCachePath() {
  if (process.env.BETTERTTS_MODEL_CACHE) return process.env.BETTERTTS_MODEL_CACHE
  const base = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  return join(base, 'BetterTTS', 'models')
}

function createNativeHost(options) {
  const hostPath = hostCandidates().find((candidate) => existsSync(candidate))
  if (!hostPath) throw new Error('Native CLI runtime is not built. Run `npm run desktop:build` before using `bettertts synth`.')

  const env = { ...process.env, BETTERTTS_MODEL_CACHE: modelCachePath() }
  delete env.ELECTRON_RUN_AS_NODE
  const child = fork(hostPath, [], {
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env,
  })
  let lastStderr = ''
  child.stderr?.on('data', (chunk) => {
    lastStderr = `${lastStderr}${chunk.toString()}`.slice(-1000)
  })

  let nextId = 1
  let closed = false
  let loaded = false
  let resolveLoad
  let rejectLoad
  const pending = new Map()
  const loadPromise = new Promise((resolve, reject) => {
    resolveLoad = resolve
    rejectLoad = reject
  })

  const fail = (error) => {
    const err = error instanceof Error ? error : new Error(String(error))
    if (!loaded) rejectLoad(err)
    for (const entry of pending.values()) entry.reject(err)
    pending.clear()
  }

  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'progress') {
      const info = message.info && typeof message.info === 'object' ? message.info : {}
      if (typeof info.file === 'string' && typeof info.progress === 'number') {
        emit(options, { stage: 'model', message: `model ${info.file} ${Math.round(info.progress)}%`, progress: info.progress })
      }
    } else if (message.type === 'loaded') {
      loaded = true
      resolveLoad(message.runtime)
    } else if (message.type === 'loadError') {
      fail(new Error(message.message || 'Native model load failed.'))
    } else if (message.type === 'generated') {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (!entry) return
      const samples = message.samples instanceof Float32Array ? message.samples : new Float32Array(message.samples)
      entry.resolve({ samples, sampleRate: message.sampleRate })
    } else if (message.type === 'generateError') {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      entry?.reject(new Error(message.message || 'Native synthesis failed.'))
    }
  })
  child.on('error', fail)
  child.on('exit', (code) => {
    if (!closed) fail(new Error(`Native inference host exited with code ${code ?? 'unknown'}${lastStderr.trim() ? `: ${lastStderr.trim()}` : ''}`))
  })

  const host = {
    load: () => loadPromise,
    generate(text, voice, speed) {
      if (closed) return Promise.reject(new Error('Native inference host is closed.'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.send({ type: 'generate', text, voice, speed, id, ...(options.engine === 'piper' ? { engine: 'piper' } : {}) })
      })
    },
    close() {
      if (closed) return
      closed = true
      const error = new Error('Native inference host closed.')
      if (!loaded) rejectLoad(error)
      for (const entry of pending.values()) entry.reject(error)
      pending.clear()
      if (child.connected) child.disconnect()
      child.kill()
    },
  }

  child.send({ type: 'load', ...(options.engine === 'piper' ? { engine: 'piper' } : {}) })
  return host
}

async function assertDestinations(options) {
  const paths = [options.outputPath, options.srtPath, options.vttPath].filter(Boolean)
  if (new Set(paths).size !== paths.length) throw new CliUsageError('Audio and caption destinations must be different files.')
  if (options.force) return
  const existing = []
  for (const path of paths) {
    try {
      await stat(path)
      existing.push(path)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  if (existing.length > 0) throw new CliUsageError(`Destination already exists: ${existing.join(', ')}. Use --force to replace it.`)
}

async function writeAtomic(path, data, force) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.bettertts-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(temp, data, { flag: 'wx' })
    if (force) await rm(path, { force: true })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function runSynth(options) {
  const chapters = await loadChapters(options.inputPath)
  const chunks = buildCliChunks(chapters)
  if (options.format === 'm4b' && chunks.length > CLI_MAX_M4B_CHUNKS) {
    throw new CliUsageError(`M4B output supports at most ${CLI_MAX_M4B_CHUNKS} audio chunks; shorten the input or use WAV/MP3/Opus/FLAC.`)
  }
  const plan = {
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    format: options.format,
    engine: options.engine,
    voice: options.voice,
    speed: options.speed,
    chapterCount: chapters.length,
    chunkCount: chunks.length,
    srtPath: options.srtPath,
    vttPath: options.vttPath,
  }
  if (options.dryRun) {
    emitResult(options, { ...plan, dryRun: true, durationSeconds: 0 })
    return
  }

  await assertDestinations(options)
  emit(options, { stage: 'input', message: `parsed ${chapters.length} chapter${chapters.length === 1 ? '' : 's'} into ${chunks.length} chunks` })
  const host = createNativeHost(options)
  activeHost = host
  const audioChunks = []
  let sampleRate = 0
  try {
    emit(options, { stage: 'model', message: `loading native ${options.engine} model` })
    await host.load()
    for (const [index, chunk] of chunks.entries()) {
      if (interrupted) throw new Error('Synthesis cancelled.')
      emit(options, { stage: 'synthesis', message: `synthesizing chunk ${index + 1}/${chunks.length}`, chunk: index + 1, total: chunks.length })
      const generated = await host.generate(chunk.text, options.engine === 'piper' ? 'en' : options.voice, options.speed)
      const currentRate = Number(generated.sampleRate) || (options.engine === 'piper' ? 22_050 : 24_000)
      if (sampleRate && currentRate !== sampleRate) throw new Error('Native engine changed sample rates during synthesis.')
      sampleRate = currentRate
      audioChunks.push({ ...chunk, samples: generated.samples, sampleRate: currentRate, duration: generated.samples.length / currentRate, bytes: new Uint8Array(encodeWav(generated.samples, currentRate)) })
    }
  } finally {
    host.close()
    activeHost = null
  }

  const durations = audioChunks.map((chunk) => chunk.duration)
  const durationSeconds = durations.reduce((sum, duration) => sum + duration, 0)
  let audioBytes
  if (options.format === 'm4b') {
    emit(options, { stage: 'export', message: 'assembling chaptered M4B with FFmpeg' })
    const result = await buildM4bAudiobook({
      chunks: audioChunks.map((chunk) => ({ bytes: chunk.bytes, title: chunk.title })),
      title: options.title,
      bitrate: options.bitrate,
    })
    audioBytes = new Uint8Array(result.bytes)
  } else if (options.format === 'wav') {
    const samples = concatFloat32Arrays(audioChunks.map((chunk) => chunk.samples))
    audioBytes = new Uint8Array(encodeWav(samples, sampleRate))
  } else {
    emit(options, { stage: 'export', message: `encoding ${options.format} with FFmpeg` })
    const samples = concatFloat32Arrays(audioChunks.map((chunk) => chunk.samples))
    const result = await transcodePcm({ samples, sampleRate, format: options.format, bitrate: options.bitrate, title: options.title })
    if (!result?.bytes) throw new Error(`FFmpeg did not return ${options.format} output.`)
    audioBytes = new Uint8Array(result.bytes)
  }

  const cues = buildCliCues(audioChunks)
  await writeAtomic(options.outputPath, audioBytes, options.force)
  if (options.srtPath) await writeAtomic(options.srtPath, toSRT(cues), options.force)
  if (options.vttPath) await writeAtomic(options.vttPath, toVTT(cues), options.force)
  emitResult(options, {
    ...plan,
    audioPath: options.outputPath,
    srtPath: options.srtPath,
    vttPath: options.vttPath,
    cueCount: cues.length,
    durationSeconds: Number(durationSeconds.toFixed(3)),
    sampleRate,
    audioBytes: audioBytes.byteLength,
  })
}

async function main() {
  let json = process.argv.includes('--json') || process.argv.includes('--progress=json')
  try {
    const parsed = parseCliArgs(process.argv.slice(2))
    if (parsed.kind === 'help') {
      process.stdout.write(`${CLI_USAGE}\n`)
      return
    }
    if (parsed.kind === 'version') {
      process.stdout.write(`${version()}\n`)
      return
    }
    json = parsed.options.json
    await runSynth(parsed.options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const exitCode = error instanceof CliUsageError ? error.exitCode : interrupted ? 130 : 1
    if (json) process.stderr.write(`${JSON.stringify({ type: 'error', ok: false, exitCode, message })}\n`)
    else process.stderr.write(`[bettertts] error: ${message}\n`)
    process.exitCode = exitCode
  }
}

void main()
