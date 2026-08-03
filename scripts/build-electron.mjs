#!/usr/bin/env node
// Bundles the Electron main and preload scripts to CommonJS in dist-electron/.
// CJS keeps preload/main on the rock-solid Electron path (no ESM loader edge
// cases) while the renderer stays modern ESM through Vite.
import { build } from 'esbuild'

const dev = process.argv.includes('--dev')

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // Electron and Node built-ins are provided by the runtime, never bundled.
  external: ['electron', 'electron-updater'],
  sourcemap: dev,
  minify: !dev,
  logLevel: 'info',
}

await Promise.all([
  build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' }),
  build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' }),
  // The native inference host stays ESM so its dynamic imports of the Sherpa
  // addon and model runtime resolve natively from node_modules (never bundled
  // — native addons and their companion DLLs must load from disk).
  build({
    ...common,
    format: 'esm',
    entryPoints: ['electron/tts-host.ts'],
    outfile: 'dist-electron/tts-host.mjs',
    external: ['electron', 'onnxruntime-node', '@huggingface/transformers', 'kokoro-js', 'phonemizer', 'sherpa-onnx-node', 'sherpa-onnx-win-x64'],
  }),
])

console.log('Built Electron main + preload + tts-host → dist-electron/')
