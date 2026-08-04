#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import modelAssets from '../src/lib/model-assets.json' with { type: 'json' }
import { assertAssetMetadata, verifyFile } from './model-integrity.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const modelId = modelAssets.kokoro.modelId
const revision = modelAssets.kokoro.revision
const hfResolveBase = `https://huggingface.co/${modelId}/resolve/${revision}`
const pagesFileCap = 100 * 1000 * 1000
const pagesSiteCap = 1024 * 1024 * 1024
const distRoot = resolve(repoRoot, 'dist')
const cacheRoot = resolve(repoRoot, 'node_modules', '.cache', 'bettertts-model-assets', modelId)
const voiceSourceRoot = resolve(repoRoot, 'node_modules', 'kokoro-js', 'voices')
const remoteAssets = modelAssets.kokoro.remoteAssets
const voiceAssets = modelAssets.kokoro.voiceAssets

export const KOKORO_MODEL_REVISION = revision
export const KOKORO_REMOTE_ASSETS = remoteAssets
export const KOKORO_VOICE_ASSETS = voiceAssets

export async function syncKokoroAssets(targetRoot = resolve(repoRoot, 'dist', 'models', modelId)) {
  if (!targetRoot.startsWith(`${distRoot}${sep}`)) {
    throw new Error(`Refusing to sync Kokoro assets outside dist/: ${targetRoot}`)
  }

  const voiceEntries = [...readFileSync(join(repoRoot, 'src', 'lib', 'voices.ts'), 'utf8')
    .matchAll(/\{\s*id: '([^']+)'.*?locale: '([^']+)'/g)]
    .map((match) => ({ id: match[1], locale: match[2] }))
  const voiceIds = voiceEntries
    .filter((voice) => voice.locale === 'en-us' || voice.locale === 'en-gb')
    .map((voice) => voice.id)
  if (voiceEntries.length !== 54 || voiceIds.length !== voiceAssets.length) {
    throw new Error(`Expected 54 wired Kokoro voices with ${voiceAssets.length} self-hosted English bins, found ${voiceEntries.length}/${voiceIds.length}`)
  }

  const voiceAssetByPath = new Map(voiceAssets.map((asset) => [asset.path, asset]))
  mkdirSync(targetRoot, { recursive: true })
  rmSync(targetRoot, { recursive: true, force: true })
  mkdirSync(targetRoot, { recursive: true })

  let totalBytes = 0
  for (const asset of remoteAssets) {
    validatePagesFileSize(asset.path, asset.size)
    const cached = await ensureRemoteAsset(asset)
    const target = join(targetRoot, asset.path)
    await copyAsset(cached, target, asset)
    totalBytes += asset.size
  }

  for (const voiceId of voiceIds) {
    const relativePath = `voices/${voiceId}.bin`
    const asset = voiceAssetByPath.get(relativePath)
    if (!asset) throw new Error(`No integrity metadata for ${relativePath}`)
    const source = join(voiceSourceRoot, `${voiceId}.bin`)
    await verifyFile(source, asset, `Installed ${relativePath}`)
    validatePagesFileSize(relativePath, asset.size)
    const target = join(targetRoot, relativePath)
    await copyAsset(source, target, asset)
    totalBytes += asset.size
  }

  if (totalBytes > pagesSiteCap) {
    throw new Error(`Kokoro asset bundle is ${formatBytes(totalBytes)}, above the GitHub Pages 1 GB site cap`)
  }

  return {
    count: remoteAssets.length + voiceIds.length,
    totalBytes,
    targetRoot,
  }
}

async function ensureRemoteAsset(asset) {
  assertAssetMetadata(asset)
  const cachedPath = join(cacheRoot, asset.path)
  if (existsSync(cachedPath)) {
    try {
      await verifyFile(cachedPath, asset, `Cached ${asset.path}`)
      return cachedPath
    } catch {
      rmSync(cachedPath, { force: true })
    }
  }

  mkdirSync(dirname(cachedPath), { recursive: true })
  const tempPath = `${cachedPath}.tmp-${process.pid}`
  const url = `${hfResolveBase}/${asset.path}`
  const response = await fetchWithRetry(url)
  if (!response.body) throw new Error(`No response body for ${url}`)
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath))
    await verifyFile(tempPath, asset, `Downloaded ${asset.path}`)
    rmSync(cachedPath, { force: true })
    renameSync(tempPath, cachedPath)
    return cachedPath
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
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
  if (size > pagesFileCap) throw new Error(`${path} is ${formatBytes(size)}, above the GitHub Pages 100 MB per-file cap`)
}

async function copyAsset(source, target, asset) {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  await verifyFile(target, asset, `Copied ${asset.path}`)
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await syncKokoroAssets(process.argv[2] ? resolve(repoRoot, process.argv[2]) : undefined)
  console.log(`Synced ${result.count} Kokoro assets (${formatBytes(result.totalBytes)}) to ${result.targetRoot}`)
}
