import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const RELEASE_REPOSITORY = 'SysAdminDoc/BetterTTS'

const SOURCE_SHA_RE = /^[a-f0-9]{40}$/i

export function readDesktopUpdateArtifacts(repoRoot) {
  const releaseDir = join(repoRoot, 'release')
  const metadataPath = join(releaseDir, 'latest.yml')
  if (!existsSync(metadataPath)) {
    throw new Error('release/latest.yml is missing. Run npm run desktop:dist first.')
  }

  const metadata = readFileSync(metadataPath, 'utf8')
  const version = captureScalar(metadata, 'version')
  const installerName = captureScalar(metadata, 'path')
  const packageVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  if (version !== packageVersion) {
    throw new Error(`Update metadata version ${version ?? 'missing'} does not match package ${packageVersion}.`)
  }
  if (!installerName || installerName !== basename(installerName) || !installerName.endsWith('.exe')) {
    throw new Error('release/latest.yml has no safe Windows installer path.')
  }

  const installerPath = join(releaseDir, installerName)
  const blockmapPath = `${installerPath}.blockmap`
  for (const path of [installerPath, blockmapPath]) {
    if (!existsSync(path)) throw new Error(`Required update artifact is missing: ${path}`)
  }

  return {
    blockmapPath,
    installerName,
    installerPath,
    metadata,
    metadataPath,
    packageVersion,
    tag: `v${packageVersion}`,
  }
}

export function buildStaticUpdateMetadata(metadata, {
  repository = RELEASE_REPOSITORY,
  tag,
  installerName,
  sourceSha,
}) {
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Unsafe release tag: ${tag}`)
  }
  if (!installerName || installerName !== basename(installerName)) {
    throw new Error(`Unsafe release asset name: ${installerName}`)
  }
  if (!SOURCE_SHA_RE.test(sourceSha ?? '')) {
    throw new Error(`Unsafe release source SHA: ${sourceSha}`)
  }
  const metadataVersion = captureScalar(metadata, 'version')
  if (metadataVersion !== tag.slice(1)) {
    throw new Error(`Update metadata version ${metadataVersion ?? 'missing'} does not match release tag ${tag}.`)
  }
  // GitHub normalizes spaces in uploaded release asset names to dots.
  const releaseAssetName = installerName.replaceAll(' ', '.')
  const assetUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(releaseAssetName)}`
  const rewritten = metadata
    .replace(/^betterttsSourceSha:\s*[^\r\n]*\r?\n?/gim, '')
    .replace(/^betterttsReleaseTag:\s*[^\r\n]*\r?\n?/gim, '')
    .replace(/^(\s*-\s+url:\s*).+$/m, `$1${assetUrl}`)
    .replace(/^path:\s*.+$/m, `path: ${assetUrl}`)
  const identity = `betterttsSourceSha: ${sourceSha}\nbetterttsReleaseTag: ${tag}`
  if (rewritten === metadata || !rewritten.includes(assetUrl)) {
    throw new Error('Could not rewrite desktop update metadata with the release asset URL.')
  }
  return { assetUrl, metadata: `${rewritten.trimEnd()}\n${identity}\n` }
}

export function readStaticUpdateIdentity(metadata) {
  const sourceSha = captureScalar(metadata, 'betterttsSourceSha')
  const tag = captureScalar(metadata, 'betterttsReleaseTag')
  if (!SOURCE_SHA_RE.test(sourceSha ?? '') || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag ?? '')) {
    throw new Error('Desktop update metadata has no valid BetterTTS source identity.')
  }
  return { sourceSha, tag }
}

export async function verifyMetadataChecksum(metadata, installerPath) {
  const expected = captureScalar(metadata, 'sha512')
  if (!expected) throw new Error('release/latest.yml has no SHA-512 checksum.')
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(installerPath)) hash.update(chunk)
  const actual = hash.digest('base64')
  if (actual !== expected) {
    throw new Error('Installer SHA-512 does not match release/latest.yml.')
  }
}

function captureScalar(metadata, name) {
  const match = metadata.match(new RegExp(`^${name}:\\s*['"]?([^'"\\r\\n]+)['"]?`, 'm'))
  return match?.[1]?.trim() ?? null
}
