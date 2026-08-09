import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = VERSION_PATTERN.exec(value.trim())
  return match ? match.slice(1, 4).map(Number) : null
}

export function matchesVersionLine(version, line) {
  const parsed = parseVersion(version)
  if (!parsed || typeof line !== 'string') return false
  const parts = line.trim().split('.')
  if (parts.length < 1 || parts.length > 3) return false
  return parts.every((part, index) => part === 'x' || Number.parseInt(part, 10) === parsed[index])
}

export function readCompatibilityConfig(root = REPO_ROOT) {
  const path = join(root, 'scripts', 'dependency-compatibility.json')
  if (!existsSync(path)) throw new Error('scripts/dependency-compatibility.json is missing.')
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function packagePath(name) {
  return ['node_modules', ...name.split('/')].join('/')
}

function packageManifestPath(root, name) {
  return join(root, packagePath(name), 'package.json')
}

function isPackagePath(path, name) {
  return path === packagePath(name) || path.endsWith(`/${packagePath(name)}`)
}

function packageSpec(packageJson, name) {
  return packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name]
}

function lockInstances(lockfile, name) {
  return Object.entries(lockfile.packages ?? {})
    .filter(([path, entry]) => isPackagePath(path, name) && entry && typeof entry.version === 'string')
    .map(([path, entry]) => ({ path, version: entry.version }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function rootLockSpec(lockfile, name) {
  const root = lockfile.packages?.['']
  return root?.dependencies?.[name] ?? root?.devDependencies?.[name]
}

function directInstance(instances, name) {
  return instances.find((entry) => entry.path === packagePath(name))
}

function validateConfig(config) {
  if (!config || config.schemaVersion !== 1) throw new Error(`Unsupported dependency compatibility schema: ${String(config?.schemaVersion)}`)
  if (!Array.isArray(config.gates) || config.gates.length === 0 || config.gates.some((gate) => typeof gate !== 'string' || gate.length === 0)) {
    throw new Error('Dependency compatibility gates must be a non-empty list of npm scripts.')
  }
  if (!Array.isArray(config.packages) || config.packages.length === 0) throw new Error('Dependency compatibility package tracks are missing.')
  const names = new Set()
  for (const track of config.packages) {
    if (!track || typeof track.id !== 'string' || typeof track.label !== 'string' || !Array.isArray(track.packages) || track.packages.length === 0) {
      throw new Error('Dependency compatibility tracks must declare an id, label, and package list.')
    }
    for (const policy of track.packages) {
      if (!policy || typeof policy.name !== 'string' || names.has(policy.name) || typeof policy.spec !== 'string' || typeof policy.lockedVersion !== 'string' || typeof policy.line !== 'string') {
        throw new Error(`Invalid or duplicate dependency compatibility policy: ${String(policy?.name)}.`)
      }
      if (!parseVersion(policy.lockedVersion) || !matchesVersionLine(policy.lockedVersion, policy.line) || (policy.directLine !== undefined && !matchesVersionLine(policy.lockedVersion, policy.directLine))) {
        throw new Error(`Dependency compatibility policy ${policy.name} has an invalid locked version or line.`)
      }
      if (policy.override !== undefined && typeof policy.override !== 'string') throw new Error(`Dependency compatibility override for ${policy.name} is invalid.`)
      names.add(policy.name)
    }
  }
  if (!Array.isArray(config.holds) || config.holds.some((hold) => !hold || typeof hold.id !== 'string' || typeof hold.package !== 'string' || typeof hold.candidate !== 'string' || hold.status !== 'deferred' || typeof hold.reason !== 'string' || typeof hold.requiredEvidence !== 'string')) {
    throw new Error('Dependency compatibility holds must record deferred candidates and required evidence.')
  }
}

export function validateCompatibility({ root = REPO_ROOT, config = readCompatibilityConfig(root), checkInstalled = true } = {}) {
  validateConfig(config)
  const packageJson = readJson(join(root, 'package.json'))
  const lockfile = readJson(join(root, 'package-lock.json'))
  const failures = []
  const rows = []

  for (const track of config.packages) {
    for (const policy of track.packages) {
      const declaredSpec = packageSpec(packageJson, policy.name)
      if (declaredSpec !== policy.spec) failures.push(`${policy.name} package.json spec is ${String(declaredSpec)}, expected ${policy.spec}.`)

      const lockedSpec = rootLockSpec(lockfile, policy.name)
      if (lockedSpec !== policy.spec) failures.push(`${policy.name} package-lock root spec is ${String(lockedSpec)}, expected ${policy.spec}.`)

      const instances = lockInstances(lockfile, policy.name)
      const direct = directInstance(instances, policy.name)
      if (!direct) {
        failures.push(`${policy.name} has no direct package-lock instance.`)
      } else {
        if (direct.version !== policy.lockedVersion) failures.push(`${policy.name} lock version is ${direct.version}, expected reviewed ${policy.lockedVersion}.`)
        if (!matchesVersionLine(direct.version, policy.directLine ?? policy.line)) failures.push(`${policy.name} direct version ${direct.version} is outside ${policy.directLine ?? policy.line}.`)
      }
      for (const instance of instances) {
        if (!matchesVersionLine(instance.version, policy.line)) failures.push(`${policy.name} instance ${instance.path} resolved to ${instance.version}, outside ${policy.line}.`)
      }
      if (checkInstalled) {
        const installedPath = packageManifestPath(root, policy.name)
        if (!existsSync(installedPath)) {
          failures.push(`${policy.name} is absent from node_modules; run npm ci before the compatibility check.`)
        } else {
          const installed = readJson(installedPath).version
          if (installed !== policy.lockedVersion) failures.push(`${policy.name} installed version is ${installed}, expected reviewed ${policy.lockedVersion}.`)
        }
      }
      if (policy.override !== undefined && packageJson.overrides?.[policy.name] !== policy.override) {
        failures.push(`${policy.name} override is ${String(packageJson.overrides?.[policy.name])}, expected ${policy.override}.`)
      }
      rows.push({ track: track.id, label: track.label, name: policy.name, spec: policy.spec, lockedVersion: policy.lockedVersion, instances })
    }
  }

  if (failures.length > 0) throw new Error(`Dependency compatibility policy failed:\n- ${failures.join('\n- ')}`)
  return { schemaVersion: config.schemaVersion, packages: rows, holds: config.holds, gates: config.gates }
}

export function npmInvocation(args) {
  const npmCli = process.env.npm_execpath
  if (npmCli) return { file: process.execPath, args: [npmCli, ...args] }
  if (process.platform === 'win32') return { file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] }
  return { file: 'npm', args }
}

export function runCompatibilityGates(root = REPO_ROOT, gates = readCompatibilityConfig(root).gates) {
  for (const gate of gates) {
    console.log(`\n[compatibility] npm run ${gate}`)
    const invocation = npmInvocation(['run', gate])
    const result = spawnSync(invocation.file, invocation.args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Compatibility gate failed: npm run ${gate} (exit ${String(result.status)}).`)
  }
}

function printReport(report) {
  console.log('Dependency compatibility policy passed.')
  for (const row of report.packages) {
    const transitive = row.instances.length > 1 ? `; ${row.instances.length} lock instances reviewed` : ''
    console.log(`- ${row.label}: ${row.name}@${row.lockedVersion} (${row.spec})${transitive}`)
  }
  console.log('Deferred compatibility holds:')
  for (const hold of report.holds) console.log(`- ${hold.package} ${hold.candidate}: ${hold.reason}`)
  console.log(`Run the complete gate matrix with: npm run compatibility:matrix`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const report = validateCompatibility()
    if (process.argv.includes('--run-gates')) runCompatibilityGates(REPO_ROOT, report.gates)
    else if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
    else printReport(report)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
