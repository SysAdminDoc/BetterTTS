import type { GenerationProvenanceManifest } from './provenance.ts'

export type { GenerationProvenanceManifest } from './provenance.ts'

const HASH_PATTERN = /^[a-f0-9]{64}$/iu

export function migrateGenerationProvenance(raw: unknown): GenerationProvenanceManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  if (candidate.schemaVersion === 1) {
    const app = record(candidate.app)
    const engine = record(candidate.engine)
    const source = record(candidate.source)
    const textHash = source?.textHash
    if (
      app?.name !== 'BetterTTS'
      || !engine || !source
      || !nonEmpty(engine.id) || !nonEmpty(engine.modelId) || !nonEmpty(engine.modelRevision)
      || (textHash !== null && !hash(textHash))
    ) return null
    return candidate as unknown as GenerationProvenanceManifest
  }
  return candidate.schemaVersion === 0 || candidate.version === 0 ? legacyManifest(candidate) : null
}

function legacyManifest(candidate: Record<string, unknown>): GenerationProvenanceManifest {
  const oldEngine = record(candidate.engine)
  const oldVoice = record(candidate.voice)
  const emptyCleanup = { citations: false, urls: false, acronyms: false, markdown: false, footnotes: false, pageArtifacts: false, pdfReflow: false, numbers: false, metadata: false }
  const emptyPauses = { comma: 0, semicolon: 0, colon: 0, period: 0, question: 0, exclamation: 0, ellipsis: 0, emDash: 0 }
  return {
    schemaVersion: 1,
    createdAt: new Date(0).toISOString(),
    app: { name: 'BetterTTS', version: 'unknown' },
    runtime: { target: 'web', label: 'unknown', platform: 'unknown' },
    engine: {
      id: stringOrUnknown(candidate.engineId ?? oldEngine?.id),
      modelId: stringOrUnknown(candidate.modelId ?? record(candidate.model)?.id),
      modelRevision: stringOrUnknown(candidate.modelRevision ?? record(candidate.model)?.revision),
    },
    voice: { id: stringOrUnknown(candidate.voiceId ?? oldVoice?.id ?? candidate.voice) },
    synthesis: { speed: 1, pitchSemitones: 0 },
    cleanup: { text: emptyCleanup, punctuationPauses: emptyPauses, audioMode: 'off' },
    pronunciation: { enabled: false, entryCount: 0, phonemeEntryCount: 0, dictionaryHash: '' },
    backgroundMusic: { enabled: false, volume: 0, duckEnabled: false, duckDepth: 0 },
    encoder: { format: 'wav', container: 'unknown', codec: 'unknown', encoder: 'unknown', bitrate: 0, sampleRate: 0, loudnessPreset: 'off', loudnessTarget: null },
    source: { textHash: null, kind: 'unknown' },
    cues: { schemaVersion: 1, count: 0, timing: 'none' },
    legacy: true,
  }
}

function hash(value: unknown): boolean {
  return typeof value === 'string' && HASH_PATTERN.test(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function stringOrUnknown(value: unknown): string {
  return nonEmpty(value) ? value.slice(0, 300) : 'unknown'
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
