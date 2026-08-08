import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  evaluateQwenResourcePreflight,
  QWEN_MODEL_REVISION,
  QWEN_QWEN_VERSION,
  QWEN_TORCH_VERSION,
  readQwenRuntimeManifest,
  validateQwenInstallReport,
} from './qwen-runtime.ts'

const manifestPath = resolve(process.cwd(), 'sidecar/qwen-runtime-manifest.json')
const requirementsPath = resolve(process.cwd(), 'sidecar/requirements-qwen.txt')

describe('Qwen runtime contract', () => {
  it('loads the platform lock and verifies the requirements digest', () => {
    const manifest = readQwenRuntimeManifest(manifestPath, requirementsPath)
    expect(manifest.model.revision).toBe(QWEN_MODEL_REVISION)
    expect(manifest.packages).toEqual({ qwenTts: QWEN_QWEN_VERSION, torch: QWEN_TORCH_VERSION })
  })

  it('requires the pinned direct wheel hashes in the pip report', () => {
    const manifest = readQwenRuntimeManifest(manifestPath, requirementsPath)
    const report = {
      install: manifest.wheels.map((wheel) => ({
        metadata: { name: wheel.distribution, version: wheel.version },
        download_info: { archive_info: { hashes: { sha256: wheel.sha256 } } },
      })),
    }
    expect(() => validateQwenInstallReport(report, manifest)).not.toThrow()
    const tampered = structuredClone(report)
    tampered.install[1].download_info.archive_info.hashes.sha256 = '0'.repeat(64)
    expect(() => validateQwenInstallReport(tampered, manifest)).toThrow(/wheel verification failed/u)
  })

  it('blocks setup when disk or memory headroom is below the contract', () => {
    expect(evaluateQwenResourcePreflight({ freeDiskBytes: 1, freeMemoryBytes: 1, gpuAvailable: false })).toMatchObject({
      ok: false,
      gpuAvailable: false,
      issues: expect.arrayContaining([
        expect.stringContaining('free disk'),
        expect.stringContaining('available memory'),
      ]),
    })
    expect(evaluateQwenResourcePreflight({ freeDiskBytes: 8 * 1024 ** 3, freeMemoryBytes: 8 * 1024 ** 3, gpuAvailable: false }).ok).toBe(true)
  })
})
