import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

export const MODEL_EVAL_SCHEMA_VERSION = 1
export const DEFAULT_PROMPT_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_RTF = 5

export const EVAL_PROMPTS = Object.freeze([
  { id: 'short', text: 'The quiet library opened before sunrise.' },
  { id: 'numbers', text: 'Chapter twelve begins at 7:45 a.m. with 42 pages remaining.' },
  { id: 'multilingual', text: 'Hello, bonjour, hola, and こんにちは — welcome to the local voice test.' },
  { id: 'long-form', text: 'A reliable narrator preserves punctuation, paragraph rhythm, names, and measured pauses while reading a complete passage from beginning to end.' },
])

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const REVISION_PATTERN = /^[a-f0-9]{40,64}$/i
const HTTPS_PATTERN = /^https:\/\/[^\s]+$/i
const LICENSE_TIERS = new Set(['permissive', 'restricted', 'non-commercial'])

function asRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid evaluation manifest: ${label} must be an object.`)
  return value
}

function requiredString(record, key, maxLength) {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw new Error(`Invalid evaluation manifest: ${key} must be a non-empty string.`)
  return value
}

function optionalString(record, key, maxLength) {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw new Error(`Invalid evaluation manifest: ${key} must be a non-empty string.`)
  return value
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid evaluation manifest: ${label} must be a positive safe integer.`)
  return value
}

function parseLicense(input) {
  const record = asRecord(input, 'license')
  const spdx = requiredString(record, 'spdx', 120)
  if (typeof record.tier !== 'string' || !LICENSE_TIERS.has(record.tier)) throw new Error('Invalid evaluation manifest: license.tier is not supported.')
  const url = optionalString(record, 'url', 500)
  if (url && !HTTPS_PATTERN.test(url)) throw new Error('Invalid evaluation manifest: license.url must use HTTPS.')
  return { spdx, tier: record.tier, ...(url ? { url } : {}) }
}

function parseModelFiles(input) {
  if (!Array.isArray(input) || input.length === 0) throw new Error('Invalid evaluation manifest: modelFiles must not be empty.')
  const paths = new Set()
  const files = input.map((entry, index) => {
    const record = asRecord(entry, `modelFiles[${index}]`)
    const path = requiredString(record, 'path', 400)
    const parts = path.split('/')
    if (path.startsWith('/') || path.includes('\\') || parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Invalid evaluation manifest: unsafe modelFiles[${index}].path.`)
    if (paths.has(path)) throw new Error(`Invalid evaluation manifest: duplicate model file ${path}.`)
    paths.add(path)
    const sizeBytes = positiveInteger(record.sizeBytes, `modelFiles[${index}].sizeBytes`)
    const sha256 = requiredString(record, 'sha256', 64).toLowerCase()
    if (!SHA256_PATTERN.test(sha256)) throw new Error(`Invalid evaluation manifest: modelFiles[${index}].sha256 must be SHA-256.`)
    const revision = optionalString(record, 'revision', 64)
    if (revision && !REVISION_PATTERN.test(revision)) throw new Error(`Invalid evaluation manifest: modelFiles[${index}].revision must be immutable.`)
    const sourceUrl = optionalString(record, 'sourceUrl', 500)
    if (sourceUrl && !HTTPS_PATTERN.test(sourceUrl)) throw new Error(`Invalid evaluation manifest: modelFiles[${index}].sourceUrl must use HTTPS.`)
    return { path, sizeBytes, sha256, ...(revision ? { revision } : {}), ...(sourceUrl ? { sourceUrl } : {}) }
  })
  return files
}

function parseCommand(input) {
  const record = asRecord(input, 'command')
  const executable = requiredString(record, 'executable', 400)
  const args = record.args ?? []
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.length > 2_000)) throw new Error('Invalid evaluation manifest: command.args must be strings.')
  const cwd = optionalString(record, 'cwd', 1_000)
  return { executable, args: [...args], ...(cwd ? { cwd } : {}) }
}

export function validateCandidateManifest(input) {
  const record = asRecord(input, 'root')
  if (record.schemaVersion !== MODEL_EVAL_SCHEMA_VERSION) throw new Error(`Invalid evaluation manifest: unsupported schemaVersion ${String(record.schemaVersion)}.`)
  const id = requiredString(record, 'id', 64)
  if (!ID_PATTERN.test(id)) throw new Error('Invalid evaluation manifest: id contains unsupported characters.')
  const label = requiredString(record, 'label', 120)
  const provider = requiredString(record, 'provider', 120)
  const runtime = requiredString(record, 'runtime', 80)
  const modelId = requiredString(record, 'modelId', 240)
  const license = parseLicense(record.license)
  const modelFiles = parseModelFiles(record.modelFiles)
  const command = parseCommand(record.command)
  const modelRoot = optionalString(record, 'modelRoot', 1_000)
  const maxRtf = record.maxRtf === undefined ? DEFAULT_MAX_RTF : Number(record.maxRtf)
  if (!Number.isFinite(maxRtf) || maxRtf <= 0 || maxRtf > 100) throw new Error('Invalid evaluation manifest: maxRtf must be between 0 and 100.')
  return {
    schemaVersion: MODEL_EVAL_SCHEMA_VERSION,
    id,
    label,
    provider,
    runtime,
    modelId,
    license,
    modelFiles,
    command,
    ...(modelRoot ? { modelRoot } : {}),
    maxRtf,
  }
}

function modelFilesStatus(candidate, rootDir) {
  const modelSizeBytes = candidate.modelFiles.reduce((sum, file) => sum + file.sizeBytes, 0)
  if (!rootDir) return { modelSizeBytes, modelFilesPresent: null }
  const root = resolve(rootDir)
  const present = candidate.modelFiles.every((file) => {
    const absolute = resolve(root, ...file.path.split('/'))
    const relativePath = relative(root, absolute)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) return false
    return existsSync(absolute) && statSync(absolute).size === file.sizeBytes
  })
  return { modelSizeBytes, modelFilesPresent: present }
}

function failureMode(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/timed out/i.test(message)) return 'timeout'
  if (/protocol|JSON|response/i.test(message)) return 'protocol'
  if (/model|weight|asset/i.test(message)) return 'model'
  return 'runtime'
}

function requireResponseMetrics(response) {
  if (!response || response.ok === false) throw new Error(response?.error || 'Candidate returned a failed response.')
  const durationSeconds = Number(response.durationSeconds)
  const sampleRate = Number(response.sampleRate)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Candidate response is missing a positive durationSeconds.')
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error('Candidate response is missing a positive sampleRate.')
  const memoryBytes = response.memoryBytes === undefined ? undefined : positiveInteger(response.memoryBytes, 'response.memoryBytes')
  const vramBytes = response.vramBytes === undefined ? undefined : positiveInteger(response.vramBytes, 'response.vramBytes')
  return { durationSeconds, sampleRate, ...(memoryBytes ? { memoryBytes } : {}), ...(vramBytes ? { vramBytes } : {}) }
}

export async function runEvaluation({ candidate, execute = (prompt, current) => runCandidate(prompt, current), rootDir, now = () => performance.now() }) {
  const startedAt = new Date().toISOString()
  const model = modelFilesStatus(candidate, rootDir)
  const results = []
  for (const prompt of EVAL_PROMPTS) {
    const started = now()
    try {
      const response = await execute(prompt, candidate)
      const metrics = requireResponseMetrics(response)
      const wallSeconds = Math.max(0, (now() - started) / 1_000)
      results.push({
        id: prompt.id,
        text: prompt.text,
        ok: true,
        wallSeconds,
        rtf: wallSeconds / metrics.durationSeconds,
        durationSeconds: metrics.durationSeconds,
        sampleRate: metrics.sampleRate,
        ...(metrics.memoryBytes ? { memoryBytes: metrics.memoryBytes } : {}),
        ...(metrics.vramBytes ? { vramBytes: metrics.vramBytes } : {}),
      })
    } catch (error) {
      results.push({ id: prompt.id, text: prompt.text, ok: false, failureMode: failureMode(error), error: error instanceof Error ? error.message : String(error) })
    }
  }

  const successful = results.filter((result) => result.ok)
  const rtfs = successful.map((result) => result.rtf)
  const maxRtf = rtfs.length > 0 ? Math.max(...rtfs) : null
  const averageRtf = rtfs.length > 0 ? rtfs.reduce((sum, value) => sum + value, 0) / rtfs.length : null
  const peakMemoryBytes = successful.reduce((max, result) => Math.max(max, result.memoryBytes ?? 0), 0) || null
  const peakVramBytes = successful.reduce((max, result) => Math.max(max, result.vramBytes ?? 0), 0) || null
  const failureModes = [...new Set(results.filter((result) => !result.ok).map((result) => result.failureMode))]
  const passed = candidate.license.tier === 'permissive'
    && model.modelFilesPresent !== false
    && successful.length === EVAL_PROMPTS.length
    && maxRtf !== null
    && maxRtf <= candidate.maxRtf

  return {
    schemaVersion: MODEL_EVAL_SCHEMA_VERSION,
    startedAt,
    candidate: {
      id: candidate.id,
      label: candidate.label,
      provider: candidate.provider,
      runtime: candidate.runtime,
      modelId: candidate.modelId,
      license: candidate.license,
    },
    criteria: {
      promptCount: EVAL_PROMPTS.length,
      maxRtf: candidate.maxRtf,
      licenseTier: 'permissive',
      modelFilesRequired: true,
    },
    modelSizeBytes: model.modelSizeBytes,
    modelFilesPresent: model.modelFilesPresent,
    prompts: results,
    summary: {
      successful: successful.length,
      failed: results.length - successful.length,
      averageRtf,
      maxRtf,
      peakMemoryBytes,
      peakVramBytes,
      failureModes,
    },
    passed,
  }
}

function nextLine(iterator, timeoutMs) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Candidate protocol timed out after ${timeoutMs} ms.`)), timeoutMs)
  })
  return Promise.race([iterator.next(), timeout]).finally(() => clearTimeout(timer))
}

async function waitForExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null) return
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ])
  if (child.exitCode === null) child.kill()
}

/** Execute the local JSON-lines candidate protocol without a shell. */
export async function runCandidate(prompt, candidate, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS) {
  const child = spawn(candidate.command.executable, candidate.command.args, {
    cwd: candidate.command.cwd,
    env: { ...process.env, BETTERTTS_MODEL_EVAL_ID: candidate.id },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000)
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const iterator = lines[Symbol.asyncIterator]()
  const requestId = `prompt-${prompt.id}`
  try {
    child.stdin.write(`${JSON.stringify({ type: 'synthesize', id: requestId, text: prompt.text })}\n`)
    while (true) {
      const result = await nextLine(iterator, timeoutMs)
      if (result.done) throw new Error(`Candidate exited before responding.${stderr ? ` ${stderr.trim()}` : ''}`)
      let message
      try {
        message = JSON.parse(result.value)
      } catch {
        throw new Error('Candidate protocol returned a non-JSON stdout line.')
      }
      if (message?.type === 'ready') continue
      if (message?.id !== requestId) continue
      if (message.ok === false) throw new Error(message.error || 'Candidate reported a synthesis failure.')
      return message
    }
  } finally {
    try {
      child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
      child.stdin.end()
    } catch {
      /* process may have exited after its response */
    }
    lines.close()
    await waitForExit(child)
  }
}

function parseArgs(args) {
  const options = { manifest: null, output: null, timeoutMs: DEFAULT_PROMPT_TIMEOUT_MS }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--manifest') options.manifest = args[++index]
    else if (arg === '--output') options.output = args[++index]
    else if (arg === '--timeout-ms') options.timeoutMs = Number(args[++index])
    else if (arg === '--help' || arg === '-h') return { ...options, help: true }
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!options.manifest && !options.help) throw new Error('Usage: node scripts/model-eval.mjs --manifest candidate.json [--output report.json]')
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer.')
  return options
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args)
  if (options.help) {
    console.log('Usage: node scripts/model-eval.mjs --manifest candidate.json [--output report.json] [--timeout-ms 120000]')
    return 0
  }
  const manifestPath = resolve(options.manifest)
  const candidate = validateCandidateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const rootDir = candidate.modelRoot ? resolve(dirname(manifestPath), candidate.modelRoot) : undefined
  const report = await runEvaluation({ candidate, rootDir, execute: (prompt, current) => runCandidate(prompt, current, options.timeoutMs) })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (options.output) writeFileSync(resolve(options.output), serialized)
  else process.stdout.write(serialized)
  return report.passed ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  })
}
