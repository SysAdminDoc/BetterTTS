#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, rmSync, copyFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import modelAssets from '../src/lib/model-assets.json' with { type: 'json' }
import { assertAssetMetadata, verifyFile } from './model-integrity.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const modelId = modelAssets.piper.modelId
const revision = modelAssets.piper.revision
const hfResolveBase = `https://huggingface.co/${modelId}/resolve/${revision}`
const pagesFileCap = 100 * 1000 * 1000
const distRoot = resolve(repoRoot, 'dist')
const cacheRoot = resolve(repoRoot, 'node_modules', '.cache', 'bettertts-model-assets', modelId)
const onnxAsset = modelAssets.piper.onnx
const configAsset = modelAssets.piper.config
const remoteAssets = [onnxAsset, configAsset]

export const PIPER_MODEL_REVISION = revision
export const PIPER_REMOTE_ASSETS = remoteAssets

export async function syncPiperAssets(targetRoot = resolve(repoRoot, 'dist', 'models', modelId)) {
  if (!targetRoot.startsWith(`${distRoot}${sep}`)) {
    throw new Error(`Refusing to sync Piper assets outside dist/: ${targetRoot}`)
  }

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

  const sidecar = join(targetRoot, `${onnxAsset.path}.json`)
  copyFileSync(join(targetRoot, configAsset.path), sidecar)
  await verifyFile(sidecar, configAsset, `Copied ${onnxAsset.path}.json`)
  totalBytes += configAsset.size

  return { count: remoteAssets.length + 1, totalBytes, targetRoot }
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
    const delayMs = [1000, 2500][attempt]
    console.warn(`Rate limited downloading ${url}; retrying in ${Math.round(delayMs / 1000)}s`)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    response = await fetch(url)
  }
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  return response
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await syncPiperAssets(process.argv[2] ? resolve(repoRoot, process.argv[2]) : undefined)
  console.log(`Synced Piper-plus assets (${formatBytes(result.totalBytes)}) to ${result.targetRoot}`)
}
