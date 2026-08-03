#!/usr/bin/env node
// Fetch the pinned upstream whisper.cpp Windows x64 CLI during desktop builds.
// The executable is a build artifact, not a source-controlled binary; model
// weights remain user-cacheable and are never bundled into the installer.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unzipSync } from 'fflate'

// Keep this build-time script runnable by the supported Node runtime without
// relying on Node's optional TypeScript loader. These values mirror the
// renderer-visible manifest in src/lib/whisper.ts.
const WHISPER_CPP_VERSION = 'v1.9.1'
const WHISPER_CPP_ASSET = 'whisper-bin-x64.zip'
const WHISPER_CPP_ASSET_SHA256 = '7D8BE46ECD31828E1EB7A2ECDD0D6B314FEAFD82163038AB6092594B0A063539'
const WHISPER_CPP_DOWNLOAD_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}/${WHISPER_CPP_ASSET}`

const outputDirectory = resolve('dist-electron', 'whisper')
const requiredRuntimeFiles = ['whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-cpu-x64.dll']

if (requiredRuntimeFiles.every((name) => existsSync(join(outputDirectory, name)))) {
  console.log(`whisper.cpp ${WHISPER_CPP_VERSION} runtime already prepared.`)
  process.exit(0)
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'bettertts-whisper-runtime-'))
const archivePath = join(temporaryDirectory, WHISPER_CPP_ASSET)

try {
  const response = await fetch(WHISPER_CPP_DOWNLOAD_URL, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`whisper.cpp download failed with HTTP ${response.status}.`)
  const archive = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(archive).digest('hex').toUpperCase()
  if (digest !== WHISPER_CPP_ASSET_SHA256) {
    throw new Error(`whisper.cpp archive SHA-256 mismatch: expected ${WHISPER_CPP_ASSET_SHA256}, got ${digest}.`)
  }
  writeFileSync(archivePath, archive)

  const entries = unzipSync(new Uint8Array(archive))
  const wanted = Object.entries(entries).filter(([name]) => {
    const normalized = name.replaceAll('\\', '/')
    return normalized.startsWith('Release/')
      && (normalized.endsWith('/whisper-cli.exe') || normalized.endsWith('/whisper.dll') || normalized.endsWith('/ggml.dll') || /\/ggml-[^/]+\.dll$/iu.test(normalized))
  })
  if (!wanted.some(([name]) => name.toLowerCase().endsWith('/whisper-cli.exe'))) {
    throw new Error('The pinned whisper.cpp archive did not contain Release/whisper-cli.exe.')
  }

  rmSync(outputDirectory, { recursive: true, force: true })
  mkdirSync(outputDirectory, { recursive: true })
  for (const [name, bytes] of wanted) {
    const outputName = name.slice(name.lastIndexOf('/') + 1)
    writeFileSync(join(outputDirectory, outputName), bytes)
  }
  console.log(`Prepared whisper.cpp ${WHISPER_CPP_VERSION} (${wanted.length} Windows runtime files).`)
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
