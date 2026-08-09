import { describe, expect, it } from 'vitest'
import { DEFAULT_CLEANUP, DEFAULT_PUNCTUATION_PAUSES } from './text.ts'
import { migrateGenerationProvenance as migratePersistedGenerationProvenance } from './provenance-migration.ts'
import {
  PROVENANCE_CUE_SCHEMA_VERSION,
  PROVENANCE_SCHEMA_VERSION,
  createGenerationProvenance,
  createLegacyProvenanceManifest,
  createProvenanceEngine,
  migrateGenerationProvenance,
  provenanceReplayWarning,
  updateProvenanceCueSummary,
} from './provenance.ts'

const input = {
  appVersion: '0.24.0',
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
  it('derives immutable model and runtime identities from the capability manifest', () => {
    expect(createProvenanceEngine('supertonic')).toMatchObject({
      modelId: 'onnx-community/Supertonic-TTS-ONNX',
      modelRevision: 'cff123c84b0655d9d647641f1b532c3cbb8f7faa',
      modelSourceUrl: 'https://huggingface.co/onnx-community/Supertonic-TTS-ONNX/tree/cff123c84b0655d9d647641f1b532c3cbb8f7faa',
      runtimeIdentities: [expect.objectContaining({ id: 'transformers-browser', kind: 'npm' })],
    })
    expect(createProvenanceEngine('chatterbox', 'multilingual')).toMatchObject({
      modelId: 'onnx-community/chatterbox-multilingual-ONNX',
      modelRevision: '452d3f434aa592098f1eedac9099f33642ab2da5',
    })
    expect(createProvenanceEngine('kitten', 'english', 'browser', 'mini')).toMatchObject({
      modelId: 'KittenML/kitten-tts-mini-0.8',
      modelRevision: 'c02725660cea441db4c383af69f1f26f5cd00947',
    })
    expect(createProvenanceEngine('piper', 'english', 'native')).toMatchObject({
      modelId: 'csukuangfj/vits-piper-en_GB-cori-medium',
      modelRevision: 'e304c95c578725ba9cab0cff451c4e5d9aaf889e',
      runtimeIdentities: [expect.objectContaining({ id: 'sherpa-native' })],
    })
    expect(createProvenanceEngine('qwen', 'english', 'sidecar')).toMatchObject({
      modelRevision: '85e237c12c027371202489a0ec509ded67b5e4b5',
      runtimeIdentities: [expect.objectContaining({ id: 'qwen-sidecar', manifestSha256: expect.any(String) })],
    })
    expect(createProvenanceEngine('browser')).toMatchObject({
      modelRevision: '8307ee199cbcaa8a26f6d86663b9d803d1cc8d0f',
      runtimeIdentities: [expect.objectContaining({ id: 'web-speech-api', kind: 'platform' })],
    })
  })

  it('records bounded generation details while keeping source text and URLs opt-in', async () => {
    const manifest = await createGenerationProvenance(input)

    expect(manifest).toMatchObject({
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      app: { name: 'BetterTTS', version: '0.24.0' },
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

  it('exports voice source, acknowledgement, and model watermark status', async () => {
    const manifest = await createGenerationProvenance({
      ...input,
      voiceProvenance: {
        source: 'cloned',
        sourceId: 'reference-a',
        sourceName: 'speaker.wav',
        sourceDurationSeconds: 4.25,
        modelId: 'onnx-community/chatterbox-ONNX',
        modelLabel: 'Chatterbox English',
        modelLicense: 'MIT',
        consent: { required: true, acknowledged: true, acknowledgedAt: '2026-08-03T12:00:00.000Z' },
        watermark: { status: 'retained', label: 'PerTh', modelId: 'onnx-community/chatterbox-ONNX' },
      },
      rvc: {
        stage: 'rvc',
        enabled: true,
        modelCount: 1,
        pitchSemitones: 0,
        indexRate: 0.5,
        consentAcknowledgedAt: '2026-08-03T12:00:00.000Z',
        models: [{ id: 'rvc-a', name: 'RVC A', license: 'MIT', provenance: 'Local', acknowledgedAt: '2026-08-03T12:00:00.000Z' }],
      },
    })
    expect(manifest.schemaVersion).toBe(PROVENANCE_SCHEMA_VERSION)
    expect(manifest.voice).toMatchObject({
      provenanceSchemaVersion: 1,
      source: 'cloned',
      sourceId: 'reference-a',
      consent: { required: true, acknowledged: true, acknowledgedAt: '2026-08-03T12:00:00.000Z' },
      watermark: { status: 'retained', label: 'PerTh' },
    })
    expect(manifest.rvc).toMatchObject({
      stage: 'rvc',
      consentAcknowledgedAt: '2026-08-03T12:00:00.000Z',
      models: [{ id: 'rvc-a', acknowledgedAt: '2026-08-03T12:00:00.000Z' }],
    })
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

  it('migrates schema-two manifests without inventing a watermark or consent claim', async () => {
    const current = await createGenerationProvenance(input)
    const old = {
      ...current,
      schemaVersion: 2,
      voice: { id: current.voice.id, locale: current.voice.locale },
    }
    const migrated = migrateGenerationProvenance(old)
    expect(migrated).toMatchObject({
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      voice: {
        source: 'unknown',
        consent: { required: false, acknowledged: false },
        watermark: { status: 'unknown' },
      },
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
      schemaVersion: 3,
      legacy: true,
      engine: { id: 'kokoro', modelId: 'old-model', modelRevision: 'old-revision' },
      voice: { id: 'af_bella' },
    })
  })
})
