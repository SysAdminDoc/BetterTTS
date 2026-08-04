import { describe, expect, it } from 'vitest'
import {
  ENGINE_MANIFEST_SCHEMA_VERSION,
  EngineAdapterRegistry,
  defineEngineAdapter,
  validateEngineManifest,
  type EngineManifest,
} from './engine-adapter.ts'

const SAMPLE_MANIFEST: EngineManifest = {
  schemaVersion: ENGINE_MANIFEST_SCHEMA_VERSION,
  id: 'sample-local',
  label: 'Sample local adapter',
  runtime: ['native'],
  license: { spdx: 'MIT', tier: 'permissive', url: 'https://example.com/license' },
  modelFiles: [{
    path: 'sample.onnx',
    source: 'local',
    sizeBytes: 4,
    sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }],
  hardware: { platforms: ['windows'], accelerators: ['cpu'] },
  capabilities: { queue: true, streaming: false, timestamps: false, exportFormats: ['wav', 'mp3'] },
  safetyTier: 'standard',
  consentRequired: false,
  diagnostics: { fields: ['runtime', 'model', 'license', 'hardware', 'error'], redactPaths: true },
}

describe('engine adapter SDK', () => {
  it('validates a complete local manifest and normalizes digest casing', () => {
    const manifest = validateEngineManifest({
      ...SAMPLE_MANIFEST,
      modelFiles: [{ ...SAMPLE_MANIFEST.modelFiles[0], sha256: SAMPLE_MANIFEST.modelFiles[0].sha256.toUpperCase() }],
    })

    expect(manifest.id).toBe('sample-local')
    expect(manifest.modelFiles[0].sha256).toBe(SAMPLE_MANIFEST.modelFiles[0].sha256)
  })

  it('registers and runs a sample adapter without an AppShell integration', async () => {
    type Session = { sampleRate: number }
    const adapter = defineEngineAdapter<Session>(SAMPLE_MANIFEST, {
      probe: ({ platform, accelerators }) => ({
        available: platform === 'windows' && accelerators.includes('cpu'),
        diagnostics: { adapter: 'sample-local' },
      }),
      load: async (context) => {
        context.reportProgress?.({ stage: 'load', progress: 1 })
        return { sampleRate: 22050 }
      },
      synthesize: async (session, request, context) => {
        context.reportProgress?.({ stage: 'synthesize', progress: 1 })
        return { samples: new Float32Array([request.text.length * request.speed]), sampleRate: session.sampleRate }
      },
    })
    const registry = new EngineAdapterRegistry().register(adapter)
    const registered = registry.get('sample-local')

    expect(registered?.manifest.capabilities.queue).toBe(true)
    expect(adapter.probe({ platform: 'windows', accelerators: ['cpu'] }).available).toBe(true)
    const session = await adapter.load({ platform: 'windows', accelerators: ['cpu'] })
    await expect(adapter.synthesize(session, { text: 'hello', voice: 'default', speed: 1 }, { platform: 'windows', accelerators: ['cpu'] })).resolves.toEqual({
      samples: new Float32Array([5]),
      sampleRate: 22050,
    })
  })

  it('rejects mutable remote files, unsafe paths, and duplicate adapters', () => {
    expect(() => validateEngineManifest({
      ...SAMPLE_MANIFEST,
      modelFiles: [{ ...SAMPLE_MANIFEST.modelFiles[0], source: 'remote', revision: 'main' }],
    })).toThrow(/immutable revision/)
    expect(() => validateEngineManifest({
      ...SAMPLE_MANIFEST,
      modelFiles: [{ ...SAMPLE_MANIFEST.modelFiles[0], path: '../sample.onnx' }],
    })).toThrow(/safe relative path/)

    const adapter = defineEngineAdapter(SAMPLE_MANIFEST, {
      probe: () => ({ available: true }),
      load: async () => ({}),
      synthesize: async () => ({ samples: new Float32Array(), sampleRate: 1 }),
    })
    const registry = new EngineAdapterRegistry().register(adapter)
    expect(() => registry.register(adapter)).toThrow(/already registered/)
  })
})
