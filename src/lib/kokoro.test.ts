import { describe, expect, it } from 'vitest'
import { parseKokoroWebGpuDtype } from './kokoro.ts'

describe('Kokoro WebGPU dtype settings', () => {
  it('defaults malformed or missing storage values to fp32', () => {
    expect(parseKokoroWebGpuDtype(null)).toBe('fp32')
    expect(parseKokoroWebGpuDtype('q8')).toBe('fp32')
    expect(parseKokoroWebGpuDtype('FP16')).toBe('fp32')
  })

  it('accepts the explicit fp16 opt-in', () => {
    expect(parseKokoroWebGpuDtype('fp16')).toBe('fp16')
  })
})
