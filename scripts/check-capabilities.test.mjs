import { describe, expect, it } from 'vitest'
import {
  discoverTestFiles,
  formatCapabilityFacts,
  readCapabilities,
  validateCapabilities,
} from './check-capabilities.mjs'

describe('capability manifest', () => {
  it('validates the checked-in manifest shape and versioned schema', () => {
    const manifest = validateCapabilities(readCapabilities())
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.app.name).toBe('BetterTTS')
  })

  it('keeps the declared queue engines aligned with engine metadata', () => {
    const manifest = readCapabilities()
    expect(manifest.queue.engines).toEqual(manifest.engines.filter((engine) => engine.queueable).map((engine) => engine.id))
  })

  it('exposes model and runtime license facts in the generated documentation block', () => {
    const block = formatCapabilityFacts(readCapabilities())
    expect(block).toContain('**Runtime licenses:** 21 direct package rows')
    expect(block).toContain('Supertonic ONNX model (OpenRAIL)')
  })

  it('counts the repository test files without including build output', () => {
    const files = discoverTestFiles()
    expect(files.length).toBeGreaterThan(80)
    expect(files.some((file) => file.endsWith('check-capabilities.test.mjs'))).toBe(true)
    expect(files.some((file) => file.includes('node_modules'))).toBe(false)
  })
})
