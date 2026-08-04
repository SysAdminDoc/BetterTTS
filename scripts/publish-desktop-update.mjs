#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { buildStaticUpdateMetadata, readDesktopUpdateArtifacts, verifyMetadataChecksum } from './desktop-update-feed.mjs'
import { readSbom } from './generate-sbom.mjs'
import { assertRemoteReleaseTag, readReleaseIdentity } from './release-identity.mjs'

const repoRoot = process.cwd()
const identity = readReleaseIdentity(repoRoot)
assertRemoteReleaseTag(repoRoot, identity)
const artifacts = readDesktopUpdateArtifacts(repoRoot, { requireSbom: true })
await verifyMetadataChecksum(artifacts.metadata, artifacts.installerPath)
readSbom(artifacts.sbomPath, { root: repoRoot })
const staticMetadata = buildStaticUpdateMetadata(artifacts.metadata, { ...artifacts, ...identity })

const existingRelease = (() => {
  try {
    const json = execFileSync('gh', ['release', 'view', artifacts.tag, '--json', 'body,tagName'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(json)
  } catch (error) {
    const detail = `${String(error?.stderr ?? '')} ${String(error?.stdout ?? '')}`
    if (/not found|404/i.test(detail)) return null
    throw new Error(`Could not inspect GitHub Release ${artifacts.tag}: ${detail.trim() || 'gh release view failed'}`)
  }
})()

if (existingRelease) {
  const sourceSha = existingRelease.body?.match(/^BetterTTS source SHA:\s*([a-f0-9]{40})$/im)?.[1]
  if (sourceSha !== identity.sourceSha) {
    throw new Error(`GitHub Release ${artifacts.tag} is already associated with a different source commit.`)
  }
}

const assetPaths = [artifacts.installerPath, artifacts.blockmapPath, artifacts.sbomPath]
if (existingRelease) {
  execFileSync('gh', ['release', 'upload', artifacts.tag, ...assetPaths, '--clobber'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
} else {
  execFileSync('gh', [
    'release',
    'create',
    artifacts.tag,
    ...assetPaths,
    '--title',
    `BetterTTS ${artifacts.tag}`,
    '--notes',
    `BetterTTS source SHA: ${identity.sourceSha}\nBetterTTS release tag: ${identity.tag}\n\nUnsigned Windows update artifacts plus a validated CycloneDX software/model SBOM for BetterTTS ${artifacts.packageVersion}.`,
    '--verify-tag',
  ], { cwd: repoRoot, stdio: 'inherit' })
}

const { assetUrl } = staticMetadata
const response = await fetch(assetUrl, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' })
await response.body?.cancel()
if (!response.ok) throw new Error(`Published update asset is unavailable: HTTP ${response.status}`)
console.log(`Published verified unsigned desktop update ${artifacts.tag} to ${assetUrl}`)
