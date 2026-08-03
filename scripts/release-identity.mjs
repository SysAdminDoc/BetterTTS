import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const RELEASE_IDENTITY_SCHEMA_VERSION = 1

const SHA_RE = /^[a-f0-9]{40}$/i

export function readReleaseIdentity(repoRoot, { requireTag = true, requireClean = true } = {}) {
  const version = assertVersionMetadata(repoRoot)
  const sourceSha = runGit(repoRoot, ['rev-parse', 'HEAD'])
  if (!SHA_RE.test(sourceSha)) throw new Error(`Could not resolve a full source commit SHA: ${sourceSha}`)

  if (requireClean) {
    const dirty = runGit(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (dirty) throw new Error(`Release source must be clean before publishing. First change: ${dirty.split(/\r?\n/)[0]}`)
  }

  const tag = `v${version}`
  if (requireTag) {
    const tagType = runGit(repoRoot, ['cat-file', '-t', `refs/tags/${tag}`])
    if (tagType !== 'tag') throw new Error(`${tag} must be an annotated tag; found ${tagType || 'missing tag'}.`)
    const taggedSha = runGit(repoRoot, ['rev-list', '-1', `${tag}^{commit}`])
    if (taggedSha !== sourceSha) {
      throw new Error(`${tag} targets ${taggedSha}, but the built source is ${sourceSha}.`)
    }
  }

  return {
    schemaVersion: RELEASE_IDENTITY_SCHEMA_VERSION,
    app: 'BetterTTS',
    version,
    tag,
    sourceSha,
  }
}

export function assertRemoteReleaseTag(repoRoot, identity, remote = 'origin') {
  const result = runGit(repoRoot, ['ls-remote', remote, `refs/tags/${identity.tag}^{}`], { allowEmpty: true })
  const remoteSha = result.split(/\s+/)[0] ?? ''
  if (remoteSha !== identity.sourceSha) {
    throw new Error(`Remote ${remote} tag ${identity.tag} does not target ${identity.sourceSha}.`)
  }
}

export function assertVersionMetadata(repoRoot) {
  const packageJson = readJson(join(repoRoot, 'package.json'), 'package.json')
  const version = packageJson.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`package.json has no valid release version: ${version ?? 'missing'}`)
  }

  const packageLock = readJson(join(repoRoot, 'package-lock.json'), 'package-lock.json')
  if (packageLock.version !== version || packageLock.packages?.['']?.version !== version) {
    throw new Error(`package-lock.json version does not match package ${version}.`)
  }

  const readme = readText(join(repoRoot, 'README.md'), 'README.md')
  if (!readme.includes(`shields.io/badge/version-${version}-blue.svg`)) {
    throw new Error(`README.md version badge does not match package ${version}.`)
  }

  const changelog = readText(join(repoRoot, 'CHANGELOG.md'), 'CHANGELOG.md')
  const changelogVersion = changelog.match(/^## v([^\s]+)\s+-\s+\d{4}-\d{2}-\d{2}/m)?.[1]
  if (changelogVersion !== version) {
    throw new Error(`CHANGELOG.md latest version ${changelogVersion ?? 'missing'} does not match package ${version}.`)
  }

  const app = readText(join(repoRoot, 'src', 'App.tsx'), 'src/App.tsx')
  const appVersion = app.match(/const APP_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
  if (appVersion !== version) {
    throw new Error(`src/App.tsx APP_VERSION ${appVersion ?? 'missing'} does not match package ${version}.`)
  }

  return version
}

export function writePagesReleaseManifest(distDir, identity) {
  const path = join(distDir, 'release.json')
  const manifest = {
    schemaVersion: RELEASE_IDENTITY_SCHEMA_VERSION,
    app: identity.app,
    version: identity.version,
    tag: identity.tag,
    sourceSha: identity.sourceSha,
    artifact: 'github-pages',
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return path
}

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing.`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readText(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing.`)
  return readFileSync(path, 'utf8')
}

function runGit(repoRoot, args, { allowEmpty = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    if (allowEmpty && error?.status === 0) return ''
    const detail = String(error?.stderr ?? '').trim()
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
}
