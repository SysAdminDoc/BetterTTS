import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const QWEN_RUNTIME_PLATFORM = 'win32-x64'
export const QWEN_PYTHON_VERSION = '3.12'
export const QWEN_MODEL_ID = 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice'
export const QWEN_MODEL_REVISION = '85e237c12c027371202489a0ec509ded67b5e4b5'
export const QWEN_MODEL_MANIFEST_NAME = 'bettertts-qwen-model.json'
export const QWEN_QWEN_VERSION = '0.1.1'
export const QWEN_TORCH_VERSION = '2.7.1'
export const QWEN_SETUP_TIMEOUT_MS = 30 * 60 * 1_000
export const QWEN_GENERATION_TIMEOUT_MS = 10 * 60 * 1_000
export const QWEN_MIN_FREE_DISK_BYTES = 6 * 1024 ** 3
export const QWEN_MIN_FREE_MEMORY_BYTES = 2 * 1024 ** 3

export type QwenRuntimeWheel = {
  distribution: string
  version: string
  filename: string
  sha256: string
}

export type QwenRuntimeManifest = {
  schemaVersion: 1
  platform: typeof QWEN_RUNTIME_PLATFORM
  python: typeof QWEN_PYTHON_VERSION
  requirements: { file: string; sha256: string }
  wheels: QwenRuntimeWheel[]
  packages: { qwenTts: typeof QWEN_QWEN_VERSION; torch: typeof QWEN_TORCH_VERSION }
  model: {
    id: typeof QWEN_MODEL_ID
    revision: typeof QWEN_MODEL_REVISION
    source: string
    manifestFile: typeof QWEN_MODEL_MANIFEST_NAME
  }
  resources: {
    minFreeDiskBytes: typeof QWEN_MIN_FREE_DISK_BYTES
    minFreeMemoryBytes: typeof QWEN_MIN_FREE_MEMORY_BYTES
    setupTimeoutMs: typeof QWEN_SETUP_TIMEOUT_MS
    generationTimeoutMs: typeof QWEN_GENERATION_TIMEOUT_MS
  }
}

type RecordValue = Record<string, unknown>

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Qwen runtime manifest ${label} must be an object.`)
  return value as RecordValue
}

function stringValue(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new Error(`Qwen runtime manifest ${label} is invalid.`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`Qwen runtime manifest ${label} is invalid.`)
  return Number(value)
}

export function validateQwenRuntimeManifest(value: unknown): QwenRuntimeManifest {
  const root = record(value, 'root')
  if (root.schemaVersion !== 1) throw new Error(`Unsupported Qwen runtime manifest schema: ${String(root.schemaVersion)}.`)
  if (root.platform !== QWEN_RUNTIME_PLATFORM || root.python !== QWEN_PYTHON_VERSION) throw new Error('Qwen runtime manifest targets an unsupported platform or Python version.')

  const requirements = record(root.requirements, 'requirements')
  const wheelsValue = root.wheels
  if (!Array.isArray(wheelsValue) || wheelsValue.length < 2) throw new Error('Qwen runtime manifest must declare direct wheel hashes.')
  const wheels = wheelsValue.map((value, index) => {
    const wheel = record(value, `wheels[${index}]`)
    return {
      distribution: stringValue(wheel.distribution, `wheels[${index}].distribution`),
      version: stringValue(wheel.version, `wheels[${index}].version`),
      filename: stringValue(wheel.filename, `wheels[${index}].filename`),
      sha256: stringValue(wheel.sha256, `wheels[${index}].sha256`, /^[a-f0-9]{64}$/iu).toLowerCase(),
    }
  })
  const packages = record(root.packages, 'packages')
  const model = record(root.model, 'model')
  const resources = record(root.resources, 'resources')
  const manifest: QwenRuntimeManifest = {
    schemaVersion: 1,
    platform: QWEN_RUNTIME_PLATFORM,
    python: QWEN_PYTHON_VERSION,
    requirements: {
      file: stringValue(requirements.file, 'requirements.file'),
      sha256: stringValue(requirements.sha256, 'requirements.sha256', /^[a-f0-9]{64}$/iu).toLowerCase(),
    },
    wheels,
    packages: {
      qwenTts: stringValue(packages.qwenTts, 'packages.qwenTts') as typeof QWEN_QWEN_VERSION,
      torch: stringValue(packages.torch, 'packages.torch') as typeof QWEN_TORCH_VERSION,
    },
    model: {
      id: stringValue(model.id, 'model.id') as typeof QWEN_MODEL_ID,
      revision: stringValue(model.revision, 'model.revision', /^[a-f0-9]{40}$/iu) as typeof QWEN_MODEL_REVISION,
      source: stringValue(model.source, 'model.source'),
      manifestFile: stringValue(model.manifestFile, 'model.manifestFile') as typeof QWEN_MODEL_MANIFEST_NAME,
    },
    resources: {
      minFreeDiskBytes: positiveInteger(resources.minFreeDiskBytes, 'resources.minFreeDiskBytes') as typeof QWEN_MIN_FREE_DISK_BYTES,
      minFreeMemoryBytes: positiveInteger(resources.minFreeMemoryBytes, 'resources.minFreeMemoryBytes') as typeof QWEN_MIN_FREE_MEMORY_BYTES,
      setupTimeoutMs: positiveInteger(resources.setupTimeoutMs, 'resources.setupTimeoutMs') as typeof QWEN_SETUP_TIMEOUT_MS,
      generationTimeoutMs: positiveInteger(resources.generationTimeoutMs, 'resources.generationTimeoutMs') as typeof QWEN_GENERATION_TIMEOUT_MS,
    },
  }

  if (
    manifest.requirements.file !== 'requirements-qwen.txt'
    || manifest.packages.qwenTts !== QWEN_QWEN_VERSION
    || manifest.packages.torch !== QWEN_TORCH_VERSION
    || manifest.model.id !== QWEN_MODEL_ID
    || manifest.model.revision !== QWEN_MODEL_REVISION
    || manifest.model.manifestFile !== QWEN_MODEL_MANIFEST_NAME
    || manifest.resources.minFreeDiskBytes !== QWEN_MIN_FREE_DISK_BYTES
    || manifest.resources.minFreeMemoryBytes !== QWEN_MIN_FREE_MEMORY_BYTES
    || manifest.resources.setupTimeoutMs !== QWEN_SETUP_TIMEOUT_MS
    || manifest.resources.generationTimeoutMs !== QWEN_GENERATION_TIMEOUT_MS
  ) throw new Error('Qwen runtime manifest identity does not match the supported runtime contract.')

  const distributions = new Set<string>()
  for (const wheel of manifest.wheels) {
    const normalized = wheel.distribution.toLowerCase().replaceAll('_', '-')
    if (distributions.has(normalized)) throw new Error(`Qwen runtime manifest has duplicate wheel metadata for ${wheel.distribution}.`)
    distributions.add(normalized)
  }
  if (!distributions.has('qwen-tts') || !distributions.has('torch')) throw new Error('Qwen runtime manifest must hash qwen-tts and torch wheels.')
  return manifest
}

export function readQwenRuntimeManifest(manifestPath: string, requirementsPath: string): QwenRuntimeManifest {
  const manifest = validateQwenRuntimeManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const requirements = readFileSync(requirementsPath, 'utf8').replaceAll('\r\n', '\n')
  const requirementsSha256 = createHash('sha256').update(requirements, 'utf8').digest('hex')
  if (requirementsSha256 !== manifest.requirements.sha256) {
    throw new Error(`Qwen requirements hash mismatch: expected ${manifest.requirements.sha256}, got ${requirementsSha256}.`)
  }
  return manifest
}

export function validateQwenInstallReport(report: unknown, manifest: QwenRuntimeManifest): void {
  const root = record(report, 'install report')
  if (!Array.isArray(root.install)) throw new Error('Qwen pip install report has no install records.')
  const installed = root.install.map((value, index) => {
    const entry = record(value, `install[${index}]`)
    const metadata = record(entry.metadata, `install[${index}].metadata`)
    const downloadInfo = record(entry.download_info, `install[${index}].download_info`)
    const archiveInfo = record(downloadInfo.archive_info, `install[${index}].download_info.archive_info`)
    const hashes = record(archiveInfo.hashes, `install[${index}].download_info.archive_info.hashes`)
    return {
      distribution: typeof metadata.name === 'string' ? metadata.name.toLowerCase().replaceAll('_', '-') : '',
      version: typeof metadata.version === 'string' ? metadata.version : '',
      sha256: typeof hashes.sha256 === 'string' ? hashes.sha256.toLowerCase() : '',
    }
  })
  for (const wheel of manifest.wheels) {
    const expectedDistribution = wheel.distribution.toLowerCase().replaceAll('_', '-')
    const entry = installed.find((candidate) => candidate.distribution === expectedDistribution && candidate.version === wheel.version)
    if (!entry || entry.sha256 !== wheel.sha256) throw new Error(`Qwen wheel verification failed for ${wheel.distribution} ${wheel.version}.`)
  }
}

export type QwenResourcePreflight = {
  ok: boolean
  issues: string[]
  freeDiskBytes: number
  freeMemoryBytes: number
  gpuAvailable?: boolean
}

export function evaluateQwenResourcePreflight(input: {
  freeDiskBytes: number
  freeMemoryBytes: number
  gpuAvailable?: boolean
}): QwenResourcePreflight {
  const issues: string[] = []
  if (!Number.isFinite(input.freeDiskBytes) || input.freeDiskBytes < QWEN_MIN_FREE_DISK_BYTES) {
    issues.push(`at least ${Math.round(QWEN_MIN_FREE_DISK_BYTES / 1024 ** 3)} GB of free disk space is required`)
  }
  if (!Number.isFinite(input.freeMemoryBytes) || input.freeMemoryBytes < QWEN_MIN_FREE_MEMORY_BYTES) {
    issues.push(`at least ${Math.round(QWEN_MIN_FREE_MEMORY_BYTES / 1024 ** 3)} GB of available memory is required`)
  }
  return { ...input, ok: issues.length === 0, issues }
}
