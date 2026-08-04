// Optional PyTorch sidecar host (TF-118). Electron only talks to this small
// Node utility process. The host owns Python discovery, venv setup, JSON-lines
// transport, sidecar crash reporting, and PCM conversion; the renderer never
// receives a process handle or a localhost listener.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  QWEN_MODEL_ID,
  type SidecarHostMessage,
  type SidecarStatus,
  validateSidecarRequest,
} from './sidecar-ipc.ts'

type ParentPortLike = {
  postMessage: (message: unknown) => void
  on: (event: 'message', listener: (event: { data: unknown }) => void) => void
}

type Port = {
  post: (message: SidecarHostMessage) => void
  onMessage: (handler: (message: unknown) => void) => void
}

type PythonCommand = {
  file: string
  args: string[]
}

type StatusWaiter = {
  resolve: (status: SidecarStatus) => void
  reject: (error: Error) => void
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
const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const statusWaiters = new Map<number, StatusWaiter>()
const activeRequestIds = new Set<number>()
let sidecarProcess: ChildProcessWithoutNullStreams | null = null
let setupProcess: ChildProcessWithoutNullStreams | null = null
let setupRequestId: number | null = null
let intentionalStop = false
let lineBuffer = ''
let internalRequestId = 1_000_000

const MAX_SIDECAR_LINE_BYTES = 120 * 1024 * 1024

function safeMessage(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : String(error || fallback))
    .replaceAll(process.cwd(), '<app>')
    .replace(/\r?\n/g, ' ')
    .slice(0, 1_000)
}

function sidecarDirectory(): string {
  return process.env.BETTERTTS_SIDECAR_DIR ?? resolve(moduleDirectory, '..', 'sidecar-data')
}

function modelDirectory(): string {
  return process.env.BETTERTTS_SIDECAR_MODEL_DIR ?? join(sidecarDirectory(), 'models', 'qwen')
}

function venvPythonPath(): string {
  return process.platform === 'win32'
    ? join(sidecarDirectory(), 'venv', 'Scripts', 'python.exe')
    : join(sidecarDirectory(), 'venv', 'bin', 'python')
}

function sidecarScriptPath(): string {
  return process.env.BETTERTTS_SIDECAR_SCRIPT
    ?? resolve(moduleDirectory, '..', 'sidecar', 'bettertts_sidecar.py')
}

function requirementsPath(): string {
  return process.env.BETTERTTS_SIDECAR_REQUIREMENTS
    ?? resolve(moduleDirectory, '..', 'sidecar', 'requirements-qwen.txt')
}

function configuredPython(): string | undefined {
  const configured = process.env.BETTERTTS_SIDECAR_PYTHON?.trim()
  return configured || undefined
}

function sidecarPython(): PythonCommand {
  const configured = configuredPython()
  if (configured) return { file: configured, args: [] }
  if (existsSync(venvPythonPath())) return { file: venvPythonPath(), args: [] }
  return process.platform === 'win32'
    ? { file: 'py', args: ['-3.12'] }
    : { file: 'python3', args: [] }
}

function setupPython(): PythonCommand {
  const configured = configuredPython()
  if (configured) return { file: configured, args: [] }
  return process.platform === 'win32'
    ? { file: 'py', args: ['-3.12'] }
    : { file: 'python3', args: [] }
}

function unavailableStatus(message: string): SidecarStatus {
  return {
    available: false,
    qwenInstalled: false,
    torchInstalled: false,
    modelReady: false,
    modelId: QWEN_MODEL_ID,
    message,
    recovery: `Install Python 3.12, then use Set up Qwen3-TTS. The optional runtime is kept outside the app package. Model weights download on first synthesis into ${modelDirectory()}.`,
  }
}

function sendError(id: number, code: 'missing-python' | 'missing-package' | 'missing-model' | 'cancelled' | 'failed' | 'crashed', message: string): void {
  activeRequestIds.delete(id)
  port.post({ type: 'error', id, code, message: safeMessage(message, 'The Qwen3-TTS sidecar request failed.') })
}

function sendLine(line: unknown): boolean {
  const child = sidecarProcess
  if (!child || child.killed || !child.stdin.writable) return false
  child.stdin.write(`${JSON.stringify(line)}\n`)
  return true
}

function decodePcm16(value: unknown): Float32Array {
  if (typeof value !== 'string' || value.length > MAX_SIDECAR_LINE_BYTES) throw new Error('The sidecar returned an invalid audio payload.')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.length % 2 !== 0 || bytes.length > 80 * 1024 * 1024) throw new Error('The sidecar returned invalid PCM audio.')
  const samples = new Float32Array(bytes.length / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768
  return samples
}

function settleStatus(id: number, status: SidecarStatus): void {
  const waiter = statusWaiters.get(id)
  if (waiter) {
    statusWaiters.delete(id)
    waiter.resolve(status)
    return
  }
  port.post({ type: 'status', id, status })
}

function handleSidecarMessage(message: unknown): void {
  if (!message || typeof message !== 'object') return
  const value = message as Record<string, unknown>
  const id = Number(value.id)
  if (value.type === 'status' && Number.isSafeInteger(id) && value.status && typeof value.status === 'object') {
    settleStatus(id, value.status as SidecarStatus)
    return
  }
  if (value.type === 'progress' && Number.isSafeInteger(id)) {
    port.post({ type: 'progress', id, progress: Math.min(1, Math.max(0, Number(value.progress) || 0)), stage: String(value.stage ?? 'Generating').slice(0, 200) })
    return
  }
  if (value.type === 'result' && Number.isSafeInteger(id)) {
    activeRequestIds.delete(id)
    try {
      port.post({ type: 'generated', id, samples: decodePcm16(value.pcm16), sampleRate: Number(value.sample_rate) || 24_000 })
    } catch (error) {
      sendError(id, 'failed', safeMessage(error, 'The sidecar returned invalid audio.'))
    }
    return
  }
  if (value.type === 'error' && Number.isSafeInteger(id)) {
    const code = value.code === 'cancelled' ? 'cancelled' : value.code === 'missing-package' ? 'missing-package' : 'failed'
    sendError(id, code, String(value.message ?? 'The Qwen3-TTS sidecar failed.'))
  }
}

function rejectSidecarRequests(message: string): void {
  for (const id of activeRequestIds) sendError(id, 'crashed', message)
  activeRequestIds.clear()
  for (const [id, waiter] of statusWaiters) {
    statusWaiters.delete(id)
    waiter.reject(new Error(message))
  }
  port.post({ type: 'crashed', message })
}

function stopSidecar(): void {
  const child = sidecarProcess
  if (!child) return
  intentionalStop = true
  sidecarProcess = null
  child.stdin.end()
  child.kill()
  intentionalStop = false
}

function startSidecar(): ChildProcessWithoutNullStreams {
  if (sidecarProcess) return sidecarProcess
  const script = sidecarScriptPath()
  if (!existsSync(script)) throw new Error(`The Qwen3-TTS sidecar script is missing: ${script}`)
  const command = sidecarPython()
  const environment = {
    ...process.env,
    BETTERTTS_SIDECAR_MODEL_DIR: modelDirectory(),
    BETTERTTS_SIDECAR_REQUIREMENTS: requirementsPath(),
    PYTHONUNBUFFERED: '1',
  }
  const child = spawn(command.file, [...command.args, '-u', script], {
    cwd: existsSync(sidecarDirectory()) ? sidecarDirectory() : resolve(moduleDirectory, '..'),
    env: environment,
    stdio: 'pipe',
    windowsHide: true,
  })
  sidecarProcess = child
  lineBuffer = ''
  child.stdout.on('data', (chunk: Buffer | string) => {
    lineBuffer += String(chunk)
    if (Buffer.byteLength(lineBuffer, 'utf8') > MAX_SIDECAR_LINE_BYTES) {
      child.kill()
      rejectSidecarRequests('The Qwen3-TTS sidecar returned an oversized message.')
      return
    }
    let newline = lineBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = lineBuffer.slice(0, newline).trim()
      lineBuffer = lineBuffer.slice(newline + 1)
      if (line) {
        try {
          handleSidecarMessage(JSON.parse(line))
        } catch {
          // Ignore non-protocol diagnostic lines; stderr is the sidecar log.
        }
      }
      newline = lineBuffer.indexOf('\n')
    }
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr = `${stderr}${String(chunk)}`.slice(-2_000)
  })
  child.once('error', (error) => {
    if (sidecarProcess !== child) return
    sidecarProcess = null
    if (!intentionalStop) rejectSidecarRequests(safeMessage(error, 'The Qwen3-TTS Python process could not start.'))
    intentionalStop = false
  })
  child.once('exit', (code, signal) => {
    if (sidecarProcess !== child) return
    sidecarProcess = null
    if (!intentionalStop) {
      const detail = stderr.trim() ? ` ${stderr.trim().slice(-600)}` : ''
      rejectSidecarRequests(`The Qwen3-TTS Python sidecar stopped (${code ?? signal ?? 'unknown'}).${detail}`)
    }
    intentionalStop = false
  })
  return child
}

function requestStatus(id: number): void {
  try {
    startSidecar()
    statusWaiters.set(id, {
      resolve: (status) => port.post({ type: 'status', id, status }),
      reject: (error) => port.post({ type: 'status', id, status: unavailableStatus(safeMessage(error, 'The Python sidecar is unavailable.')) }),
    })
    if (!sendLine({ type: 'status', id })) {
      statusWaiters.delete(id)
      port.post({ type: 'status', id, status: unavailableStatus('The Qwen3-TTS Python process is not running.') })
    }
  } catch (error) {
    port.post({ type: 'status', id, status: unavailableStatus(safeMessage(error, 'Python 3.12 is not installed.')) })
  }
}

function requestStatusInternal(): Promise<SidecarStatus> {
  const id = internalRequestId++
  return new Promise((resolveStatus, reject) => {
    try {
      startSidecar()
      statusWaiters.set(id, { resolve: resolveStatus, reject })
      if (!sendLine({ type: 'status', id })) {
        statusWaiters.delete(id)
        reject(new Error('The Qwen3-TTS sidecar is not running.'))
      }
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function runExternal(command: PythonCommand, args: string[], onLine: (line: string) => void): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command.file, [...command.args, ...args], {
      cwd: sidecarDirectory(),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: 'pipe',
      windowsHide: true,
    })
    setupProcess = child
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) onLine(line.trim().slice(0, 240))
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000)
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) onLine(line.trim().slice(0, 240))
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (setupProcess === child) setupProcess = null
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${stderr.trim() || 'Python setup failed'} (${code ?? signal ?? 'unknown'}).`))
    })
  })
}

async function setupEnvironment(id: number): Promise<void> {
  if (setupRequestId !== null) {
    port.post({ type: 'setup-progress', id, progress: 0, stage: 'Another Qwen3-TTS setup is already running.' })
    sendError(id, 'failed', 'Another Qwen3-TTS setup is already running.')
    return
  }
  setupRequestId = id
  try {
    await mkdir(sidecarDirectory(), { recursive: true })
    const configured = Boolean(configuredPython())
    const venv = venvPythonPath()
    if (!configured && !existsSync(venv)) {
      port.post({ type: 'setup-progress', id, progress: 0.08, stage: 'Creating an isolated Python 3.12 environment' })
      await runExternal(setupPython(), ['-m', 'venv', join(sidecarDirectory(), 'venv')], () => undefined)
    }
    const requirementFile = requirementsPath()
    const installArgs = existsSync(requirementFile)
      ? ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', '-r', requirementFile]
      : ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'qwen-tts==0.1.1', 'torch']
    port.post({ type: 'setup-progress', id, progress: 0.35, stage: 'Downloading torch and Qwen3-TTS dependencies' })
    await runExternal(sidecarPython(), installArgs, (line) => {
      port.post({ type: 'setup-progress', id, progress: 0.45, stage: line })
    })
    stopSidecar()
    const status = await requestStatusInternal()
    port.post({ type: 'setup-result', id, status })
  } catch (error) {
    if (setupRequestId === id) sendError(id, 'failed', safeMessage(error, 'Qwen3-TTS setup failed.'))
  } finally {
    if (setupRequestId === id) setupRequestId = null
  }
}

port.onMessage((value) => {
  const request = validateSidecarRequest(value)
  if (!request) {
    const candidate = value as { id?: unknown }
    if (Number.isSafeInteger(candidate?.id) && Number(candidate.id) >= 0) sendError(Number(candidate.id), 'failed', 'Invalid Qwen3-TTS sidecar request.')
    return
  }
  if (request.type === 'status') {
    requestStatus(request.id)
  } else if (request.type === 'setup') {
    void setupEnvironment(request.id)
  } else if (request.type === 'cancel') {
    if (setupRequestId === request.id) {
      setupProcess?.kill()
      sendError(request.id, 'cancelled', 'Qwen3-TTS setup cancelled.')
      setupRequestId = null
    } else if (activeRequestIds.has(request.id)) {
      sendLine({ type: 'cancel', id: request.id })
    }
  } else if (request.type === 'synthesize') {
    try {
      startSidecar()
      activeRequestIds.add(request.id)
      if (!sendLine(request)) sendError(request.id, 'crashed', 'The Qwen3-TTS sidecar is not running.')
    } catch (error) {
      sendError(request.id, 'missing-python', safeMessage(error, 'Python 3.12 is not installed.'))
    }
  }
})
