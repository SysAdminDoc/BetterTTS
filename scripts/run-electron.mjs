#!/usr/bin/env node
// Launches Electron with ELECTRON_RUN_AS_NODE fully removed. Some environments
// export ELECTRON_RUN_AS_NODE=1, which makes `electron .` run as plain Node
// (require('electron').app is undefined) — and setting it to an empty string is
// worse (a half-initialized node mode that crashes on a snapshot assertion), so
// it must be deleted from the child's environment entirely, not just blanked.
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const args = process.env.BETTERTTS_SMOKE_ENTRY === '1'
  ? ['.', '--smoke']
  : ['.', ...process.argv.slice(2)]
const child = spawn(electronPath, args, { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error(err)
  process.exit(1)
})
