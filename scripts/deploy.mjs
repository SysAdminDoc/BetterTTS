#!/usr/bin/env node
// Safe gh-pages deploy: builds, then publishes dist/ from a disposable git
// worktree so the main working tree — including gitignored files — is never
// touched. Never use `git clean -fdx` in a deploy flow: -x deletes gitignored
// files (it destroyed local working docs once on 2026-07-08).
import { execSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts })

const repoRoot = process.cwd()
const distDir = join(repoRoot, 'dist')

run('npm run build')
run('node scripts/sync-kokoro-assets.mjs')

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('dist/index.html missing after build — aborting deploy')
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
const worktree = join(tmpdir(), `bettertts-deploy-${process.pid}`)

try {
  rmSync(worktree, { recursive: true, force: true })
  run(`git worktree add --detach "${worktree}"`)
  run('git checkout --orphan gh-pages-temp', { cwd: worktree })
  run('git rm -rf --quiet .', { cwd: worktree })
  cpSync(distDir, worktree, { recursive: true })
  run('git add -A', { cwd: worktree })
  run(`git commit -q -m "Deploy BetterTTS v${version} to GitHub Pages"`, { cwd: worktree })
  run('git push origin HEAD:gh-pages --force', { cwd: worktree })
  console.log(`\nDeployed v${version} to gh-pages.`)
} finally {
  try {
    run(`git worktree remove --force "${worktree}"`)
  } catch {
    /* already gone */
  }
  try {
    execSync('git branch -D gh-pages-temp', { stdio: 'ignore' })
  } catch {
    /* branch may not exist */
  }
  rmSync(worktree, { recursive: true, force: true })
}
