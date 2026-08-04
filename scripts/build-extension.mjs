import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

export const EXTENSION_FILES = ['manifest.json', 'background.js', 'icon-192.png', 'icon-512.png']

export function buildExtensionArchive(root = process.cwd(), outputPath = join(root, 'dist', 'bettertts-extension.zip')) {
  const extensionRoot = join(root, 'extension')
  const entries = Object.fromEntries(EXTENSION_FILES.map((name) => [
    name,
    new Uint8Array(readFileSync(join(extensionRoot, name))),
  ]))
  const archive = zipSync(entries, { level: 6 })
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, archive)
  return resolve(outputPath)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const outputPath = buildExtensionArchive()
  console.log(`Built ${outputPath}`)
}
