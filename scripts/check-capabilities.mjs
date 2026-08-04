import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLicenseCheck } from './check-runtime-licenses.mjs'

export const CAPABILITIES_SCHEMA_VERSION = 1

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TEST_ROOTS = ['src', 'electron', 'scripts']
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|mjs|js)$/u
const SUPPORTED_PLATFORMS = new Set(['web', 'windows', 'macos', 'linux'])
const RUNTIMES = new Set(['browser', 'native', 'sidecar'])
const AUDIO_FORMATS = new Set(['wav', 'mp3', 'opus', 'flac', 'm4b'])
const LICENSE_TIERS = new Set(['permissive', 'restricted', 'non-commercial'])

export function readCapabilities(root = REPO_ROOT) {
  const path = join(root, 'capabilities.json')
  if (!existsSync(path)) throw new Error('capabilities.json is missing.')
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function validateCapabilities(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Capability manifest must be an object.')
  if (manifest.schemaVersion !== CAPABILITIES_SCHEMA_VERSION) throw new Error(`Unsupported capability manifest schema: ${String(manifest.schemaVersion)}.`)
  if (manifest.app?.name !== 'BetterTTS' || typeof manifest.app?.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.app.version)) {
    throw new Error('Capability manifest app metadata is invalid.')
  }
  if (!Array.isArray(manifest.app.supportedPlatforms) || manifest.app.supportedPlatforms.length === 0 || manifest.app.supportedPlatforms.some((platform) => !SUPPORTED_PLATFORMS.has(platform))) {
    throw new Error('Capability manifest supported platforms are invalid.')
  }
  if (!Number.isSafeInteger(manifest.testMetrics?.testFiles) || manifest.testMetrics.testFiles <= 0 || !Number.isSafeInteger(manifest.testMetrics?.tests) || manifest.testMetrics.tests <= 0) {
    throw new Error('Capability manifest test metrics are invalid.')
  }
  if (!Array.isArray(manifest.engines) || manifest.engines.length === 0) throw new Error('Capability manifest must declare at least one engine.')

  const engineIds = new Set()
  const modelIds = new Set((manifest.models ?? []).map((model) => model?.id))
  for (const engine of manifest.engines) {
    if (!engine || typeof engine.id !== 'string' || engineIds.has(engine.id)) throw new Error(`Capability manifest has a duplicate or invalid engine id: ${String(engine?.id)}.`)
    engineIds.add(engine.id)
    if (typeof engine.label !== 'string' || !Array.isArray(engine.platforms) || engine.platforms.length === 0 || engine.platforms.some((platform) => !SUPPORTED_PLATFORMS.has(platform))) {
      throw new Error(`Capability manifest engine ${engine.id} has invalid platform metadata.`)
    }
    if (!Array.isArray(engine.runtime) || engine.runtime.length === 0 || engine.runtime.some((runtime) => !RUNTIMES.has(runtime))) {
      throw new Error(`Capability manifest engine ${engine.id} has invalid runtime metadata.`)
    }
    if (!Array.isArray(engine.exportFormats) || engine.exportFormats.some((format) => !AUDIO_FORMATS.has(format))) {
      throw new Error(`Capability manifest engine ${engine.id} has invalid export metadata.`)
    }
    if (!Array.isArray(engine.modelLicenseIds) || engine.modelLicenseIds.length === 0 || engine.modelLicenseIds.some((id) => !modelIds.has(id))) {
      throw new Error(`Capability manifest engine ${engine.id} references an unknown model license record.`)
    }
  }

  const queueEngines = manifest.engines.filter((engine) => engine.queueable).map((engine) => engine.id).sort()
  const declaredQueueEngines = [...(manifest.queue?.engines ?? [])].sort()
  if (JSON.stringify(queueEngines) !== JSON.stringify(declaredQueueEngines)) throw new Error('Capability manifest queue engines do not match engine queueable flags.')
  if (!manifest.queue?.resumable) throw new Error('Capability manifest must declare the persistent queue as resumable.')
  if (!manifest.exports || !Array.isArray(manifest.exports.audioFormats) || manifest.exports.audioFormats.some((format) => !AUDIO_FORMATS.has(format))) {
    throw new Error('Capability manifest export formats are invalid.')
  }

  const runtimePackages = manifest.runtimeLicenses?.packages
  if (!Array.isArray(runtimePackages) || runtimePackages.length === 0) throw new Error('Capability manifest runtime license package table is missing.')
  const packageNames = runtimePackages.map((entry) => entry?.name)
  if (packageNames.some((name) => typeof name !== 'string' || name.length === 0) || new Set(packageNames).size !== packageNames.length) {
    throw new Error('Capability manifest runtime license package names must be unique.')
  }
  for (const model of manifest.models ?? []) {
    if (!model || typeof model.id !== 'string' || !model.license || typeof model.license.spdx !== 'string' || !LICENSE_TIERS.has(model.license.tier)) {
      throw new Error(`Capability manifest model license record is invalid: ${String(model?.id)}.`)
    }
  }
  return manifest
}

export function discoverTestFiles(root = REPO_ROOT) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (TEST_FILE_PATTERN.test(entry.name)) files.push(path)
    }
  }
  for (const directory of TEST_ROOTS.map((name) => join(root, name))) {
    if (existsSync(directory)) visit(directory)
  }
  return files.sort()
}

export function collectTestMetrics(root = REPO_ROOT) {
  const vitestEntry = join(root, 'node_modules', 'vitest', 'vitest.mjs')
  const output = execFileSync(process.execPath, [vitestEntry, 'run', '--reporter=json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  })
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Vitest JSON reporter did not return a summary.')
  const report = JSON.parse(output.slice(start, end + 1))
  if (!report.success || !Number.isSafeInteger(report.numTotalTests)) throw new Error('Vitest reported a failed or invalid test run.')
  return { testFiles: discoverTestFiles(root).length, tests: report.numTotalTests }
}

export function formatCapabilityFacts(manifest) {
  const engineLabels = manifest.engines.map((engine) => `${engine.label}${engine.experimental ? ' (experimental)' : ''}`).join(', ')
  const queueLabels = manifest.queue.engines.map((id) => manifest.engines.find((engine) => engine.id === id)?.label ?? id).join(', ')
  const audioFormats = manifest.exports.audioFormats.map((format) => format.toUpperCase()).join(', ')
  const captionFormats = manifest.exports.captionFormats.map((format) => format.toUpperCase()).join(', ')
  const modelLicenses = manifest.models.map((model) => `${model.label} (${model.license.spdx})`).join('; ')
  return [
    '<!-- BEGIN BETTERTTS CAPABILITIES -->',
    `- **Application:** ${manifest.app.name} v${manifest.app.version} · ${manifest.app.supportedPlatforms.map((platform) => `${platform[0].toUpperCase()}${platform.slice(1)}`).join(' + ')}`,
    `- **Engines:** ${engineLabels}`,
    `- **Queue:** resumable jobs for ${queueLabels}`,
    `- **Exports:** ${audioFormats} audio · ${captionFormats} captions`,
    `- **Tests:** ${manifest.testMetrics.tests} tests across ${manifest.testMetrics.testFiles} test files`,
    `- **Runtime licenses:** ${manifest.runtimeLicenses.packages.length} direct package rows validated by \`npm run license:runtime\``,
    `- **Model licenses:** ${modelLicenses}`,
    '<!-- END BETTERTTS CAPABILITIES -->',
  ].join('\n')
}

export function formatCoreModule(manifest) {
  return [
    "import type { CapabilityEngine } from './capabilities.ts'",
    '',
    `export const APP_VERSION = ${JSON.stringify(manifest.app.version)}`,
    `export const CORE_ENGINES: readonly CapabilityEngine[] = ${JSON.stringify(manifest.engines, null, 2)}`,
    '',
  ].join('\n')
}

function replaceGeneratedBlock(text, block, label) {
  const pattern = /<!-- BEGIN BETTERTTS CAPABILITIES -->[\s\S]*?<!-- END BETTERTTS CAPABILITIES -->/u
  if (!pattern.test(text)) throw new Error(`${label} is missing the generated capability block.`)
  return text.replace(pattern, block)
}

function updateDocumentation(root, manifest, { write = true } = {}) {
  const block = formatCapabilityFacts(manifest)
  const readmePath = join(root, 'README.md')
  const readme = readFileSync(readmePath, 'utf8')
  const nextReadme = replaceGeneratedBlock(readme, block, 'README.md')
    .replace(/(shields\.io\/badge\/version-)[^-]+(-blue\.svg)/u, `$1${manifest.app.version}$2`)
    .replace(/(shields\.io\/badge\/tests-)[^-]+(-53d889\.svg)/u, `$1${manifest.testMetrics.tests}%20passing$2`)
    .replace(/\| Testing \|[^\r\n]*/u, `| Testing | Vitest (${manifest.testMetrics.tests} tests across ${manifest.testMetrics.testFiles} files) + Playwright smoke + EPUBCheck |`)
  if (write && nextReadme !== readme) writeFileSync(readmePath, nextReadme)

  const claudePath = join(root, 'CLAUDE.md')
  if (!existsSync(claudePath)) return { readmeChanged: nextReadme !== readme, claudeChanged: false }
  const claude = readFileSync(claudePath, 'utf8')
  const nextClaude = replaceGeneratedBlock(claude, block, 'CLAUDE.md')
    .replace(/(\*\*Version:\*\* v)[^\s]+/u, `$1${manifest.app.version}`)
    .replace(/Vitest \([^)]*tests \/ [^)]*files/u, `Vitest (${manifest.testMetrics.tests} tests / ${manifest.testMetrics.testFiles} files`)
  if (write && nextClaude !== claude) writeFileSync(claudePath, nextClaude)
  return { readmeChanged: nextReadme !== readme, claudeChanged: existsSync(claudePath) && nextClaude !== claude }
}

function writeCapabilities(root, manifest) {
  writeFileSync(join(root, 'capabilities.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function synchronizeCoreModule(root, manifest, { write = true } = {}) {
  const path = join(root, 'src', 'lib', 'capabilities-core.ts')
  const expected = formatCoreModule(manifest)
  const actual = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (write) {
    if (actual !== expected) writeFileSync(path, expected)
    return false
  }
  if (actual !== expected) throw new Error('Generated capability core is stale. Run npm run capabilities:update.')
  return true
}

export function checkCapabilities(root = REPO_ROOT, { write = false } = {}) {
  let manifest = validateCapabilities(readCapabilities(root))
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (packageJson.version !== manifest.app.version) throw new Error(`package.json version ${packageJson.version} does not match capabilities.json ${manifest.app.version}.`)
  runLicenseCheck(root)

  if (write) {
    synchronizeCoreModule(root, manifest)
    const metrics = collectTestMetrics(root)
    manifest = { ...manifest, testMetrics: metrics }
    validateCapabilities(manifest)
    writeCapabilities(root, manifest)
    synchronizeCoreModule(root, manifest)
    updateDocumentation(root, manifest)
    return { manifest, metrics, wrote: true }
  }

  synchronizeCoreModule(root, manifest, { write: false })
  const metrics = collectTestMetrics(root)
  if (manifest.testMetrics.testFiles !== metrics.testFiles || manifest.testMetrics.tests !== metrics.tests) {
    throw new Error(`capabilities.json test metrics are stale: declared ${manifest.testMetrics.tests}/${manifest.testMetrics.testFiles}, actual ${metrics.tests}/${metrics.testFiles}. Run npm run capabilities:update.`)
  }
  const documentation = updateDocumentation(root, manifest, { write: false })
  if (documentation.readmeChanged || documentation.claudeChanged) throw new Error('Generated capability documentation is stale. Run npm run capabilities:update.')
  return { manifest, metrics, wrote: false }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    checkCapabilities(REPO_ROOT, { write: process.argv.includes('--write') })
    console.log('Capability manifest, documentation, runtime licenses, and test metrics are synchronized.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
