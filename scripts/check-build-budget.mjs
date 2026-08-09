import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = process.cwd()
const distDir = join(root, 'dist')
const budgetPath = join(root, 'scripts', 'performance-budget.json')
const reportPath = join(distDir, 'build-budget-report.json')

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`
}

async function measureFile(path) {
  const contents = await readFile(path)
  return {
    file: path.slice(distDir.length + 1).replaceAll('\\', '/'),
    rawBytes: contents.byteLength,
    gzipBytes: gzipSync(contents, { level: 9 }).byteLength,
  }
}

function sumFiles(files) {
  return files.reduce(
    (total, file) => ({
      rawBytes: total.rawBytes + file.rawBytes,
      gzipBytes: total.gzipBytes + file.gzipBytes,
    }),
    { rawBytes: 0, gzipBytes: 0 },
  )
}

function assertWithinBudget(name, actual, budget, failures) {
  if (actual.rawBytes > budget.maxRawBytes) {
    failures.push(`${name} raw ${formatBytes(actual.rawBytes)} exceeds ${formatBytes(budget.maxRawBytes)}`)
  }
  if (actual.gzipBytes > budget.maxGzipBytes) {
    failures.push(`${name} gzip ${formatBytes(actual.gzipBytes)} exceeds ${formatBytes(budget.maxGzipBytes)}`)
  }
}

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('dist/index.html is missing. Run this check after vite build.')
  process.exit(1)
}

const budget = JSON.parse(await readFile(budgetPath, 'utf8'))
if (budget.schemaVersion !== 1) throw new Error(`Unsupported performance budget schema: ${budget.schemaVersion}`)

const indexHtml = await readFile(join(distDir, 'index.html'), 'utf8')
const referencedAssets = new Set(['index.html'])
for (const match of indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const value = match[1]
  if (value.startsWith('http') || value.startsWith('data:') || value.startsWith('#')) continue
  const relative = value.replace(/^\.?\//, '').replace(/^BetterTTS\//, '')
  if (/\.(?:css|js|mjs)$/.test(relative)) referencedAssets.add(relative)
}
const shellFiles = await Promise.all([...referencedAssets].map((file) => measureFile(join(distDir, file))))
const shell = { ...sumFiles(shellFiles), files: shellFiles }

const assetNames = await readdir(join(distDir, 'assets'))
const measuredAssets = await Promise.all(
  assetNames
    .filter((name) => /\.(?:css|js|mjs|wasm)$/.test(name))
    .map((name) => measureFile(join(distDir, 'assets', name))),
)

const failures = []
assertWithinBudget('initial shell', shell, budget.shell, failures)
const shellPatterns = budget.shell.forbiddenInitialAssetPatterns ?? []
const forbiddenInitialAssets = shellFiles.filter((asset) => shellPatterns.some((pattern) => asset.file.toLowerCase().includes(String(pattern).toLowerCase())))
if (forbiddenInitialAssets.length > 0) {
  failures.push(`initial shell contains forbidden lazy assets: ${forbiddenInitialAssets.map((asset) => asset.file).join(', ')}`)
}
if (Number.isFinite(budget.shell.maxInitialRequests) && shellFiles.length > budget.shell.maxInitialRequests) {
  failures.push(`initial shell requests ${shellFiles.length} assets, exceeding ${budget.shell.maxInitialRequests}`)
}

const assetOwnershipBudget = budget.assetOwnership ?? {}
for (const asset of measuredAssets) {
  if (asset.rawBytes > assetOwnershipBudget.maxAssetRawBytes) {
    failures.push(`${asset.file} raw ${formatBytes(asset.rawBytes)} exceeds per-asset ${formatBytes(assetOwnershipBudget.maxAssetRawBytes)}`)
  }
  if (asset.gzipBytes > assetOwnershipBudget.maxAssetGzipBytes) {
    failures.push(`${asset.file} gzip ${formatBytes(asset.gzipBytes)} exceeds per-asset ${formatBytes(assetOwnershipBudget.maxAssetGzipBytes)}`)
  }
}
const ownership = {}
const ownedFiles = new Set()
for (const owner of assetOwnershipBudget.patterns ?? []) {
  const files = measuredAssets.filter((asset) => owner.patterns.some((pattern) => basename(asset.file).includes(pattern)))
  ownership[owner.name] = { ...sumFiles(files), files }
  for (const file of files) ownedFiles.add(file.file)
}
const unownedFiles = measuredAssets.filter((asset) => !ownedFiles.has(asset.file))
const unowned = sumFiles(unownedFiles)
if (unowned.rawBytes > (assetOwnershipBudget.maxUnownedRawBytes ?? 0)) {
  failures.push(`unowned lazy assets raw ${formatBytes(unowned.rawBytes)} exceeds ${formatBytes(assetOwnershipBudget.maxUnownedRawBytes)}`)
}
if (unowned.gzipBytes > (assetOwnershipBudget.maxUnownedGzipBytes ?? 0)) {
  failures.push(`unowned lazy assets gzip ${formatBytes(unowned.gzipBytes)} exceeds ${formatBytes(assetOwnershipBudget.maxUnownedGzipBytes)}`)
}

const lazyBoundaries = {}
for (const [name, boundary] of Object.entries(budget.lazyBoundaries)) {
  const files = measuredAssets.filter((asset) => boundary.patterns.some((pattern) => basename(asset.file).includes(pattern)))
  if (files.length === 0) {
    failures.push(`${name} lazy boundary did not produce a distinct asset`)
    continue
  }
  const totals = sumFiles(files)
  lazyBoundaries[name] = { ...totals, files }
  assertWithinBudget(name, totals, boundary, failures)
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  shell,
  ownership: { ...unowned, files: unownedFiles, boundaries: ownership },
  lazyBoundaries,
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

console.log(`Initial shell: ${formatBytes(shell.rawBytes)} raw / ${formatBytes(shell.gzipBytes)} gzip`)
for (const [name, result] of Object.entries(lazyBoundaries)) {
  console.log(`${name}: ${formatBytes(result.rawBytes)} raw / ${formatBytes(result.gzipBytes)} gzip`)
}
if (failures.length > 0) {
  console.error(`Build budget failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('Build budget passed.')
