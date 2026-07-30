import { describe, expect, it, vi } from 'vitest'
import { NativeModelPackError, type PackStatus } from './native-models.ts'
import {
  DEV_MODEL_FALLBACK_ENV,
  PACKAGED_APP_ENV,
  NativePackLoadError,
  classifyNativePackFailure,
  devModelFallbackAllowed,
  initializeNativeRuntimeWithPack,
} from './native-pack-policy.ts'

const status: PackStatus = {
  id: 'test',
  modelId: 'acme/model',
  revision: 'a'.repeat(40),
  version: '1',
  license: { spdx: 'Apache-2.0', tier: 'permissive' },
  installed: false,
  verified: false,
  totalBytes: 0,
  expectedBytes: 1,
  files: [],
  blockedReason: null,
}

describe('native model pack load policy', () => {
  it.each([
    ['integrity', new NativeModelPackError('integrity', 'checksum mismatch')],
    ['license', new NativeModelPackError('license', 'license blocked')],
    ['unavailable', new Error('offline')],
  ] as const)('fails closed on %s errors before runtime creation', async (kind, error) => {
    const createRuntime = vi.fn(async () => ({ loaded: true }))
    const onFailure = vi.fn()

    const result = initializeNativeRuntimeWithPack({
      ensure: async () => {
        throw error
      },
      readStatus: async () => status,
      createRuntime,
      env: {},
      onFailure,
    })

    await expect(result).rejects.toBeInstanceOf(NativePackLoadError)
    await expect(result).rejects.toMatchObject({ failure: { kind } })
    expect(createRuntime).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ kind }), false)
  })

  it('allows mutable fallback only behind the explicit non-packaged development flag', async () => {
    const createRuntime = vi.fn(async (root: string | null) => ({ root }))
    const result = await initializeNativeRuntimeWithPack({
      ensure: async () => {
        throw new Error('offline')
      },
      readStatus: async () => status,
      createRuntime,
      env: {
        [DEV_MODEL_FALLBACK_ENV]: '1',
        [PACKAGED_APP_ENV]: '0',
      },
    })

    expect(result.failure).toEqual({ kind: 'unavailable', message: 'offline' })
    expect(result.modelPack).toBe(status)
    expect(createRuntime).toHaveBeenCalledOnce()
    expect(createRuntime).toHaveBeenCalledWith(null)
  })

  it('ignores the development fallback flag in packaged production', async () => {
    expect(devModelFallbackAllowed({
      [DEV_MODEL_FALLBACK_ENV]: '1',
      [PACKAGED_APP_ENV]: '1',
    })).toBe(false)

    const createRuntime = vi.fn()
    await expect(initializeNativeRuntimeWithPack({
      ensure: async () => {
        throw new NativeModelPackError('integrity', 'tampered')
      },
      readStatus: async () => status,
      createRuntime,
      env: {
        [DEV_MODEL_FALLBACK_ENV]: '1',
        [PACKAGED_APP_ENV]: '1',
      },
    })).rejects.toMatchObject({ failure: { kind: 'integrity' } })
    expect(createRuntime).not.toHaveBeenCalled()
  })

  it('preserves typed pack failures for diagnostics', () => {
    expect(classifyNativePackFailure(new NativeModelPackError('license', 'blocked'))).toEqual({
      kind: 'license',
      message: 'blocked',
    })
  })
})
