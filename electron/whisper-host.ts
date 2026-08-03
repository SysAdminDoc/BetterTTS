// Isolated whisper.cpp host for desktop captioning (TF-117). The renderer and
// Electron main process never spawn or parse the native executable directly;
// this utility process owns temporary audio files, subprocess lifetime, and
// the untrusted JSON result.
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  WHISPER_MODEL_FILENAME,
  WHISPER_MODEL_URL,
  formatWhisperRuntimeRecovery,
  parseWhisperJson,
  type WhisperRuntimeStatus,
} from '../src/lib/whisper.ts'
import type { WhisperHostRequest, WhisperHostResponse } from './whisper-ipc.ts'

type ParentPortLike = {
  postMessage: (message: unknown) => void
  on: (event: 'message', listener: (event: { data: WhisperHostRequest }) => void) => void
}

type Port = {
  post: (message: WhisperHostResponse) => void
  onMessage: (handler: (message: WhisperHostRequest) => void) => void
}

function getPort(): Port {
  const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort
  if (parentPort) {
    return {
      post: (message) => parentPort.postMessage(message),
      onMessage: (handler) => parentPort.on('message', (event) => handler(event.data)),
    }
  }
  return {
    post: (message) => process.send?.(message),
    onMessage: (handler) => process.on('message', handler as (message: unknown) => void),
  }
}

const port = getPort()
const moduleDir = dirname(fileURLToPath(import.meta.url))
const tasks = new Map<number, ChildProcess>()
const cancelledIds = new Set<number>()

function configuredPath(name: string): string | undefined {
  const value = process.env[name]?.trim()
  if (!value) return undefined
  const candidate = isAbsolute(value) ? value : resolve(value)
  return existsSync(candidate) ? candidate : undefined
}

function resourcePath(): string | undefined {
  const value = (process as unknown as { resourcesPath?: unknown }).resourcesPath
  return typeof value === 'string' && value.trim() ? value : undefined
}

function cliPath(): string | undefined {
  const candidates = [
    configuredPath('BETTERTTS_WHISPER_CLI'),
    resourcePath() ? join(resourcePath()!, 'whisper', 'whisper-cli.exe') : undefined,
    join(moduleDir, 'whisper', 'whisper-cli.exe'),
    join(process.cwd(), 'dist-electron', 'whisper', 'whisper-cli.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find((candidate) => existsSync(candidate))
}

function modelPath(): string | undefined {
  const configured = configuredPath('BETTERTTS_WHISPER_MODEL')
  if (configured) return configured

  const names = [
    WHISPER_MODEL_FILENAME,
    'ggml-small.bin',
    'ggml-tiny.bin',
    'ggml-medium.bin',
    'ggml-large-v3.bin',
  ]
  const directories = [
    process.env.BETTERTTS_WHISPER_MODEL_DIR,
    resourcePath() ? join(resourcePath()!, 'whisper-models') : undefined,
    join(moduleDir, 'whisper-models'),
    join(process.cwd(), 'dist-electron', 'whisper-models'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const directory of directories) {
    for (const name of names) {
      const candidate = isAbsolute(directory) ? join(directory, name) : resolve(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function runtimeStatus(): WhisperRuntimeStatus {
  const executable = cliPath()
  const model = modelPath()
  const available = Boolean(executable && model)
  const message = available
    ? `whisper.cpp ${basename(executable!)} with ${basename(model!)}`
    : !executable
      ? 'The whisper.cpp desktop runtime is not installed yet.'
      : `The multilingual ${WHISPER_MODEL_FILENAME} model is not installed yet.`
  return {
    available,
    ...(executable ? { cliPath: executable } : {}),
    ...(model ? { modelPath: model, modelName: basename(model) } : {}),
    message,
    recovery: `${formatWhisperRuntimeRecovery({ cliPath: executable, modelPath: model })} Model source: ${WHISPER_MODEL_URL}`,
  }
}

function progressFromStderr(text: string): number | null {
  const match = text.match(/(?:progress|progress\s*=)\s*[:=]?\s*(\d{1,3})\s*%/iu)
  if (!match) return null
  const progress = Number(match[1])
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null
}

async function transcribe(id: number, audio: Uint8Array, language: string): Promise<void> {
  const status = runtimeStatus()
  if (!status.cliPath) {
    port.post({ type: 'error', id, code: 'missing-cli', message: status.recovery })
    return
  }
  if (!status.modelPath) {
    port.post({ type: 'error', id, code: 'missing-model', message: status.recovery })
    return
  }

  let directory: string | null = null
  try {
    directory = await mkdtemp(join(tmpdir(), 'bettertts-whisper-'))
    const inputPath = join(directory, 'input.wav')
    const outputBase = join(directory, 'caption')
    await writeFile(inputPath, audio)

    const child = spawn(status.cliPath, [
      '-m', status.modelPath,
      '-f', inputPath,
      '-of', outputBase,
      '-ojf',
      '-ml', '1',
      '-sow',
      '-l', language,
      '-t', '4',
      '-np',
    ], {
      cwd: directory,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    tasks.set(id, child)

    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-32_000)
      const progress = progressFromStderr(chunk)
      if (progress !== null) port.post({ type: 'progress', id, progress })
    })

    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      child.once('error', rejectExit)
      child.once('exit', (code, signal) => {
        if (signal) rejectExit(new Error(`whisper.cpp exited after ${signal}.`))
        else resolveExit(code ?? 1)
      })
    })
    if (exitCode !== 0) {
      throw new Error(stderr.trim().split(/\r?\n/u).filter(Boolean).at(-1) ?? `whisper.cpp exited with code ${exitCode}.`)
    }

    const json = JSON.parse(await readFile(`${outputBase}.json`, 'utf8')) as unknown
    const alignment = parseWhisperJson(json, language)
    if (alignment.cues.length === 0) throw new Error('No speech was detected in the imported audio.')
    port.post({ type: 'result', id, alignment })
  } catch (error) {
    const cancelled = cancelledIds.delete(id)
    port.post({
      type: 'error',
      id,
      code: cancelled ? 'cancelled' : 'failed',
      message: cancelled ? 'Caption generation cancelled.' : error instanceof Error ? error.message : 'whisper.cpp captioning failed.',
    })
  } finally {
    tasks.delete(id)
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

function cancel(id: number): void {
  const child = tasks.get(id)
  if (!child) return
  cancelledIds.add(id)
  tasks.delete(id)
  child.kill()
}

port.onMessage((message) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'status') {
    port.post({ type: 'status', id: message.id, status: runtimeStatus() })
  } else if (message.type === 'cancel') {
    cancel(message.id)
  } else if (message.type === 'transcribe') {
    void transcribe(message.id, message.audio, message.language)
  }
})
