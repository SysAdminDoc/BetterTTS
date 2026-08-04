import { describe, expect, it } from 'vitest'
import {
  clearWebGpuAdapterDenylist,
  detectCrossOriginStorage,
  denylistWebGpuAdapter,
  probeWebGpuCapability,
  readWebGpuAdapterDenylist,
  transformersUpgradeReadiness,
} from './runtime-readiness.ts'

describe('WebGPU capability and adapter recovery', () => {
  it('uses the cross-browser adapter probe and captures adapter identity', async () => {
    const result = await probeWebGpuCapability({
      gpu: {
        requestAdapter: async (options) => {
          expect(options).toBeUndefined()
          return { info: { vendor: 'nvidia', architecture: 'lovelace', device: 'RTX test' } }
        },
      },
    })

    expect(result).toMatchObject({
      supported: true,
      adapterAvailable: true,
      usable: true,
      denylisted: false,
      status: 'adapter available',
    })
    expect(result.adapterInfo).toMatchObject({ vendor: 'nvidia', architecture: 'lovelace' })
    expect(result.adapterKey).toContain('vendor=nvidia')
  })

  it('falls back when the browser rejects the optional adapter dictionary and blocks only reported adapters', async () => {
    clearWebGpuAdapterDenylist()
    let calls = 0
    const navigatorLike = {
      gpu: {
        requestAdapter: async () => {
          calls += 1
          if (calls === 1) throw new Error('dictionary unsupported')
          return { info: { vendor: 'apple', architecture: 'apple-gpu', device: 'Safari test' } }
        },
      },
    }

    const first = await probeWebGpuCapability(navigatorLike)
    expect(first.usable).toBe(true)
    expect(calls).toBe(2)
    expect(denylistWebGpuAdapter(first.adapterKey, first.adapterInfo, 'bad audio', new Date('2026-08-03T00:00:00.000Z'))).toBe(true)

    const blocked = await probeWebGpuCapability(navigatorLike)
    expect(blocked.adapterAvailable).toBe(true)
    expect(blocked.usable).toBe(false)
    expect(blocked.denylisted).toBe(true)
    expect(blocked.status).toBe('adapter denylisted')
    expect(readWebGpuAdapterDenylist()).toHaveLength(1)

    clearWebGpuAdapterDenylist(first.adapterKey)
    expect((await probeWebGpuCapability(navigatorLike)).usable).toBe(true)
  })
})

describe('Cross-Origin Storage detection', () => {
  it('keeps the default cache path when the experimental API is absent', () => {
    const status = detectCrossOriginStorage({ navigator: {}, secureContext: true })

    expect(status.usable).toBe(false)
    expect(status.exposed).toBe(false)
    expect(status.defaultBehavior).toBe('disabled')
    expect(status.message).toContain('per-origin Cache API')
  })

  it('recognizes the proposed requestFileHandle surface without invoking it', () => {
    let called = false
    const status = detectCrossOriginStorage({
      navigator: {
        crossOriginStorage: {
          requestFileHandle: () => {
            called = true
          },
        },
      },
      secureContext: true,
    })

    expect(status.usable).toBe(true)
    expect(status.requestFileHandle).toBe(true)
    expect(status.defaultBehavior).toBe('disabled')
    expect(called).toBe(false)
  })
})

describe('Transformers.js upgrade readiness', () => {
  it('keeps the current 4.2 runtime gated from the 4.3 target', () => {
    const readiness = transformersUpgradeReadiness()

    expect(readiness.currentVersion).toBe('4.2.0')
    expect(readiness.targetVersion).toBe('4.3.0')
    expect(readiness.readyToSwitch).toBe(false)
    expect(readiness.criteria.find((criterion) => criterion.id === 'candidate-version')?.met).toBe(false)
    expect(readiness.criteria.find((criterion) => criterion.id === 'engine-suite')?.met).toBe(false)
  })

  it('marks a candidate ready only after the engine compatibility suite passes', () => {
    expect(transformersUpgradeReadiness({
      currentVersion: '4.3.0',
      candidateEngineSuitePassed: false,
    }).readyToSwitch).toBe(false)

    expect(transformersUpgradeReadiness({
      currentVersion: '4.3.1',
      candidateEngineSuitePassed: true,
    }).readyToSwitch).toBe(true)
  })
})
