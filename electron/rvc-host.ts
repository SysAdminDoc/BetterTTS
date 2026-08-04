// Isolated RVC post-stage host. The renderer only sends structured PCM and
// already-registered local model paths to this utility process. Python owns
// torch/RVC imports, model loading, temporary WAVs, and cancellation.
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RVC_MAX_PCM_BYTES,
  type RvcHostMessage,
  type RvcRuntimeStatus,
  validateRvcRequest,
} from './rvc-ipc.ts'

type ParentPortLike = {
  postMessage: (message: unknown) => void
  on: (event: 'message', listener: (event: { data: unknown }) => void) => void
}

type Port = {
  post: (message: RvcHostMessage) => void
  onMessage: (handler: (message: unknown) => void) => void
}

type PythonCommand = { file: string; args: string[] }

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
const tasks = new Map<number, ChildProcessWithoutNullStreams>()
const cancelledIds = new Set<number>()
let setupProcess: ChildProcessWithoutNullStreams | null = null
let setupRequestId: number | null = null
let internalRequestId = 1_000_000

const MAX_LINE_BYTES = 120 * 1024 * 1024

function safeMessage(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : String(error || fallback))
    .replaceAll(process.cwd(), '<app>')
    .replace(/\r?\n/g, ' ')
    .slice(0, 1_000)
}

function rvcDirectory(): string {
  return process.env.BETTERTTS_RVC_DIR ?? resolve(moduleDirectory, '..', 'rvc-data')
}

function venvPythonPath(): string {
  return process.platform === 'win32'
    ? join(rvcDirectory(), 'venv', 'Scripts', 'python.exe')
    : join(rvcDirectory(), 'venv', 'bin', 'python')
}

function configuredPython(): string | undefined {
  const value = process.env.BETTERTTS_RVC_PYTHON?.trim()
  return value || undefined
}

function rvcPython(): PythonCommand {
  const configured = configuredPython()
  if (configured) return { file: configured, args: [] }
  if (existsSync(venvPythonPath())) return { file: venvPythonPath(), args: [] }
  return process.platform === 'win32'
    ? { file: 'py', args: ['-3.10'] }
    : { file: 'python3.10', args: [] }
}

function setupPython(): PythonCommand {
  const configured = configuredPython()
  if (configured) return { file: configured, args: [] }
  return process.platform === 'win32'
    ? { file: 'py', args: ['-3.10'] }
    : { file: 'python3.10', args: [] }
}

function scriptPath(): string {
  return process.env.BETTERTTS_RVC_SCRIPT
    ?? resolve(moduleDirectory, '..', 'sidecar', 'bettertts_rvc.py')
}

function requirementsPath(): string {
  return process.env.BETTERTTS_RVC_REQUIREMENTS
    ?? resolve(moduleDirectory, '..', 'sidecar', 'requirements-rvc.txt')
}

function unavailableStatus(message: string): RvcRuntimeStatus {
  return {
    available: false,
    rvcInstalled: false,
    torchInstalled: false,
    message,
    recovery: 'Install Python 3.10, then use Set up RVC runtime. The optional environment and all model files stay outside the app package.',
  }
}

function pcm16Base64(samples: Float32Array): string {
  const bytes = Buffer.allocUnsafe(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    bytes.writeInt16LE(Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), index * 2)
  }
  return bytes.toString('base64')
}

function decodePcm16(value: unknown): Float32Array {
  if (typeof value !== 'string') throw new Error('The RVC adapter returned an invalid PCM payload.')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.length % 2 !== 0 || bytes.length > RVC_MAX_PCM_BYTES) {
    throw new Error('The RVC adapter returned invalid PCM audio.')
  }
  const samples = new Float32Array(bytes.length / 2)
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2) / 32768
  return samples
}

function postError(id: number, code: Extract<RvcHostMessage, { type: 'error' }>['code'], message: string): void {
  port.post({ type: 'error', id, code, message: safeMessage(message, 'RVC voice conversion failed.') })
}

function parseAdapterOutput(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)
  if (!line || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('The RVC adapter returned no valid protocol response.')
  const parsed = JSON.parse(line) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The RVC adapter returned an invalid protocol response.')
  return parsed as Record<string, unknown>
}

function runPythonOnce(input: Record<string, unknown>, id: number, onProgress?: (progress: number, stage: string) => void): Promise<Record<string, unknown>> {
  return new Promise((resolveOutput, rejectOutput) => {
    const command = rvcPython()
    const child = spawn(command.file, [...command.args, '-u', scriptPath()], {
      cwd: existsSync(rvcDirectory()) ? rvcDirectory() : resolve(moduleDirectory, '..'),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: 'pipe',
      windowsHide: true,
    })
    tasks.set(id, child)
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout = `${stdout}${String(chunk)}`
      if (Buffer.byteLength(stdout, 'utf8') > MAX_LINE_BYTES) {
        child.kill()
        if (!settled) {
          settled = true
          rejectOutput(new Error('The RVC adapter returned an oversized response.'))
        }
        return
      }
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (!line.trim()) continue
        try {
          const message = JSON.parse(line) as Record<string, unknown>
          if (message.type === 'progress') {
            onProgress?.(Math.min(1, Math.max(0, Number(message.progress) || 0)), String(message.stage ?? 'Converting voice').slice(0, 200))
          }
        } catch {
          // Diagnostics belong on stderr; non-JSON stdout is ignored until the
          // final JSON response is parsed.
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000)
    })
    child.once('error', (error) => {
      tasks.delete(id)
      if (settled) return
      settled = true
      rejectOutput(error)
    })
    child.once('exit', (code, signal) => {
      tasks.delete(id)
      if (settled) return
      settled = true
      if (cancelledIds.delete(id)) {
        rejectOutput(new DOMException('RVC conversion cancelled.', 'AbortError'))
        return
      }
      if (code !== 0) {
        rejectOutput(new Error(stderr.trim() || `The RVC adapter stopped (${code ?? signal ?? 'unknown'}).`))
        return
      }
      try {
        resolveOutput(parseAdapterOutput(stdout))
      } catch (error) {
        rejectOutput(error)
      }
    })
    child.stdin.end(`${JSON.stringify(input)}\n`)
  })
}

async function requestStatus(id: number): Promise<void> {
  if (!existsSync(scriptPath())) {
    port.post({ type: 'status', id, status: unavailableStatus(`The RVC adapter script is missing: ${scriptPath()}`) })
    return
  }
  try {
    const output = await runPythonOnce({ type: 'status' }, id)
    if (output.type !== 'status' || !output.status || typeof output.status !== 'object') throw new Error('The RVC adapter returned an invalid status.')
    port.post({ type: 'status', id, status: output.status as RvcRuntimeStatus })
  } catch (error) {
    const message = safeMessage(error, 'Python 3.10 is not installed.')
    port.post({ type: 'status', id, status: unavailableStatus(message) })
  }
}

async function convert(request: Extract<ReturnType<typeof validateRvcRequest>, { type: 'convert' }>): Promise<void> {
  try {
    const output = await runPythonOnce({
      type: 'convert',
      id: request.id,
      sample_rate: request.sampleRate,
      pcm16: pcm16Base64(request.samples),
      model_path: request.modelPath,
      ...(request.indexPath ? { index_path: request.indexPath } : {}),
      ...(request.blendModelPath ? { blend_model_path: request.blendModelPath } : {}),
      ...(request.blendIndexPath ? { blend_index_path: request.blendIndexPath } : {}),
      blend_ratio: request.blendRatio,
      pitch_semitones: request.pitchSemitones,
      index_rate: request.indexRate,
    }, request.id, (progress, stage) => port.post({ type: 'progress', id: request.id, progress, stage }))
    if (output.type === 'error') {
      const code = output.code === 'missing-model' ? 'missing-model' : output.code === 'missing-package' ? 'missing-package' : 'failed'
      postError(request.id, code, String(output.message ?? 'The RVC adapter failed.'))
      return
    }
    if (output.type !== 'result') throw new Error('The RVC adapter returned no converted audio.')
    const samples = decodePcm16(output.pcm16)
    if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample))) throw new Error('The RVC adapter returned invalid audio.')
    port.post({ type: 'generated', id: request.id, samples, sampleRate: Number(output.sample_rate) || request.sampleRate })
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === 'AbortError'
    const missingPython = error instanceof Error && /ENOENT|not found|not installed/i.test(error.message)
    postError(request.id, cancelled ? 'cancelled' : missingPython ? 'missing-python' : 'failed', cancelled ? 'RVC conversion cancelled.' : safeMessage(error, 'RVC conversion failed.'))
  }
}

function runExternal(command: PythonCommand, args: string[], onLine: (line: string) => void): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command.file, [...command.args, ...args], {
      cwd: rvcDirectory(),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: 'pipe',
      windowsHide: true,
    })
    setupProcess = child
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/u)) if (line.trim()) onLine(line.trim().slice(0, 240))
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000)
      for (const line of String(chunk).split(/\r?\n/u)) if (line.trim()) onLine(line.trim().slice(0, 240))
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (setupProcess === child) setupProcess = null
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${stderr.trim() || 'RVC setup failed'} (${code ?? signal ?? 'unknown'}).`))
    })
  })
}

async function setup(id: number): Promise<void> {
  if (setupRequestId !== null) {
    port.post({ type: 'setup-progress', id, progress: 0, stage: 'Another RVC setup is already running.' })
    postError(id, 'failed', 'Another RVC setup is already running.')
    return
  }
  setupRequestId = id
  try {
    await mkdir(rvcDirectory(), { recursive: true })
    const configured = Boolean(configuredPython())
    if (!configured && !existsSync(venvPythonPath())) {
      port.post({ type: 'setup-progress', id, progress: 0.08, stage: 'Creating an isolated Python 3.10 environment' })
      await runExternal(setupPython(), ['-m', 'venv', join(rvcDirectory(), 'venv')], () => undefined)
    }
    const requirementFile = requirementsPath()
    port.post({ type: 'setup-progress', id, progress: 0.35, stage: 'Installing the optional RVC Python adapter' })
    await runExternal(rvcPython(), existsSync(requirementFile)
      ? ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', '-r', requirementFile]
      : ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'rvc-python==0.1.5'], (line) => {
      port.post({ type: 'setup-progress', id, progress: 0.45, stage: line })
    })
    const output = await runPythonOnce({ type: 'status' }, internalRequestId++)
    if (!output.status || typeof output.status !== 'object') throw new Error('RVC setup returned no runtime status.')
    port.post({ type: 'setup-result', id, status: output.status as RvcRuntimeStatus })
  } catch (error) {
    postError(id, 'failed', safeMessage(error, 'RVC setup failed.'))
  } finally {
    if (setupRequestId === id) setupRequestId = null
    setupProcess = null
  }
}

port.onMessage((message) => {
  const request = validateRvcRequest(message)
  if (!request) return
  if (request.type === 'status') {
    void requestStatus(request.id)
  } else if (request.type === 'setup') {
    void setup(request.id)
  } else if (request.type === 'cancel') {
    const task = tasks.get(request.id)
    if (task) {
      cancelledIds.add(request.id)
      task.kill()
    }
  } else {
    void convert(request)
  }
})
