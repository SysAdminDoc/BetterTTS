#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import modelAssets from '../src/lib/model-assets.json' with { type: 'json' }
import { KOKORO_Q8_PACK } from '../electron/native-models.ts'
import { SHERPA_KOKORO_PACK, SHERPA_MELO_PACK, SHERPA_PIPER_PACK } from '../electron/sherpa-models.ts'
import { readLicenseRows } from './check-runtime-licenses.mjs'

export const CYCLONEDX_SPEC_VERSION = '1.7'
export const SBOM_FILE_NAME = 'bettertts-sbom.cdx.json'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SHA256_RE = /^[a-f0-9]{64}$/iu
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
const SPDX_IDS = new Set([
  'Apache-2.0',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-3.0',
  'MIT',
])

export function buildSbom(root = REPO_ROOT) {
  const packageJson = readJson(join(root, 'package.json'))
  const capabilities = readJson(join(root, 'capabilities.json'))
  if (capabilities?.app?.name !== 'BetterTTS') throw new Error('capabilities.json is not a BetterTTS manifest.')
  if (packageJson.version !== capabilities.app.version) {
    throw new Error(`SBOM package version ${packageJson.version} does not match capabilities ${capabilities.app.version}.`)
  }

  const licenseRows = readLicenseRows(root)
  const runtimeRows = readProductionRuntimeRows(root, licenseRows)
  const runtimeComponents = runtimeRows.map((row) => buildRuntimeComponent(row))
  const modelSources = buildModelSources(capabilities)
  const modelComponents = capabilities.models.map((model) => buildModelComponent(model, modelSources))
  const modelFileComponents = modelSources.flatMap((source) => source.files.map((file) => buildModelFileComponent(source, file, capabilities)))
  const application = {
    type: 'application',
    'bom-ref': 'application:bettertts',
    name: 'BetterTTS',
    version: packageJson.version,
    description: packageJson.description,
    licenses: [licenseValue('MIT')],
    purl: npmPurl(packageJson.name, packageJson.version),
  }
  const components = [application, ...runtimeComponents, ...modelComponents, ...modelFileComponents]
  const runtimeRefs = runtimeComponents.map((component) => component['bom-ref'])
  const modelRefs = [...modelComponents, ...modelFileComponents].map((component) => component['bom-ref'])
  const bom = {
    $schema: 'https://cyclonedx.org/schema/bom-1.7.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: CYCLONEDX_SPEC_VERSION,
    serialNumber: deterministicSerialNumber(packageJson.version),
    version: 1,
    metadata: {
      timestamp: undefined,
      tools: [{ vendor: 'SysAdminDoc', name: 'BetterTTS SBOM generator', version: packageJson.version }],
      component: {
        type: 'application',
        name: 'BetterTTS',
        version: packageJson.version,
        purl: npmPurl(packageJson.name, packageJson.version),
      },
      properties: [
        property('bettertts:sbom-purpose', 'release-runtime-and-model-inventory'),
        property('bettertts:runtime-package-count', String(runtimeComponents.length)),
        property('bettertts:model-component-count', String(modelComponents.length)),
        property('bettertts:model-file-count', String(modelFileComponents.length)),
      ],
    },
    components,
    dependencies: [{ ref: application['bom-ref'], dependsOn: [...runtimeRefs, ...modelRefs] }],
  }
  delete bom.metadata.timestamp
  validateSbom(bom, { root, capabilities })
  return bom
}

export function validateSbom(bom, { root = REPO_ROOT, capabilities = readJson(join(root, 'capabilities.json')) } = {}) {
  if (!bom || typeof bom !== 'object' || Array.isArray(bom)) throw new Error('CycloneDX SBOM must be a JSON object.')
  if (bom.bomFormat !== 'CycloneDX' || bom.specVersion !== CYCLONEDX_SPEC_VERSION || bom.version !== 1) {
    throw new Error(`CycloneDX SBOM must use format CycloneDX ${CYCLONEDX_SPEC_VERSION}, version 1.`)
  }
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(bom.serialNumber ?? '')) {
    throw new Error('CycloneDX SBOM serialNumber must be a UUID URN.')
  }
  if (!Array.isArray(bom.components) || bom.components.length === 0) throw new Error('CycloneDX SBOM has no components.')
  if (!bom.metadata?.component || bom.metadata.component.name !== 'BetterTTS') throw new Error('CycloneDX SBOM metadata subject is missing BetterTTS.')

  const refs = new Set()
  for (const component of bom.components) {
    if (!component || typeof component !== 'object' || typeof component['bom-ref'] !== 'string' || refs.has(component['bom-ref'])) {
      throw new Error('CycloneDX SBOM components must have unique bom-ref values.')
    }
    refs.add(component['bom-ref'])
    if (typeof component.type !== 'string' || typeof component.name !== 'string' || typeof component.version !== 'string') {
      throw new Error(`CycloneDX SBOM component ${String(component['bom-ref'])} has incomplete identity metadata.`)
    }
  }

  const expectedRuntimeRows = readProductionRuntimeRows(root, readLicenseRows(root))
  const expectedRuntimeKeys = new Set(expectedRuntimeRows.map((row) => `${row.name}@${row.version}`))
  const actualRuntimeKeys = new Set(
    bom.components
      .filter((component) => component.type === 'library')
      .flatMap((component) => propertyValues(component, 'bettertts:runtime-package-key')),
  )
  assertExactSet(actualRuntimeKeys, expectedRuntimeKeys, 'runtime package')
  const directRuntimeNames = new Set(
    bom.components
      .filter((component) => component.type === 'library')
      .filter((component) => propertyValues(component, 'bettertts:runtime-direct')[0] === 'true')
      .map((component) => component.name),
  )
  assertExactSet(directRuntimeNames, new Set(expectedRuntimeRows.filter((row) => row.direct).map((row) => row.name)), 'direct runtime package')

  const modelIds = new Set(
    bom.components
      .filter((component) => component.type === 'machine-learning-model')
      .flatMap((component) => propertyValues(component, 'bettertts:capability-id')),
  )
  const expectedModelIds = new Set((capabilities.models ?? []).map((model) => model.id))
  assertExactSet(modelIds, expectedModelIds, 'model')

  const expectedSources = buildModelSources(capabilities)
  const expectedFileKeys = new Set(expectedSources.flatMap((source) => source.files.map((file) => artifactKey(source, file))))
  const fileComponents = bom.components.filter((component) => component.type === 'file')
  const fileKeys = new Set()
  for (const component of fileComponents) {
    const key = propertyValues(component, 'bettertts:artifact-key')[0]
    if (!key || fileKeys.has(key)) throw new Error('CycloneDX SBOM model files must have unique artifact keys.')
    fileKeys.add(key)
    if (!expectedFileKeys.has(key)) throw new Error(`CycloneDX SBOM contains an unexpected model file: ${key}`)
    const modelId = propertyValues(component, 'bettertts:model-id')[0]
    const revision = propertyValues(component, 'bettertts:revision')[0]
    const repository = propertyValues(component, 'bettertts:repository')[0]
    const route = propertyValues(component, 'bettertts:distribution-route')[0]
    const hash = component.hashes?.find((entry) => entry.alg === 'SHA-256')?.content
    if (!modelId || !revision || !repository || !route || !SHA256_RE.test(hash ?? '')) {
      throw new Error(`CycloneDX SBOM model file ${key} is missing repository, revision, route, or SHA-256 metadata.`)
    }
    if (!Array.isArray(component.licenses) || component.licenses.length === 0) {
      throw new Error(`CycloneDX SBOM model file ${key} is missing license metadata.`)
    }
  }
  assertExactSet(fileKeys, expectedFileKeys, 'model file')

  const dependencyRefs = new Set(bom.dependencies?.flatMap((dependency) => [dependency.ref, ...(dependency.dependsOn ?? [])]) ?? [])
  for (const ref of dependencyRefs) if (!refs.has(ref)) throw new Error(`CycloneDX SBOM dependency references missing component ${ref}.`)
  return bom
}

export function writeSbom(outputPath, root = REPO_ROOT) {
  const bom = buildSbom(root)
  mkdirSync(resolve(outputPath, '..'), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(bom, null, 2)}\n`)
  return bom
}

export function readSbom(inputPath, options = {}) {
  const bom = JSON.parse(readFileSync(inputPath, 'utf8'))
  return validateSbom(bom, options)
}

function buildRuntimeComponent(row) {
  const component = {
    type: 'library',
    'bom-ref': `npm:${row.name}@${row.version}`,
    name: row.name,
    version: row.version,
    scope: 'required',
    licenses: [licenseValue(row.license)],
    purl: npmPurl(row.name, row.version),
    properties: [
      property('bettertts:runtime-package', row.name),
      property('bettertts:runtime-package-key', `${row.name}@${row.version}`),
      property('bettertts:runtime-direct', row.direct),
      property('bettertts:license', row.license),
      property('bettertts:license-actual', row.actual),
      property('bettertts:distribution-route', 'npm-runtime'),
    ],
  }
  return component
}

function readProductionRuntimeRows(root, directRows) {
  const lock = readJson(join(root, 'package-lock.json'))
  const directByName = new Map(directRows.map((row) => [row.name, row]))
  const rows = new Map()
  for (const [packagePath, lockEntry] of Object.entries(lock.packages ?? {})) {
    if (!packagePath.startsWith('node_modules/') || lockEntry?.dev === true || lockEntry?.devOptional === true) continue
    const packageJsonPath = join(root, packagePath, 'package.json')
    if (!existsSync(packageJsonPath)) {
      if (lockEntry?.optional === true) continue
      throw new Error(`Production package manifest is missing: ${packageJsonPath}`)
    }
    const packageJson = readJson(packageJsonPath)
    const name = packageJson.name
    const version = packageJson.version
    if (typeof name !== 'string' || typeof version !== 'string' || !VERSION_RE.test(version)) {
      throw new Error(`Production package manifest has invalid identity: ${packageJsonPath}`)
    }
    const direct = directByName.get(name)
    const actual = normalizePackageLicense(packageJson.license)
    const key = `${name}@${version}`
    if (!rows.has(key)) {
      rows.set(key, {
        name,
        version,
        direct: Boolean(direct),
        expected: direct?.expected ?? actual,
        actual,
        license: direct?.expected ?? actual,
      })
    }
  }
  for (const direct of directRows) {
    if (![...rows.values()].some((row) => row.name === direct.name)) {
      throw new Error(`Direct runtime package is not present in the production lock inventory: ${direct.name}`)
    }
  }
  return [...rows.values()]
}

function normalizePackageLicense(value) {
  if (typeof value === 'string' && value.length > 0) return value
  if (value && typeof value === 'object' && typeof value.type === 'string' && value.type.length > 0) return value.type
  return 'UNDECLARED'
}

function buildModelComponent(model, sources) {
  const relatedSources = sources.filter((source) => source.capabilityIds.includes(model.id))
  const revisions = [...new Set(relatedSources.map((source) => source.revision))]
  const revision = revisions[0] ?? defaultRevision(model)
  const route = relatedSources.length > 0 ? [...new Set(relatedSources.map((source) => source.distributionRoute))].join(',') : defaultRoute(model)
  const component = {
    type: 'machine-learning-model',
    'bom-ref': `model:${model.id}`,
    name: model.modelId,
    version: revision,
    description: model.usedFor,
    licenses: [licenseValue(model.license.spdx)],
    properties: [
      property('bettertts:capability-id', model.id),
      property('bettertts:model-id', model.modelId),
      property('bettertts:repository', modelRepositoryUrl(model.modelId)),
      property('bettertts:revision', revision),
      property('bettertts:distribution-route', route),
      property('bettertts:license-tier', model.license.tier),
      property('bettertts:execution-payload', executionPayload(model)),
    ],
  }
  if (model.modelId.includes('/')) {
    component.purl = huggingFacePurl(model.modelId, revision)
    component.externalReferences = [{ type: 'distribution', url: modelRepositoryUrl(model.modelId) }]
  }
  return component
}

function buildModelFileComponent(source, file, capabilities) {
  const model = capabilities.models.find((candidate) => source.capabilityIds.includes(candidate.id))
  if (!model) throw new Error(`SBOM model source ${source.modelId} has no capability license record.`)
  const key = artifactKey(source, file)
  return {
    type: 'file',
    'bom-ref': `model-file:${hashShort(key)}`,
    name: file.path,
    version: source.revision,
    scope: 'optional',
    hashes: [{ alg: 'SHA-256', content: file.sha256 }],
    licenses: [licenseValue(model.license.spdx)],
    mimeType: mimeTypeFor(file.path),
    externalReferences: [{ type: 'distribution', url: file.sourceUrl }],
    properties: [
      property('bettertts:artifact-key', key),
      property('bettertts:capability-id', source.capabilityIds.join(',')),
      property('bettertts:model-id', source.modelId),
      property('bettertts:repository', source.repository),
      property('bettertts:revision', source.revision),
      property('bettertts:sha256', file.sha256),
      property('bettertts:expected-size', String(file.size)),
      property('bettertts:distribution-route', source.distributionRoute),
      property('bettertts:execution-runtime', source.runtime),
      property('bettertts:engine', source.engine),
      property('bettertts:artifact-path', file.artifactPath),
    ],
  }
}

function buildModelSources(capabilities) {
  const source = (input) => ({ ...input, capabilityIds: input.capabilityIds.filter((id) => capabilities.models.some((model) => model.id === id)) })
  const kokoro = modelAssets.kokoro
  const piper = modelAssets.piper
  const hfFile = (modelId, revision, asset, artifactPath) => ({
    path: asset.path,
    artifactPath,
    size: asset.size,
    sha256: asset.sha256,
    sourceUrl: `https://huggingface.co/${modelId}/resolve/${revision}/${asset.path}`,
  })
  const pageKokoroFiles = [
    ...kokoro.remoteAssets.map((asset) => hfFile(kokoro.modelId, kokoro.revision, asset, `models/${kokoro.modelId}/${asset.path}`)),
    ...kokoro.voiceAssets.map((asset) => hfFile(kokoro.modelId, kokoro.revision, asset, `models/${kokoro.modelId}/${asset.path}`)),
  ]
  const pagePiperFiles = [
    hfFile(piper.modelId, piper.revision, piper.onnx, `models/${piper.modelId}/${piper.onnx.path}`),
    hfFile(piper.modelId, piper.revision, piper.config, `models/${piper.modelId}/${piper.config.path}`),
    { ...hfFile(piper.modelId, piper.revision, piper.config, `models/${piper.modelId}/${piper.onnx.path}.json`), path: `${piper.onnx.path}.json` },
  ]
  const nativeKokoroFiles = KOKORO_Q8_PACK.files.map((file) => ({
    path: file.path,
    artifactPath: `desktop-model-cache/${KOKORO_Q8_PACK.id}@${KOKORO_Q8_PACK.revision.slice(0, 12)}/${file.path}`,
    size: file.size,
    sha256: file.sha256,
    sourceUrl: `https://huggingface.co/${KOKORO_Q8_PACK.modelId}/resolve/${KOKORO_Q8_PACK.revision}/${file.path}`,
  }))
  const archiveSource = (pack, capabilityIds) => source({
    capabilityIds,
    modelId: pack.modelId,
    revision: pack.revision,
    repository: pack.license.url,
    distributionRoute: 'windows-native-sherpa-cache',
    runtime: 'sherpa-onnx-node',
    engine: pack.engine,
    files: [{
      path: pack.archive.fileName,
      artifactPath: `desktop-model-cache/${pack.id}@${pack.revision.slice(0, 12)}/${pack.archive.fileName}`,
      size: pack.archive.size,
      sha256: pack.archive.sha256,
      sourceUrl: pack.archive.url,
    }],
  })
  return [
    source({
      capabilityIds: ['kokoro-82m'],
      modelId: kokoro.modelId,
      revision: kokoro.revision,
      repository: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX',
      distributionRoute: 'github-pages-model-cache',
      runtime: 'browser',
      engine: 'kokoro',
      files: pageKokoroFiles,
    }),
    source({
      capabilityIds: ['piper-plus'],
      modelId: piper.modelId,
      revision: piper.revision,
      repository: 'https://huggingface.co/ayousanz/piper-plus-tsukuyomi-chan',
      distributionRoute: 'github-pages-model-cache',
      runtime: 'browser',
      engine: 'piper',
      files: pagePiperFiles,
    }),
    source({
      capabilityIds: ['kokoro-82m'],
      modelId: KOKORO_Q8_PACK.modelId,
      revision: KOKORO_Q8_PACK.revision,
      repository: KOKORO_Q8_PACK.license.url,
      distributionRoute: 'windows-native-onnx-cache',
      runtime: KOKORO_Q8_PACK.runtime,
      engine: 'kokoro',
      files: nativeKokoroFiles,
    }),
    archiveSource(SHERPA_KOKORO_PACK, ['sherpa-kokoro']),
    archiveSource(SHERPA_PIPER_PACK, ['sherpa-piper']),
    archiveSource(SHERPA_MELO_PACK, ['melo', 'sherpa-melo']),
  ]
}

function artifactKey(source, file) {
  return [source.distributionRoute, source.modelId, source.revision, file.path].join('|')
}

function property(name, value) {
  return { name, value: String(value) }
}

function propertyValues(component, name) {
  return (component.properties ?? []).filter((entry) => entry?.name === name).map((entry) => String(entry.value))
}

function licenseValue(spdx) {
  return SPDX_IDS.has(spdx) ? { license: { id: spdx } } : { license: { name: spdx } }
}

function npmPurl(name, version) {
  const normalized = name.startsWith('@') ? `%40${name.slice(1)}` : name
  return `pkg:npm/${normalized}@${encodeURIComponent(version)}`
}

function huggingFacePurl(modelId, revision) {
  return `pkg:huggingface/${modelId}@${encodeURIComponent(revision)}`
}

function modelRepositoryUrl(modelId) {
  return modelId.includes('/') ? `https://huggingface.co/${modelId}` : 'https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API'
}

function defaultRevision(model) {
  if (model.modelId === 'Web Speech API') return 'device-managed'
  if (model.id === 'qwen') return 'user-managed'
  return 'main (runtime-managed)'
}

function defaultRoute(model) {
  if (model.modelId === 'Web Speech API') return 'device-managed'
  if (model.id === 'qwen') return 'windows-user-managed-sidecar'
  return 'huggingface-on-demand'
}

function executionPayload(model) {
  if (model.id === 'qwen') return 'windows-python-sidecar'
  if (model.modelId === 'Web Speech API') return 'browser-device'
  if (model.id === 'melo' || model.id.startsWith('sherpa-')) return 'windows-native'
  return 'browser-web-runtime'
}

function mimeTypeFor(path) {
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.onnx')) return 'application/octet-stream'
  if (path.endsWith('.bin')) return 'application/octet-stream'
  if (path.endsWith('.bz2')) return 'application/x-bzip2'
  return 'text/plain'
}

function deterministicSerialNumber(version) {
  const digest = createHash('sha256').update(`BetterTTS:${version}`).digest('hex')
  return `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
}

function hashShort(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function assertExactSet(actual, expected, label) {
  const missing = [...expected].filter((value) => !actual.has(value))
  const extra = [...actual].filter((value) => !expected.has(value))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`CycloneDX SBOM ${label} inventory mismatch: missing [${missing.join(', ')}]; extra [${extra.join(', ')}].`)
  }
}

function readJson(path) {
  if (!existsSync(path)) throw new Error(`Required SBOM input is missing: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function parseOption(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const args = process.argv.slice(2)
    const validatePath = parseOption(args, '--validate')
      ?? (args.includes('--validate') ? join(REPO_ROOT, 'release', `BetterTTS-${readJson(join(REPO_ROOT, 'package.json')).version}.cdx.json`) : undefined)
    if (validatePath) {
      readSbom(resolve(validatePath))
      console.log(`Validated CycloneDX ${CYCLONEDX_SPEC_VERSION} SBOM: ${resolve(validatePath)}`)
    } else {
      const outputPath = parseOption(args, '--out')
        ?? (args.includes('--check') ? undefined : join(REPO_ROOT, 'release', `BetterTTS-${readJson(join(REPO_ROOT, 'package.json')).version}.cdx.json`))
      const bom = buildSbom()
      if (outputPath) {
        mkdirSync(resolve(outputPath, '..'), { recursive: true })
        writeFileSync(outputPath, `${JSON.stringify(bom, null, 2)}\n`)
        console.log(`Generated CycloneDX ${CYCLONEDX_SPEC_VERSION} SBOM with ${bom.components.length} components: ${resolve(outputPath)}`)
      } else {
        console.log(`Validated CycloneDX ${CYCLONEDX_SPEC_VERSION} SBOM inventory with ${bom.components.length} components.`)
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
