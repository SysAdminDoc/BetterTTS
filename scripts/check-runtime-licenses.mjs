import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const expectedLicenses = [
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
  ['onnxruntime-web', 'MIT'],
  ['pdfjs-dist', 'Apache-2.0'],
  ['piper-plus', 'MIT'],
  ['phonemizer', 'Apache-2.0'],
  ['signalsmith-stretch', 'MIT'],
  ['sherpa-onnx-node', 'Apache-2.0'],
  ['sherpa-onnx-win-x64', 'Apache-2.0'],
]

function packageJsonPath(name) {
  return join(process.cwd(), 'node_modules', ...name.split('/'), 'package.json')
}

const rows = expectedLicenses.map(([name, expected]) => {
  const pkg = JSON.parse(readFileSync(packageJsonPath(name), 'utf8'))
  return { name, expected, actual: pkg.license ?? 'UNDECLARED' }
})

const mismatches = rows.filter((row) => row.actual !== row.expected)
for (const row of rows) {
  console.log(`${row.name}: ${row.actual}`)
}

if (mismatches.length > 0) {
  console.error('Runtime license mismatch:')
  for (const row of mismatches) {
    console.error(`- ${row.name}: expected ${row.expected}, got ${row.actual}`)
  }
  process.exit(1)
}
