#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = process.cwd()
const temporaryRoot = mkdtempSync(join(tmpdir(), 'bettertts-release-smoke-'))
const modelCache = join(temporaryRoot, 'native-model-cache')
const packagedReportPath = join(temporaryRoot, 'packaged-report.json')
const combinedReportPath = join(root, 'release', 'release-smoke.json')

function command(name) {
  if (process.platform !== 'win32') return { file: name, prefix: [] }
  return { file: 'cmd.exe', prefix: ['/d', '/s', '/c', name] }
}

function run(name, args, env = process.env) {
  const executable = command(name)
  const result = spawnSync(executable.file, [...executable.prefix, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    stdio: 'inherit',
    timeout: 20 * 60 * 1000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${name} ${args.join(' ')} exited ${result.status}`)
}

try {
  run('npm', ['run', 'smoke:release'])
  const browserReport = JSON.parse(readFileSync(join(root, 'dist', 'smoke', 'real-engine.json'), 'utf8'))

  run('npm', ['run', 'desktop:dist'])
  const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const updateMetadata = readFileSync(join(root, 'release', 'latest.yml'), 'utf8')
  const packagedUpdateConfig = readFileSync(join(root, 'release', 'win-unpacked', 'resources', 'app-update.yml'), 'utf8')
  if (
    !updateMetadata.includes(`version: ${packageVersion}`)
    || !/^sha512:\s*\S+/m.test(updateMetadata)
    || !packagedUpdateConfig.includes('https://sysadmindoc.github.io/BetterTTS/updates/')
  ) {
    throw new Error('Packaged static update metadata is missing, stale, or incomplete.')
  }
  const packagedExecutable = resolve(root, 'release', 'win-unpacked', process.platform === 'win32' ? 'BetterTTS.exe' : 'BetterTTS')
  if (!existsSync(packagedExecutable)) throw new Error(`Packaged executable not found: ${packagedExecutable}`)
  const packagedEnv = {
    ...process.env,
    BETTERTTS_SMOKE_NATIVE_LOAD: '1',
    BETTERTTS_MODEL_CACHE: modelCache,
    BETTERTTS_SMOKE_REPORT: packagedReportPath,
  }
  delete packagedEnv.ELECTRON_RUN_AS_NODE
  run(packagedExecutable, ['--smoke'], packagedEnv)
  const packagedReport = JSON.parse(readFileSync(packagedReportPath, 'utf8'))
  const modelPack = packagedReport.nativeLoad?.runtime?.modelPack
  if (
    !packagedReport.ok
    || !packagedReport.nativeSynthesis?.ok
    || !packagedReport.nativeCancellation?.ok
    || modelPack?.revision !== browserReport.revision
    || modelPack?.license?.tier !== 'permissive'
    || modelPack?.verified !== true
  ) {
    throw new Error(`Packaged real-engine verification failed: ${JSON.stringify(packagedReport)}`)
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: true,
    browser: browserReport,
    packaged: packagedReport,
    temporaryModelCacheRemoved: true,
  }
  writeFileSync(combinedReportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Release smoke passed. Report: ${combinedReportPath}`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
