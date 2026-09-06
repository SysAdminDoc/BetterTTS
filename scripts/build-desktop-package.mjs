#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = process.cwd()
const releaseDir = join(root, 'release')
const runtimeDir = join(root, 'build', 'electron-runtime')
const stagedRuntimeDir = join(releaseDir, 'win-unpacked.tmp')
const electronVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version

function assertBuildPath(path, expected) {
  if (resolve(path) !== resolve(expected)) throw new Error(`Refusing to clean unexpected build path: ${path}`)
}

function cleanRelease() {
  assertBuildPath(releaseDir, join(root, 'release'))
  rmSync(releaseDir, { recursive: true, force: true })
  mkdirSync(releaseDir, { recursive: true })
}

function cachedRuntimeMatches() {
  if (!existsSync(join(runtimeDir, 'electron.exe')) || !existsSync(join(runtimeDir, 'version'))) return false
  return readFileSync(join(runtimeDir, 'version'), 'utf8').trim() === electronVersion
}

function runBuilder(useCachedRuntime) {
  const args = [
    join(root, 'node_modules', 'electron-builder', 'cli.js'),
    '--win',
    '--config',
    'electron-builder.yml',
  ]
  if (useCachedRuntime) args.push(`--config.electronDist=${runtimeDir}`)
  return spawnSync(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    timeout: 20 * 60 * 1000,
  })
}

if (existsSync(runtimeDir) && !cachedRuntimeMatches()) {
  assertBuildPath(runtimeDir, join(root, 'build', 'electron-runtime'))
  rmSync(runtimeDir, { recursive: true, force: true })
}

cleanRelease()
let result = runBuilder(cachedRuntimeMatches())

if ((result.status ?? 1) !== 0 && !cachedRuntimeMatches() && existsSync(stagedRuntimeDir)) {
  mkdirSync(join(root, 'build'), { recursive: true })
  let recovered = false
  for (let attempt = 0; attempt < 20 && !recovered; attempt += 1) {
    try {
      renameSync(stagedRuntimeDir, runtimeDir)
      recovered = true
    } catch (error) {
      if (attempt === 19) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
    }
  }
  cleanRelease()
  console.log(`Retrying with the verified Electron ${electronVersion} runtime cache.`)
  result = runBuilder(true)
}

if (result.error) throw result.error
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)
