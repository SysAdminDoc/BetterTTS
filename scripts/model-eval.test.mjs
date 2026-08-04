import { describe, expect, it } from 'vitest'
import { EVAL_PROMPTS, MODEL_EVAL_SCHEMA_VERSION, runCandidate, runEvaluation, validateCandidateManifest } from './model-eval.mjs'

const CANDIDATE = {
  schemaVersion: MODEL_EVAL_SCHEMA_VERSION,
  id: 'sample-eval',
  label: 'Sample evaluation adapter',
  provider: 'local-test',
  runtime: 'test',
  modelId: 'sample/model',
  license: { spdx: 'MIT', tier: 'permissive' },
  modelFiles: [{ path: 'model.bin', sizeBytes: 4, sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
  command: { executable: process.execPath, args: [] },
}

describe('local model evaluation harness', () => {
  it('validates a candidate manifest and fixed prompt suite', () => {
    const candidate = validateCandidateManifest(CANDIDATE)
    expect(candidate.maxRtf).toBe(5)
    expect(EVAL_PROMPTS).toHaveLength(4)
    expect(() => validateCandidateManifest({ ...CANDIDATE, license: { spdx: 'MIT', tier: 'permissive' }, modelFiles: [{ ...CANDIDATE.modelFiles[0], path: '../model.bin' }] })).toThrow(/unsafe/)
    expect(() => validateCandidateManifest({ ...CANDIDATE, modelFiles: [{ ...CANDIDATE.modelFiles[0], revision: 'main' }] })).toThrow(/immutable/)
  })

  it('records RTF, duration, memory, VRAM, model size, and passes a permissive candidate', async () => {
    let clock = 0
    const report = await runEvaluation({
      candidate: validateCandidateManifest(CANDIDATE),
      now: () => (clock += 100),
      execute: async () => ({ durationSeconds: 1, sampleRate: 24_000, memoryBytes: 2_000, vramBytes: 3_000 }),
    })

    expect(report.passed).toBe(true)
    expect(report.modelSizeBytes).toBe(4)
    expect(report.modelFilesPresent).toBeNull()
    expect(report.summary).toMatchObject({ successful: 4, failed: 0, averageRtf: 0.1, maxRtf: 0.1, peakMemoryBytes: 2_000, peakVramBytes: 3_000 })
  })

  it('executes the documented local JSON-lines protocol without a shell', async () => {
    const candidate = validateCandidateManifest({
      ...CANDIDATE,
      command: {
        executable: process.execPath,
        args: ['-e', "const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);if(m.type==='synthesize')console.log(JSON.stringify({id:m.id,durationSeconds:1,sampleRate:24000}));if(m.type==='shutdown')process.exit(0)})"],
      },
    })

    await expect(runCandidate(EVAL_PROMPTS[0], candidate, 5_000)).resolves.toMatchObject({ durationSeconds: 1, sampleRate: 24_000 })
  })

  it('fails restricted candidates and preserves per-prompt failure modes', async () => {
    const report = await runEvaluation({
      candidate: validateCandidateManifest({ ...CANDIDATE, license: { spdx: 'CC-BY-NC-4.0', tier: 'non-commercial' } }),
      execute: async (prompt) => {
        if (prompt.id === 'numbers') throw new Error('candidate model unavailable')
        return { durationSeconds: 1, sampleRate: 24_000 }
      },
    })

    expect(report.passed).toBe(false)
    expect(report.summary.failureModes).toEqual(['model'])
    expect(report.prompts.find((prompt) => prompt.id === 'numbers')).toMatchObject({ ok: false, failureMode: 'model' })
  })
})
