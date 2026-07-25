import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXED_RUNTIME_VERSIONS = {
  'adm-zip': '0.6.0',
  sharp: '0.35.0',
}

function compareVersions(left, right) {
  const normalize = (value) => value.split(/[.+-]/, 3).map((part) => Number.parseInt(part, 10) || 0)
  const a = normalize(left)
  const b = normalize(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function advisoryIds(vulnerability) {
  return vulnerability.via
    .filter((entry) => typeof entry === 'object' && entry !== null)
    .flatMap((entry) => {
      const urlId = typeof entry.url === 'string' ? entry.url.split('/').at(-1) : null
      return [String(entry.source ?? ''), urlId].filter(Boolean)
    })
}

export function validateExceptions(config, now = new Date()) {
  if (config?.schemaVersion !== 1 || !Array.isArray(config.exceptions)) {
    throw new Error('scripts/security-exceptions.json must use schemaVersion 1 and an exceptions array.')
  }

  return config.exceptions.map((exception, index) => {
    const label = `Security exception ${index + 1}`
    if (!exception.package || !exception.advisory || !exception.owner || !exception.expires || !exception.rationale) {
      throw new Error(`${label} must include package, advisory, owner, expires, and rationale.`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expires)) {
      throw new Error(`${label} expires must be an absolute YYYY-MM-DD date.`)
    }
    const expiresAt = new Date(`${exception.expires}T23:59:59.999Z`)
    if (Number.isNaN(expiresAt.getTime()) || expiresAt < now) {
      throw new Error(`${label} expired on ${exception.expires}.`)
    }
    return exception
  })
}

export function evaluateAudit(audit, exceptions) {
  const findings = Object.values(audit?.vulnerabilities ?? {})
    .filter((vulnerability) => ['high', 'critical'].includes(vulnerability.severity))
    .filter((vulnerability) => {
      const ids = advisoryIds(vulnerability)
      return !exceptions.some((exception) => (
        exception.package === vulnerability.name
        && (exception.advisory === '*' || ids.includes(exception.advisory))
      ))
    })

  return findings.map((vulnerability) => ({
    package: vulnerability.name,
    severity: vulnerability.severity,
    range: vulnerability.range,
    advisories: advisoryIds(vulnerability),
  }))
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath
  const executable = npmCli ? process.execPath : 'npm'
  const commandArgs = npmCli ? [npmCli, ...args] : args
  return spawnSync(executable, commandArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: !npmCli && process.platform === 'win32',
  })
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout)
  } catch {
    const detail = result.error?.message || result.stderr?.trim()
    throw new Error(`${label} did not return valid JSON.${detail ? ` ${detail}` : ''}`)
  }
}

function inspectDependencyGraph() {
  const result = runNpm(['ls', '--omit=dev', '--all', '--json'])
  const graph = parseJsonOutput(result, 'npm ls')
  if (result.status !== 0 || graph.problems?.length) {
    throw new Error(`Production dependency graph is invalid: ${(graph.problems ?? [result.stderr]).join('; ')}`)
  }
}

async function inspectPackagedArtifact(artifactPath) {
  const absolutePath = resolve(artifactPath)
  if (!existsSync(absolutePath)) {
    throw new Error(`Packaged app archive not found: ${absolutePath}`)
  }

  const { extractFile, listPackage } = await import('@electron/asar')
  const entries = listPackage(absolutePath)

  for (const [packageName, minimumVersion] of Object.entries(FIXED_RUNTIME_VERSIONS)) {
    const suffix = `/node_modules/${packageName}/package.json`
    const manifests = entries.filter((entry) => entry.replaceAll('\\', '/').endsWith(suffix))
    if (manifests.length === 0) {
      throw new Error(`Packaged archive is missing ${packageName}; runtime graph is incomplete.`)
    }

    for (const manifest of manifests) {
      const packageJson = JSON.parse(extractFile(absolutePath, manifest.replace(/^[/\\]+/, '')).toString('utf8'))
      if (compareVersions(packageJson.version, minimumVersion) < 0) {
        throw new Error(`Packaged ${packageName}@${packageJson.version} is below fixed ${minimumVersion}.`)
      }
    }
  }

  return absolutePath
}

export async function runSecurityCheck(args = process.argv.slice(2)) {
  const exceptionsPath = resolve('scripts/security-exceptions.json')
  const exceptions = validateExceptions(JSON.parse(readFileSync(exceptionsPath, 'utf8')))
  inspectDependencyGraph()

  const auditResult = runNpm(['audit', '--omit=dev', '--json'])
  const audit = parseJsonOutput(auditResult, 'npm audit')
  const findings = evaluateAudit(audit, exceptions)
  if (findings.length > 0) {
    throw new Error(`Unresolved high/critical production vulnerabilities:\n${JSON.stringify(findings, null, 2)}`)
  }

  const artifactIndex = args.indexOf('--artifact')
  const artifact = artifactIndex >= 0
    ? await inspectPackagedArtifact(args[artifactIndex + 1] ?? '')
    : null

  const summary = {
    ok: true,
    productionDependencies: audit.metadata?.dependencies?.prod ?? null,
    high: audit.metadata?.vulnerabilities?.high ?? 0,
    critical: audit.metadata?.vulnerabilities?.critical ?? 0,
    activeExceptions: exceptions.length,
    artifact,
  }
  console.log(JSON.stringify(summary))
  return summary
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  runSecurityCheck().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
