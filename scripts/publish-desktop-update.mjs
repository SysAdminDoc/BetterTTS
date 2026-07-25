#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { buildStaticUpdateMetadata, readDesktopUpdateArtifacts, verifyMetadataChecksum } from './desktop-update-feed.mjs'

const repoRoot = process.cwd()
const artifacts = readDesktopUpdateArtifacts(repoRoot)
await verifyMetadataChecksum(artifacts.metadata, artifacts.installerPath)

const releaseExists = (() => {
  try {
    execFileSync('gh', ['release', 'view', artifacts.tag], { cwd: repoRoot, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const assetPaths = [artifacts.installerPath, artifacts.blockmapPath]
if (releaseExists) {
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
    `Unsigned Windows update artifacts for BetterTTS ${artifacts.packageVersion}.`,
  ], { cwd: repoRoot, stdio: 'inherit' })
}

const { assetUrl } = buildStaticUpdateMetadata(artifacts.metadata, artifacts)
const response = await fetch(assetUrl, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' })
await response.body?.cancel()
if (!response.ok) throw new Error(`Published update asset is unavailable: HTTP ${response.status}`)
console.log(`Published verified unsigned desktop update ${artifacts.tag} to ${assetUrl}`)
