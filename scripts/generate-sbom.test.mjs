import { describe, expect, it } from 'vitest'
import { buildSbom, CYCLONEDX_SPEC_VERSION, validateSbom } from './generate-sbom.mjs'

describe('CycloneDX release SBOM', () => {
  it('covers the runtime license table, capability models, and pinned model files', () => {
    const bom = buildSbom()
    const runtimePackages = bom.components.filter((component) => component.type === 'library')
    const models = bom.components.filter((component) => component.type === 'machine-learning-model')
    const files = bom.components.filter((component) => component.type === 'file')

    expect(bom.specVersion).toBe(CYCLONEDX_SPEC_VERSION)
    expect(runtimePackages.length).toBeGreaterThan(100)
    expect(new Set(runtimePackages
      .filter((component) => component.properties?.some((entry) => entry.name === 'bettertts:runtime-direct' && entry.value === 'true'))
      .map((component) => component.name)).size).toBe(21)
    expect(models).toHaveLength(11)
    expect(files.length).toBeGreaterThan(30)
    expect(files.every((component) => component.hashes?.some((hash) => hash.alg === 'SHA-256'))).toBe(true)
    expect(files.some((component) => component.properties?.some((entry) => entry.value === 'github-pages-model-cache'))).toBe(true)
    expect(files.some((component) => component.properties?.some((entry) => entry.value === 'windows-native-sherpa-cache'))).toBe(true)
  })

  it('is deterministic and rejects missing runtime or model inventory entries', () => {
    const first = buildSbom()
    const second = buildSbom()
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))

    const missingRuntime = structuredClone(first)
    missingRuntime.components.splice(missingRuntime.components.findIndex((component) => component.type === 'library'), 1)
    expect(() => validateSbom(missingRuntime)).toThrow('runtime package inventory mismatch')

    const missingModelFile = structuredClone(first)
    missingModelFile.components.splice(missingModelFile.components.findIndex((component) => component.type === 'file'), 1)
    expect(() => validateSbom(missingModelFile)).toThrow('model file inventory mismatch')
  })
})
