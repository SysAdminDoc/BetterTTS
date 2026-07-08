#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, copyFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const repoRoot = resolve(import.meta.dirname, '..')
const modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const hfResolveBase = `https://huggingface.co/${modelId}/resolve/main`
const pagesFileCap = 100 * 1000 * 1000
const pagesSiteCap = 1024 * 1024 * 1024
const targetRoot = resolve(repoRoot, process.argv[2] ?? join('dist', 'models', modelId))
const distRoot = resolve(repoRoot, 'dist')
const cacheRoot = resolve(repoRoot, 'node_modules', '.cache', 'bettertts-model-assets', modelId)
const voiceSourceRoot = resolve(repoRoot, 'node_modules', 'kokoro-js', 'voices')
const voiceIds = [...readFileSync(join(repoRoot, 'src', 'lib', 'voices.ts'), 'utf8').matchAll(/\{\s*id: '([^']+)'/g)]
  .map((match) => match[1])

const remoteAssets = [
  { path: 'config.json', size: 44 },
  { path: 'tokenizer.json', size: 3497 },
  { path: 'tokenizer_config.json', size: 113 },
  { path: 'onnx/model_quantized.onnx', size: 92361116 },
]

if (!targetRoot.startsWith(`${distRoot}${sep}`)) {
  console.error(`Refusing to sync Kokoro assets outside dist/: ${targetRoot}`)
  process.exit(1)
}
if (voiceIds.length !== 28) {
  console.error(`Expected 28 wired Kokoro voices, found ${voiceIds.length}`)
  process.exit(1)
}

mkdirSync(targetRoot, { recursive: true })
rmSync(targetRoot, { recursive: true, force: true })
mkdirSync(targetRoot, { recursive: true })

let totalBytes = 0

for (const asset of remoteAssets) {
  validatePagesFileSize(asset.path, asset.size)
  const cached = await ensureRemoteAsset(asset)
  copyAsset(cached, join(targetRoot, asset.path), asset.size)
  totalBytes += asset.size
}

for (const voiceId of voiceIds) {
  const relativePath = `voices/${voiceId}.bin`
  const source = join(voiceSourceRoot, `${voiceId}.bin`)
  const size = statSync(source).size
  validatePagesFileSize(relativePath, size)
  copyAsset(source, join(targetRoot, relativePath), size)
  totalBytes += size
}

if (totalBytes > pagesSiteCap) {
  console.error(`Kokoro asset bundle is ${formatBytes(totalBytes)}, above the GitHub Pages 1 GB site cap`)
  process.exit(1)
}

console.log(`Synced ${remoteAssets.length + voiceIds.length} Kokoro assets (${formatBytes(totalBytes)}) to ${targetRoot}`)

async function ensureRemoteAsset(asset) {
  const cachedPath = join(cacheRoot, asset.path)
  if (existsSync(cachedPath) && statSync(cachedPath).size === asset.size) return cachedPath

  mkdirSync(dirname(cachedPath), { recursive: true })
  const tempPath = `${cachedPath}.tmp-${process.pid}`
  const url = `${hfResolveBase}/${asset.path}`
  const response = await fetchWithRetry(url)
  if (!response.body) throw new Error(`No response body for ${url}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath))
  if (statSync(tempPath).size !== asset.size) {
    rmSync(tempPath, { force: true })
    throw new Error(`Downloaded ${asset.path} with unexpected size`)
  }
  rmSync(cachedPath, { force: true })
  renameSync(tempPath, cachedPath)
  return cachedPath
}

async function fetchWithRetry(url) {
  let response = await fetch(url)
  for (let attempt = 0; attempt < 2 && response.status === 429; attempt += 1) {
    const delayMs = retryDelayMs(response.headers, attempt)
    console.warn(`Rate limited downloading ${url}; retrying in ${Math.round(delayMs / 1000)}s`)
    await wait(delayMs)
    response = await fetch(url)
  }
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  return response
}

function retryDelayMs(headers, attempt) {
  const parsed =
    parseRetryAfter(headers.get('retry-after'))
    ?? parseRetryAfter(headers.get('ratelimit-reset'))
    ?? parseRetryAfter(headers.get('x-ratelimit-reset'))
    ?? parseRateLimitWindow(headers.get('ratelimit'))
    ?? [1000, 2500][Math.min(attempt, 1)]
  return Math.max(250, Math.min(parsed, 60_000))
}

function parseRetryAfter(value) {
  if (!value) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    if (numeric > 1_000_000_000) return Math.max(0, numeric * 1000 - Date.now())
    return Math.max(0, numeric * 1000)
  }
  const dateMs = Date.parse(value)
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now())
}

function parseRateLimitWindow(value) {
  const match = value?.match(/(?:^|[;,])\s*t=(\d+)/i)
  return match ? Number(match[1]) * 1000 : null
}

function validatePagesFileSize(path, size) {
  if (size > pagesFileCap) {
    console.error(`${path} is ${formatBytes(size)}, above the GitHub Pages 100 MB per-file cap`)
    process.exit(1)
  }
}

function copyAsset(source, target, expectedSize) {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  if (statSync(target).size !== expectedSize) throw new Error(`Copied ${target} with unexpected size`)
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
