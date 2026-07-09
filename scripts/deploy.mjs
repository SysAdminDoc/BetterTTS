#!/usr/bin/env node
// Safe gh-pages deploy: builds, then publishes dist/ from a disposable git
// worktree so the main working tree — including gitignored files — is never
// touched. Never use `git clean -fdx` in a deploy flow: -x deletes gitignored
// files (it destroyed local working docs once on 2026-07-08).
import { execSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts })

const repoRoot = process.cwd()
const distDir = join(repoRoot, 'dist')

run('npm run build')
run('node scripts/sync-kokoro-assets.mjs')
run('node scripts/sync-piper-assets.mjs')

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('dist/index.html missing after build — aborting deploy')
  process.exit(1)
}

// GitHub Pages runs Jekyll over the branch unless .nojekyll exists, and Jekyll
// silently drops _-prefixed files (e.g. Vite's __vite-browser-external chunks),
// 404ing the Kokoro engine in production. Never deploy without it.
if (!existsSync(join(distDir, '.nojekyll'))) {
  console.error('dist/.nojekyll missing — Jekyll would drop _-prefixed asset chunks. Aborting.')
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
const worktree = join(tmpdir(), `bettertts-deploy-${process.pid}`)

try {
  rmSync(worktree, { recursive: true, force: true })
  try {
    execSync('git worktree prune', { stdio: 'ignore' })
    execSync('git branch -D gh-pages-temp', { stdio: 'ignore' })
  } catch {
    /* no leftover branch from a previously failed deploy */
  }
  run(`git worktree add --detach "${worktree}"`)
  run('git checkout --orphan gh-pages-temp', { cwd: worktree })
  run('git rm -rf --quiet .', { cwd: worktree })
  cpSync(distDir, worktree, { recursive: true })
  run('git add -A', { cwd: worktree })
  run(`git commit -q -m "Deploy BetterTTS v${version} to GitHub Pages"`, { cwd: worktree })
  run('git push origin HEAD:gh-pages --force', { cwd: worktree })
  console.log(`\nDeployed v${version} to gh-pages. Verifying live site...`)
  await verifyLiveDeploy()
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

// Poll the live site until the freshly deployed assets are actually served.
// Catches Pages-side filtering (Jekyll dropped _-prefixed chunks on 2026-07-09)
// that local smoke servers cannot see.
async function verifyLiveDeploy() {
  const base = 'https://sysadmindoc.github.io/BetterTTS/'
  const assets = readdirSync(join(distDir, 'assets'))
  const probes = [`index.html?v=${Date.now()}`]
  const underscoreChunk = assets.find((name) => name.startsWith('_'))
  if (underscoreChunk) probes.push(`assets/${underscoreChunk}`)
  const entryChunk = assets.find((name) => /^index-.*\.js$/.test(name))
  if (entryChunk) probes.push(`assets/${entryChunk}`)

  const deadline = Date.now() + 4 * 60 * 1000
  let lastFailure = ''
  while (Date.now() < deadline) {
    lastFailure = ''
    for (const probe of probes) {
      const res = await fetch(base + probe, { cache: 'no-store' }).catch((err) => ({ ok: false, status: String(err) }))
      if (!res.ok) {
        lastFailure = `${probe} → ${res.status}`
        break
      }
    }
    if (!lastFailure) {
      console.log(`Live site verified: ${probes.length} probes OK.`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 15000))
  }
  console.error(`Live verification FAILED after 4 minutes: ${lastFailure}`)
  process.exit(1)
}
