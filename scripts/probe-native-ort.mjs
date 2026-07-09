#!/usr/bin/env node
// TF-99 de-risking probe: proves native ONNX Runtime (onnxruntime-node) can load
// the real Kokoro q8 graph on THIS machine, reports which execution provider it
// bound (DirectML → CPU fallback), the model I/O signature, and a forward-pass
// latency for a small token sequence. This is the "confirm native beats WASM
// before wiring the UI" step from the roadmap; it does not do phonemization yet.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import ort from 'onnxruntime-node'

const require = createRequire(import.meta.url)

function ortVersion() {
  try {
    return require('onnxruntime-node/package.json').version
  } catch {
    return 'unknown'
  }
}

const modelPath = process.argv[2]
  ?? 'dist/models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx'

if (!existsSync(modelPath)) {
  console.error(`Model not found: ${modelPath}\nRun "npm run sync:kokoro" first (populates dist/models/).`)
  process.exit(2)
}

console.log(`onnxruntime-node ${ortVersion()}  ·  model ${modelPath}`)

// Try providers strongest-first; report the one that actually binds. An
// optional 3rd arg forces a single provider (e.g. `... <model> cpu`).
const candidates = process.argv[3] ? [process.argv[3]] : ['dml', 'cuda', 'cpu']
let session = null
let boundProvider = null
for (const ep of candidates) {
  try {
    const t0 = performance.now()
    session = await ort.InferenceSession.create(modelPath, { executionProviders: [ep] })
    boundProvider = ep
    console.log(`Loaded with execution provider "${ep}" in ${(performance.now() - t0).toFixed(0)} ms`)
    break
  } catch (err) {
    console.log(`  provider "${ep}" unavailable: ${err instanceof Error ? err.message.split('\n')[0] : err}`)
  }
}

if (!session) {
  console.error('Failed to create an inference session with any provider.')
  process.exit(1)
}

console.log(`inputs:  ${session.inputNames.join(', ')}`)
console.log(`outputs: ${session.outputNames.join(', ')}`)

// Kokoro v1.0 ONNX signature: input_ids int64 [1, N], style float32 [1, 256],
// speed float32 [1]. Valid-shape dummy inputs exercise the real forward pass so
// we can time it; audio content is meaningless without phonemization (next step).
try {
  const seqLen = 12
  const inputIds = new ort.Tensor('int64', BigInt64Array.from({ length: seqLen }, (_, i) => BigInt(i === 0 || i === seqLen - 1 ? 0 : 16 + i)), [1, seqLen])
  const style = new ort.Tensor('float32', new Float32Array(256), [1, 256])
  const speed = new ort.Tensor('float32', new Float32Array([1]), [1])

  const feeds = {}
  if (session.inputNames.includes('input_ids')) feeds.input_ids = inputIds
  if (session.inputNames.includes('style')) feeds.style = style
  if (session.inputNames.includes('speed')) feeds.speed = speed

  if (Object.keys(feeds).length === session.inputNames.length) {
    const t0 = performance.now()
    const out = await session.run(feeds)
    const ms = performance.now() - t0
    const key = session.outputNames[0]
    const len = out[key]?.data?.length ?? 0
    console.log(`forward pass: ${ms.toFixed(0)} ms → output "${key}" length ${len}`)
    console.log(JSON.stringify({ ok: true, provider: boundProvider, ort: ortVersion(), inferenceMs: Math.round(ms), outputSamples: len }))
  } else {
    console.log('Skipped forward pass — model input names differ from the expected Kokoro signature (see inputs above).')
    console.log(JSON.stringify({ ok: true, provider: boundProvider, ort: ortVersion(), forwardPass: 'skipped', inputs: session.inputNames }))
  }
} catch (err) {
  console.log(`forward pass failed (load still proves native ORT works): ${err instanceof Error ? err.message.split('\n')[0] : err}`)
  console.log(JSON.stringify({ ok: true, provider: boundProvider, ort: ortVersion(), forwardPass: 'failed' }))
}
