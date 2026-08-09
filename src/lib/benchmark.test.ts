import { describe, expect, it } from 'vitest'
import {
  BENCHMARK_STORAGE_KEY,
  appendBenchmarkObservation,
  captureBenchmarkResources,
  clearBenchmarkReport,
  createBenchmarkIdentity,
  createBenchmarkObservation,
  emptyBenchmarkReport,
  exportBenchmarkJson,
  readBenchmarkReport,
  type BenchmarkStorage,
} from './benchmark.ts'

function createStorage(): BenchmarkStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

describe('local benchmark reports', () => {
  it('normalizes identity, computes latency/throughput, and excludes source payloads', () => {
    const observation = createBenchmarkObservation({
      identity: {
        engineId: 'kokoro',
        modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
        modelRevision: 'abc123',
        runtimeKind: 'browser',
        runtimeLabel: 'WebAssembly q8',
      },
      elapsedMs: 2_000,
      firstAudioLatencyMs: 810,
      audioDurationSeconds: 3.2,
      inputChars: 120,
      outcome: 'completed',
      retryCount: 1,
      failureCount: 0,
    }, new Date('2026-08-09T00:00:00.000Z'))

    expect(observation.recordedAt).toBe('2026-08-09T00:00:00.000Z')
    expect(observation.metrics).toMatchObject({ throughputCharsPerSecond: 60, realtimeFactor: 1.6 })
    expect(observation.reliability).toMatchObject({ outcome: 'completed', retryCount: 1 })
    const json = exportBenchmarkJson({ ...emptyBenchmarkReport(), observations: [observation] })
    expect(json).toContain('Kokoro-82M-v1.0-ONNX')
    expect(json).not.toMatch(/sourceText|articleUrl|credential|rawAudio|audioData/iu)
  })

  it('redacts URL and credential-like identity labels before export', () => {
    const identity = createBenchmarkIdentity({
      engineId: 'https://example.test/model?token=secret',
      modelId: 'model?api_key=secret',
      runtimeLabel: 'Bearer abc123',
    })
    expect(identity.engineId).toBe('<redacted-url>')
    expect(identity.modelId).toBe('model?api_key=REDACTED')
    expect(identity.runtimeLabel).toBe('REDACTED')
  })

  it('captures only bounded memory and quota observations', async () => {
    const resources = await captureBenchmarkResources({
      navigator: {
        deviceMemory: 16,
        storage: {
          estimate: async () => ({ usage: 25_000, quota: 100_000 }),
          persisted: async () => true,
        },
      },
      performance: {
        memory: { usedJSHeapSize: 2_000, totalJSHeapSize: 4_000, jsHeapSizeLimit: 8_000 },
      },
    })
    expect(resources.memory).toMatchObject({ supported: true, deviceMemoryGb: 16, jsHeapUsedBytes: 2_000 })
    expect(resources.quota).toMatchObject({ supported: true, persisted: true, usageBytes: 25_000, quotaBytes: 100_000, usagePct: 25 })
  })

  it('persists a bounded local history and recovers malformed storage', async () => {
    const storage = createStorage()
    const input = {
      identity: { engineId: 'kokoro', modelId: 'model', modelRevision: 'rev', runtimeKind: 'browser', runtimeLabel: 'WASM' } as const,
      elapsedMs: 1_000,
      audioDurationSeconds: 1,
      inputChars: 10,
      outcome: 'completed' as const,
      resources: {
        memory: { supported: false, deviceMemoryGb: null },
        quota: { supported: false, persisted: null },
      },
    }
    const result = await appendBenchmarkObservation(input, storage)
    expect(result.persisted).toBe(true)
    expect(readBenchmarkReport(storage).observations).toHaveLength(1)
    storage.values.set(BENCHMARK_STORAGE_KEY, '{bad json')
    expect(readBenchmarkReport(storage).observations).toHaveLength(0)
    expect(clearBenchmarkReport(storage)).toBe(true)
    expect(storage.values.has(BENCHMARK_STORAGE_KEY)).toBe(false)
  })
})
