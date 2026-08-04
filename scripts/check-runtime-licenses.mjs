import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXPECTED_LICENSES = [
  ['@breezystack/lamejs', 'LGPL-3.0'],
  ['@huggingface/transformers', 'Apache-2.0'],
  ['@mozilla/readability', 'Apache-2.0'],
  ['@piper-plus/g2p', 'MIT'],
  ['ephone', 'GPL-3.0-or-later'],
  ['electron-updater', 'MIT'],
  ['fflate', 'MIT'],
  ['kitten-tts-webgpu', 'MIT'],
  ['kokoro-js', 'Apache-2.0'],
  ['linkedom', 'ISC'],
  ['lucide-react', 'ISC'],
  ['onnxruntime-node', 'MIT'],
  ['onnxruntime-web', 'MIT'],
  ['pdfjs-dist', 'Apache-2.0'],
  ['piper-plus', 'MIT'],
  ['phonemizer', 'Apache-2.0'],
  ['react', 'MIT'],
  ['react-dom', 'MIT'],
  ['signalsmith-stretch', 'MIT'],
  ['sherpa-onnx-node', 'Apache-2.0'],
  ['sherpa-onnx-win-x64', 'Apache-2.0'],
]

export function findMissingRuntimeLicenses(packageJson, licenseEntries = EXPECTED_LICENSES) {
  const tableNames = new Set(licenseEntries.map(([name]) => name))
  return Object.keys(packageJson.dependencies ?? {}).filter((name) => !tableNames.has(name))
}

export function validateLicenseTable(packageJson, licenseEntries = EXPECTED_LICENSES) {
  const names = licenseEntries.map(([name]) => name)
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
  if (duplicates.length > 0) throw new Error(`Runtime license table contains duplicate packages: ${[...new Set(duplicates)].join(', ')}`)

  const missing = findMissingRuntimeLicenses(packageJson, licenseEntries)
  if (missing.length > 0) throw new Error(`Runtime license table is missing package.json dependencies: ${missing.join(', ')}`)
  return { runtimeDependencies: Object.keys(packageJson.dependencies ?? {}), tablePackages: names }
}

function packageJsonPath(name, root) {
  return join(root, 'node_modules', ...name.split('/'), 'package.json')
}

export function readLicenseRows(root = process.cwd(), licenseEntries = EXPECTED_LICENSES) {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  validateLicenseTable(packageJson, licenseEntries)
  return licenseEntries.map(([name, expected]) => {
    const pkg = JSON.parse(readFileSync(packageJsonPath(name, root), 'utf8'))
    return { name, expected, actual: pkg.license ?? 'UNDECLARED' }
  })
}

export function runLicenseCheck(root = process.cwd()) {
  const rows = readLicenseRows(root)
  const mismatches = rows.filter((row) => row.actual !== row.expected)
  for (const row of rows) {
    console.log(`${row.name}: ${row.actual}`)
  }

  if (mismatches.length > 0) {
    throw new Error(`Runtime license mismatch:\n${mismatches.map((row) => `- ${row.name}: expected ${row.expected}, got ${row.actual}`).join('\n')}`)
  }
  return rows
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    runLicenseCheck()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
