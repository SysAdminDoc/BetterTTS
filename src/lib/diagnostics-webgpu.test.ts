// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearDiagnosticEvents,
  readWebGpuDiagnostics,
  reportWebGpuBadAudio,
  getRecentDiagnosticEvents,
} from './diagnostics.ts'
import { clearWebGpuAdapterDenylist } from './runtime-readiness.ts'

const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu')

beforeEach(() => {
  window.localStorage.clear()
  clearWebGpuAdapterDenylist()
  clearDiagnosticEvents()
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: {
      requestAdapter: async () => ({
        info: { vendor: 'nvidia', architecture: 'lovelace', device: 'diagnostics-test' },
      }),
    },
  })
})

afterEach(() => {
  clearWebGpuAdapterDenylist()
  clearDiagnosticEvents()
  if (originalGpu) Object.defineProperty(navigator, 'gpu', originalGpu)
  else Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined })
})

describe('WebGPU bad-audio diagnostics', () => {
  it('captures the adapter identity and forces the reported adapter onto WASM', async () => {
    const before = await readWebGpuDiagnostics()
    expect(before.usable).toBe(true)
    expect(before.adapterInfo).toMatchObject({ vendor: 'nvidia', architecture: 'lovelace' })

    const report = await reportWebGpuBadAudio('diagnostic artifact')

    expect(report.recorded).toBe(true)
    expect(report.capability.denylisted).toBe(true)
    expect(report.capability.usable).toBe(false)
    expect(window.localStorage.getItem('bettertts-webgpu-adapter-denylist')).toContain('diagnostics-test')
    expect(getRecentDiagnosticEvents().some((event) => event.source === 'webgpu.bad-audio')).toBe(true)
  })
})
