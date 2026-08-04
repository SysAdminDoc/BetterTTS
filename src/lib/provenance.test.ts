import { describe, expect, it } from 'vitest'
import { DEFAULT_CLEANUP, DEFAULT_PUNCTUATION_PAUSES } from './text.ts'
import { migrateGenerationProvenance as migratePersistedGenerationProvenance } from './provenance-migration.ts'
import {
  PROVENANCE_CUE_SCHEMA_VERSION,
  PROVENANCE_SCHEMA_VERSION,
  createGenerationProvenance,
  createLegacyProvenanceManifest,
  migrateGenerationProvenance,
  provenanceReplayWarning,
  updateProvenanceCueSummary,
} from './provenance.ts'

const input = {
  appVersion: '0.23.0',
  runtime: { target: 'desktop' as const, label: 'Sherpa-ONNX CPU', platform: 'Windows' },
  engine: { id: 'kokoro', modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX', modelRevision: 'revision-a' },
  voiceId: 'af_heart',
  locale: 'en-us',
  speed: 1.1,
  pitchSemitones: 2,
  cleanup: DEFAULT_CLEANUP,
  punctuationPauses: DEFAULT_PUNCTUATION_PAUSES,
  audioCleanupMode: 'studio' as const,
  pronunciations: { API: { replacement: 'A P I', mode: 'respelling' as const } },
  backgroundMusic: { enabled: true, volume: 0.25, duckEnabled: true, duckDepth: 0.6 },
  encoder: {
    format: 'mp3' as const,
    container: 'MP3',
    codec: 'MPEG Layer III',
    encoder: 'lamejs',
    bitrate: 160000,
    sampleRate: 24000,
    loudnessPreset: 'audiobook-mono' as const,
    loudnessTarget: -19,
  },
  sourceText: 'Private source text.',
  source: { kind: 'article' as const, documentId: 'reader-1', title: 'Private article', articleUrl: 'https://example.test/private' },
  cueCount: 4,
  cueTiming: 'word' as const,
}

describe('generation provenance', () => {
  it('records bounded generation details while keeping source text and URLs opt-in', async () => {
    const manifest = await createGenerationProvenance(input)

    expect(manifest).toMatchObject({
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      app: { name: 'BetterTTS', version: '0.23.0' },
      runtime: { target: 'desktop', label: 'Sherpa-ONNX CPU' },
      engine: { id: 'kokoro', modelRevision: 'revision-a' },
      voice: { id: 'af_heart', locale: 'en-us' },
      synthesis: { speed: 1.1, pitchSemitones: 2 },
      cleanup: { audioMode: 'studio' },
      pronunciation: { enabled: true, entryCount: 1, phonemeEntryCount: 0 },
      backgroundMusic: { enabled: true, volume: 0.25, duckEnabled: true, duckDepth: 0.6 },
      encoder: { format: 'mp3', bitrate: 160000, loudnessTarget: -19 },
      source: { kind: 'article', documentId: 'reader-1', title: 'Private article' },
      cues: { schemaVersion: PROVENANCE_CUE_SCHEMA_VERSION, count: 4, timing: 'word' },
    })
    expect(manifest.source.textHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(manifest.source).not.toHaveProperty('text')
    expect(manifest.source).not.toHaveProperty('articleUrl')

    const optedIn = await createGenerationProvenance({ ...input, includeSourceText: true, includeArticleUrl: true })
    expect(optedIn.source.text).toBe('Private source text.')
    expect(optedIn.source.articleUrl).toBe('https://example.test/private')
  })

  it('migrates absent and version-zero manifests to an explicit replay warning', () => {
    const legacy = migrateGenerationProvenance(undefined, { voice: 'af_heart', speed: 1, format: 'wav' })
    expect(legacy?.legacy).toBe(true)
    expect(provenanceReplayWarning(legacy)).toContain('incomplete generation provenance')

    const migrated = migrateGenerationProvenance({
      schemaVersion: 0,
      engineId: 'kokoro',
      modelId: 'old-model',
      modelRevision: 'old-revision',
      voiceId: 'af_bella',
    })
    expect(migrated).toMatchObject({
      legacy: true,
      engine: { id: 'kokoro', modelId: 'old-model', modelRevision: 'old-revision' },
      voice: { id: 'af_bella' },
    })
  })

  it('warns for engine/model/runtime drift and updates cue summaries for exports', async () => {
    const manifest = await createGenerationProvenance(input)
    expect(provenanceReplayWarning(manifest, {
      engineId: 'supertonic',
      modelId: 'other-model',
      modelRevision: 'other-revision',
      runtimeLabel: 'WebAssembly q8',
    })).toContain('current engine')
    expect(provenanceReplayWarning(manifest, {
      engineId: 'kokoro',
      modelId: input.engine.modelId,
      modelRevision: 'other-revision',
      runtimeLabel: input.runtime.label,
    })).toContain('model revision')

    const updated = updateProvenanceCueSummary(manifest, 12, 'sentence')
    expect(updated.cues).toEqual({ schemaVersion: PROVENANCE_CUE_SCHEMA_VERSION, count: 12, timing: 'sentence' })
    expect(updated.source.textHash).toBe(manifest.source.textHash)
  })

  it('creates a deterministic legacy manifest without inventing source details', () => {
    const manifest = createLegacyProvenanceManifest({ createdAt: 1000, voice: 'af_heart', speed: 1.2, format: 'opus' })
    expect(manifest.encoder.format).toBe('opus')
    expect(manifest.source).toEqual({ textHash: null, kind: 'unknown' })
    expect(manifest.legacy).toBe(true)
  })

  it('migrates persisted schema-zero records while retaining historical identity', () => {
    const manifest = migratePersistedGenerationProvenance({
      schemaVersion: 0,
      engineId: 'kokoro',
      modelId: 'old-model',
      modelRevision: 'old-revision',
      voiceId: 'af_bella',
    })
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      legacy: true,
      engine: { id: 'kokoro', modelId: 'old-model', modelRevision: 'old-revision' },
      voice: { id: 'af_bella' },
    })
  })
})
