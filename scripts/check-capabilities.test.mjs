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
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.app.name).toBe('BetterTTS')
    expect(manifest.runtimeIdentities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'qwen-sidecar', revision: expect.stringMatching(/^manifest-sha256:/u) }),
      expect.objectContaining({ id: 'web-speech-api', revision: expect.stringMatching(/^source-revision:/u) }),
    ]))
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

  it('rejects mutable model revisions instead of allowing release metadata to drift', () => {
    const manifest = readCapabilities()
    manifest.models.find((model) => model.id === 'supertonic').revision = 'main'
    expect(() => validateCapabilities(manifest)).toThrow('immutable revision')
  })

  it('rejects runtime package identities that no longer match the lockfile', () => {
    const manifest = readCapabilities()
    manifest.runtimeIdentities.find((runtime) => runtime.id === 'transformers-browser').packages[0].version = 'main'
    expect(() => validateCapabilities(manifest)).toThrow('stale against package-lock.json')
  })

  it('counts the repository test files without including build output', () => {
    const files = discoverTestFiles()
    expect(files.length).toBeGreaterThan(80)
    expect(files.some((file) => file.endsWith('check-capabilities.test.mjs'))).toBe(true)
    expect(files.some((file) => file.includes('node_modules'))).toBe(false)
  })
})
