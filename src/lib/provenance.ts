import type { AudioCleanupMode } from '../platform/index.ts'
import type { AudioFormat, LoudnessPresetId } from './encode.ts'
import type { CleanupOptions, PunctuationPauseSettings } from './text.ts'
import type { PronunciationDictionary } from './pronunciations.ts'

export const PROVENANCE_SCHEMA_VERSION = 1 as const
export const PROVENANCE_CUE_SCHEMA_VERSION = 1 as const
const HASH_PATTERN = /^[a-f0-9]{64}$/iu
const MAX_TEXT_CHARS = 5000
const MAX_STRING_CHARS = 300

export type ProvenanceRuntimeTarget = 'web' | 'desktop'
export type ProvenanceCueTiming = 'none' | 'sentence' | 'word'
export type ProvenanceSourceKind = 'text' | 'article' | 'epub' | 'pdf' | 'docx' | 'subtitle' | 'unknown'

export type GenerationProvenanceManifest = {
  schemaVersion: typeof PROVENANCE_SCHEMA_VERSION
  createdAt: string
  app: {
    name: 'BetterTTS'
    version: string
  }
  runtime: {
    target: ProvenanceRuntimeTarget
    label: string
    platform: string
  }
  engine: {
    id: string
    modelId: string
    modelRevision: string
  }
  voice: {
    id: string
    locale?: string
  }
  synthesis: {
    speed: number
    pitchSemitones: number
  }
  cleanup: {
    text: CleanupOptions
    punctuationPauses: PunctuationPauseSettings
    audioMode: AudioCleanupMode
  }
  pronunciation: {
    enabled: boolean
    entryCount: number
    phonemeEntryCount: number
    dictionaryHash: string
  }
  backgroundMusic: {
    enabled: boolean
    volume: number
    duckEnabled: boolean
    duckDepth: number
  }
  encoder: {
    format: AudioFormat
    container: string
    codec: string
    encoder: string
    bitrate: number
    sampleRate: number
    loudnessPreset: LoudnessPresetId
    loudnessTarget: number | null
  }
  source: {
    textHash: string | null
    kind: ProvenanceSourceKind
    documentId?: string
    title?: string
    text?: string
    articleUrl?: string
  }
  cues: {
    schemaVersion: typeof PROVENANCE_CUE_SCHEMA_VERSION
    count: number
    timing: ProvenanceCueTiming
  }
  rvc?: {
    enabled: boolean
    modelCount: number
    pitchSemitones: number
    indexRate: number
  }
  legacy?: boolean
}

export type ProvenanceEngineInput = {
  id: string
  modelId: string
  modelRevision: string
}

export function createProvenanceEngine(engineId: string, chatterboxModel: 'english' | 'multilingual' = 'english'): ProvenanceEngineInput {
  if (engineId === 'kokoro') return { id: 'kokoro', modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX', modelRevision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231' }
  if (engineId === 'supertonic') return { id: 'supertonic', modelId: 'onnx-community/Supertonic-TTS-ONNX', modelRevision: 'main' }
  if (engineId === 'kitten') return { id: 'kitten', modelId: 'kitten-tts-webgpu', modelRevision: '0.1.1' }
  if (engineId === 'chatterbox') return {
    id: 'chatterbox',
    modelId: chatterboxModel === 'multilingual' ? 'onnx-community/chatterbox-multilingual-ONNX' : 'onnx-community/chatterbox-ONNX',
    modelRevision: 'main',
  }
  if (engineId === 'piper') return { id: 'piper', modelId: 'ayousanz/piper-plus-tsukuyomi-chan', modelRevision: '0.6.0' }
  if (engineId === 'melo') return { id: 'melo', modelId: 'myshell-ai/MeloTTS-Chinese', modelRevision: 'af5d207a364ea4208c6f589c89f57f88414bdd16' }
  if (engineId === 'qwen') return { id: 'qwen', modelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice', modelRevision: 'sidecar-managed' }
  return { id: 'browser', modelId: 'Web Speech API', modelRevision: 'browser-managed' }
}

export type ProvenanceEncoderInput = {
  format: AudioFormat
  container: string
  codec: string
  encoder: string
  bitrate: number
  sampleRate: number
  loudnessPreset: LoudnessPresetId
  loudnessTarget?: number | null
}

export function createProvenanceEncoder(
  format: AudioFormat,
  sampleRate: number,
  options: { bitrate?: number; loudnessPreset?: LoudnessPresetId; native?: boolean; ffmpegVersion?: string } = {},
): GenerationProvenanceManifest['encoder'] {
  const bitrate = options.bitrate ?? 0
  const loudnessPreset = options.loudnessPreset ?? 'off'
  const nativeEncoder = options.native === true ? `FFmpeg ${options.ffmpegVersion ?? 'unknown'}` : null
  const target = loudnessTargetForPresetValue(loudnessPreset)
  if (format === 'wav') return {
    format,
    container: 'WAV',
    codec: 'PCM s16le',
    encoder: nativeEncoder ?? 'BetterTTS WAV encoder',
    bitrate: 0,
    sampleRate,
    loudnessPreset,
    loudnessTarget: target,
  }
  if (format === 'mp3') return {
    format,
    container: 'MP3',
    codec: 'MPEG Layer III',
    encoder: nativeEncoder ?? 'lamejs',
    bitrate: bitrate * 1000,
    sampleRate,
    loudnessPreset,
    loudnessTarget: target,
  }
  if (format === 'opus') return {
    format,
    container: options.native === true ? 'Ogg' : 'WebM',
    codec: 'Opus',
    encoder: nativeEncoder ?? 'WebCodecs',
    bitrate: bitrate * 1000,
    sampleRate,
    loudnessPreset,
    loudnessTarget: target,
  }
  if (format === 'flac') return {
    format,
    container: 'FLAC',
    codec: 'FLAC',
    encoder: nativeEncoder ?? 'unknown',
    bitrate: 0,
    sampleRate,
    loudnessPreset,
    loudnessTarget: target,
  }
  return {
    format,
    container: 'M4B / ISO Base Media',
    codec: 'AAC-LC',
    encoder: nativeEncoder ?? 'WebCodecs AudioEncoder',
    bitrate: bitrate * 1000,
    sampleRate,
    loudnessPreset,
    loudnessTarget: target,
  }
}

export type ProvenanceInput = {
  appVersion: string
  runtime: GenerationProvenanceManifest['runtime']
  engine: ProvenanceEngineInput
  voiceId: string
  locale?: string
  speed: number
  pitchSemitones: number
  cleanup: CleanupOptions
  punctuationPauses: PunctuationPauseSettings
  audioCleanupMode: AudioCleanupMode
  pronunciations: PronunciationDictionary
  backgroundMusic: Omit<GenerationProvenanceManifest['backgroundMusic'], 'enabled'> & { enabled?: boolean }
  encoder: ProvenanceEncoderInput
  sourceText?: string
  source?: Partial<Pick<GenerationProvenanceManifest['source'], 'kind' | 'documentId' | 'title' | 'articleUrl'>>
  includeSourceText?: boolean
  includeArticleUrl?: boolean
  cueCount?: number
  cueTiming?: ProvenanceCueTiming
  rvc?: GenerationProvenanceManifest['rvc']
  createdAt?: string
}

export type ProvenanceReplayContext = {
  engineId: string
  modelId: string
  modelRevision: string
  runtimeLabel: string
}

export function hashProvenanceText(value: string): Promise<string> {
  return sha256(value)
}

export async function createGenerationProvenance(input: ProvenanceInput): Promise<GenerationProvenanceManifest> {
  const sourceText = typeof input.sourceText === 'string' ? input.sourceText : ''
  const pronunciationEntries = Object.entries(input.pronunciations)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([word, rule]) => ({ word, replacement: rule.replacement, mode: rule.mode }))
  const dictionaryHash = await sha256(JSON.stringify(pronunciationEntries))
  const source: GenerationProvenanceManifest['source'] = {
    textHash: sourceText ? await hashProvenanceText(sourceText) : null,
    kind: normalizeSourceKind(input.source?.kind),
    ...(boundedString(input.source?.documentId, MAX_STRING_CHARS) ? { documentId: boundedString(input.source?.documentId, MAX_STRING_CHARS) } : {}),
    ...(boundedString(input.source?.title, MAX_STRING_CHARS) ? { title: boundedString(input.source?.title, MAX_STRING_CHARS) } : {}),
    ...(input.includeSourceText && sourceText ? { text: sourceText.slice(0, MAX_TEXT_CHARS) } : {}),
    ...(input.includeArticleUrl && boundedUrl(input.source?.articleUrl) ? { articleUrl: boundedUrl(input.source?.articleUrl) } : {}),
  }

  return normalizeManifest({
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    app: { name: 'BetterTTS', version: boundedString(input.appVersion, 80) ?? 'unknown' },
    runtime: {
      target: input.runtime.target === 'desktop' ? 'desktop' : 'web',
      label: boundedString(input.runtime.label, MAX_STRING_CHARS) ?? 'unknown',
      platform: boundedString(input.runtime.platform, MAX_STRING_CHARS) ?? 'unknown',
    },
    engine: {
      id: boundedString(input.engine.id, 80) ?? 'unknown',
      modelId: boundedString(input.engine.modelId, MAX_STRING_CHARS) ?? 'unknown',
      modelRevision: boundedString(input.engine.modelRevision, MAX_STRING_CHARS) ?? 'unknown',
    },
    voice: {
      id: boundedString(input.voiceId, MAX_STRING_CHARS) ?? 'unknown',
      ...(boundedString(input.locale, 80) ? { locale: boundedString(input.locale, 80) } : {}),
    },
    synthesis: {
      speed: clampFinite(input.speed, 0.25, 4, 1),
      pitchSemitones: clampFinite(input.pitchSemitones, -24, 24, 0),
    },
    cleanup: {
      text: normalizeCleanup(input.cleanup),
      punctuationPauses: normalizePunctuationPauses(input.punctuationPauses),
      audioMode: normalizeAudioCleanupMode(input.audioCleanupMode),
    },
    pronunciation: {
      enabled: pronunciationEntries.length > 0,
      entryCount: pronunciationEntries.length,
      phonemeEntryCount: pronunciationEntries.filter((entry) => entry.mode === 'phoneme').length,
      dictionaryHash,
    },
    backgroundMusic: {
      enabled: input.backgroundMusic.enabled === true,
      volume: clampFinite(input.backgroundMusic.volume, 0, 1, 0),
      duckEnabled: input.backgroundMusic.duckEnabled === true,
      duckDepth: clampFinite(input.backgroundMusic.duckDepth, 0, 1, 0.65),
    },
    encoder: {
      format: normalizeFormat(input.encoder.format),
      container: boundedString(input.encoder.container, 40) ?? 'unknown',
      codec: boundedString(input.encoder.codec, 80) ?? 'unknown',
      encoder: boundedString(input.encoder.encoder, MAX_STRING_CHARS) ?? 'unknown',
      bitrate: Math.round(clampFinite(input.encoder.bitrate, 0, 320000, 0)),
      sampleRate: Math.round(clampFinite(input.encoder.sampleRate, 0, 192000, 0)),
      loudnessPreset: normalizeLoudnessPreset(input.encoder.loudnessPreset),
      loudnessTarget: input.encoder.loudnessTarget === undefined || !Number.isFinite(input.encoder.loudnessTarget)
        ? null
        : clampFinite(input.encoder.loudnessTarget, -100, 20, 0),
    },
    source,
    cues: {
      schemaVersion: PROVENANCE_CUE_SCHEMA_VERSION,
      count: Math.round(clampFinite(input.cueCount ?? 0, 0, 1_000_000, 0)),
      timing: input.cueTiming === 'word' || input.cueTiming === 'sentence' ? input.cueTiming : 'none',
    },
    ...(input.rvc ? { rvc: normalizeRvc(input.rvc) } : {}),
  })
}

export function createLegacyProvenanceManifest(input: {
  createdAt?: number
  voice?: string
  speed?: number
  format?: AudioFormat
  cueCount?: number
} = {}): GenerationProvenanceManifest {
  const candidateDate = Number.isFinite(input.createdAt) ? new Date(Number(input.createdAt)) : null
  const createdAt = candidateDate && Number.isFinite(candidateDate.getTime()) ? candidateDate.toISOString() : new Date(0).toISOString()
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    createdAt,
    app: { name: 'BetterTTS', version: 'unknown' },
    runtime: { target: 'web', label: 'unknown', platform: 'unknown' },
    engine: { id: 'unknown', modelId: 'unknown', modelRevision: 'unknown' },
    voice: { id: boundedString(input.voice, MAX_STRING_CHARS) ?? 'unknown' },
    synthesis: { speed: clampFinite(input.speed ?? 1, 0.25, 4, 1), pitchSemitones: 0 },
    cleanup: {
      text: emptyCleanup(),
      punctuationPauses: emptyPunctuationPauses(),
      audioMode: 'off',
    },
    pronunciation: { enabled: false, entryCount: 0, phonemeEntryCount: 0, dictionaryHash: '' },
    backgroundMusic: { enabled: false, volume: 0, duckEnabled: false, duckDepth: 0 },
    encoder: {
      format: normalizeFormat(input.format ?? 'wav'),
      container: 'unknown',
      codec: 'unknown',
      encoder: 'unknown',
      bitrate: 0,
      sampleRate: 0,
      loudnessPreset: 'off',
      loudnessTarget: null,
    },
    source: { textHash: null, kind: 'unknown' },
    cues: { schemaVersion: PROVENANCE_CUE_SCHEMA_VERSION, count: Math.max(0, Math.round(input.cueCount ?? 0)), timing: 'none' },
    legacy: true,
  }
}

export function migrateGenerationProvenance(raw: unknown, legacyInput?: Parameters<typeof createLegacyProvenanceManifest>[0]): GenerationProvenanceManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return legacyInput ? createLegacyProvenanceManifest(legacyInput) : null
  }
  const candidate = raw as Record<string, unknown>
  if (candidate.schemaVersion !== PROVENANCE_SCHEMA_VERSION) {
    if (candidate.schemaVersion === 0 || candidate.version === 0) {
      const migrated = createLegacyProvenanceManifest(legacyInput ?? {})
      const engine = record(candidate.engine)
      const voice = record(candidate.voice)
      return normalizeManifest({
        ...migrated,
        engine: {
          id: boundedString(candidate.engineId ?? engine?.id, 80) ?? migrated.engine.id,
          modelId: boundedString(candidate.modelId ?? record(candidate.model)?.id, MAX_STRING_CHARS) ?? migrated.engine.modelId,
          modelRevision: boundedString(candidate.modelRevision ?? record(candidate.model)?.revision, MAX_STRING_CHARS) ?? migrated.engine.modelRevision,
        },
        voice: { id: boundedString(candidate.voiceId ?? voice?.id ?? candidate.voice, MAX_STRING_CHARS) ?? migrated.voice.id },
      })
    }
    return legacyInput ? createLegacyProvenanceManifest(legacyInput) : null
  }
  try {
    return normalizeManifest(candidate)
  } catch {
    return legacyInput ? createLegacyProvenanceManifest(legacyInput) : null
  }
}

export function provenanceReplayWarning(manifest: GenerationProvenanceManifest | null | undefined, current?: ProvenanceReplayContext): string | null {
  if (!manifest || manifest.legacy || manifest.engine.id === 'unknown' || !manifest.source.textHash) {
    return 'Replay may differ: this clip has incomplete generation provenance from an older runtime.'
  }
  if (!current) return null
  if (manifest.engine.id !== current.engineId) {
    return `Replay may differ: this clip used ${manifest.engine.id}, but the current engine is ${current.engineId}.`
  }
  if (manifest.engine.modelId !== current.modelId || manifest.engine.modelRevision !== current.modelRevision) {
    return 'Replay may differ: the selected model revision does not match this clip.'
  }
  if (manifest.runtime.label !== current.runtimeLabel) {
    return 'Replay may differ: the selected runtime does not match this clip.'
  }
  return null
}

export function updateProvenanceCueSummary(
  manifest: GenerationProvenanceManifest,
  cueCount: number,
  timing: ProvenanceCueTiming,
): GenerationProvenanceManifest {
  return {
    ...manifest,
    cues: {
      schemaVersion: PROVENANCE_CUE_SCHEMA_VERSION,
      count: Math.round(clampFinite(cueCount, 0, 1_000_000, 0)),
      timing: timing === 'word' || timing === 'sentence' ? timing : 'none',
    },
  }
}

function normalizeManifest(raw: unknown): GenerationProvenanceManifest {
  const value = record(raw)
  if (!value || value.schemaVersion !== PROVENANCE_SCHEMA_VERSION) throw new Error('Unsupported provenance schema.')
  const app = record(value.app)
  const runtime = record(value.runtime)
  const engine = record(value.engine)
  const voice = record(value.voice)
  const synthesis = record(value.synthesis)
  const cleanup = record(value.cleanup)
  const pronunciation = record(value.pronunciation)
  const backgroundMusic = record(value.backgroundMusic)
  const encoder = record(value.encoder)
  const source = record(value.source)
  const cues = record(value.cues)
  if (!app || !runtime || !engine || !voice || !synthesis || !cleanup || !pronunciation || !backgroundMusic || !encoder || !source || !cues) throw new Error('Incomplete provenance manifest.')
  if (app.name !== 'BetterTTS' || typeof app.version !== 'string' || !isDate(value.createdAt)) throw new Error('Invalid provenance identity.')
  const text = normalizeCleanup(cleanup.text)
  const punctuationPauses = normalizePunctuationPauses(cleanup.punctuationPauses)
  const textHash = source.textHash === null ? null : normalizeHash(source.textHash)
  if (textHash === undefined) throw new Error('Invalid provenance source hash.')
  const dictionaryHash = pronunciation.dictionaryHash === '' ? '' : normalizeHash(pronunciation.dictionaryHash)
  if (dictionaryHash === undefined) throw new Error('Invalid pronunciation hash.')
  const manifest: GenerationProvenanceManifest = {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    createdAt: new Date(String(value.createdAt)).toISOString(),
    app: { name: 'BetterTTS', version: boundedString(app.version, 80) ?? 'unknown' },
    runtime: {
      target: runtime.target === 'desktop' ? 'desktop' : 'web',
      label: boundedString(runtime.label, MAX_STRING_CHARS) ?? 'unknown',
      platform: boundedString(runtime.platform, MAX_STRING_CHARS) ?? 'unknown',
    },
    engine: {
      id: boundedString(engine.id, 80) ?? 'unknown',
      modelId: boundedString(engine.modelId, MAX_STRING_CHARS) ?? 'unknown',
      modelRevision: boundedString(engine.modelRevision, MAX_STRING_CHARS) ?? 'unknown',
    },
    voice: {
      id: boundedString(voice.id, MAX_STRING_CHARS) ?? 'unknown',
      ...(boundedString(voice.locale, 80) ? { locale: boundedString(voice.locale, 80) } : {}),
    },
    synthesis: {
      speed: clampFinite(synthesis.speed, 0.25, 4, 1),
      pitchSemitones: clampFinite(synthesis.pitchSemitones, -24, 24, 0),
    },
    cleanup: {
      text,
      punctuationPauses,
      audioMode: normalizeAudioCleanupMode(cleanup.audioMode),
    },
    pronunciation: {
      enabled: pronunciation.enabled === true,
      entryCount: Math.round(clampFinite(pronunciation.entryCount, 0, 500, 0)),
      phonemeEntryCount: Math.round(clampFinite(pronunciation.phonemeEntryCount, 0, 500, 0)),
      dictionaryHash,
    },
    backgroundMusic: {
      enabled: backgroundMusic.enabled === true,
      volume: clampFinite(backgroundMusic.volume, 0, 1, 0),
      duckEnabled: backgroundMusic.duckEnabled === true,
      duckDepth: clampFinite(backgroundMusic.duckDepth, 0, 1, 0.65),
    },
    encoder: {
      format: normalizeFormat(encoder.format),
      container: boundedString(encoder.container, 40) ?? 'unknown',
      codec: boundedString(encoder.codec, 80) ?? 'unknown',
      encoder: boundedString(encoder.encoder, MAX_STRING_CHARS) ?? 'unknown',
      bitrate: Math.round(clampFinite(encoder.bitrate, 0, 320000, 0)),
      sampleRate: Math.round(clampFinite(encoder.sampleRate, 0, 192000, 0)),
      loudnessPreset: normalizeLoudnessPreset(encoder.loudnessPreset),
      loudnessTarget: encoder.loudnessTarget === null || !Number.isFinite(encoder.loudnessTarget)
        ? null
        : clampFinite(encoder.loudnessTarget, -100, 20, 0),
    },
    source: {
      textHash,
      kind: normalizeSourceKind(source.kind),
      ...(boundedString(source.documentId, MAX_STRING_CHARS) ? { documentId: boundedString(source.documentId, MAX_STRING_CHARS) } : {}),
      ...(boundedString(source.title, MAX_STRING_CHARS) ? { title: boundedString(source.title, MAX_STRING_CHARS) } : {}),
      ...(typeof source.text === 'string' && source.text.length <= MAX_TEXT_CHARS ? { text: source.text } : {}),
      ...(boundedUrl(source.articleUrl) ? { articleUrl: boundedUrl(source.articleUrl) } : {}),
    },
    cues: {
      schemaVersion: PROVENANCE_CUE_SCHEMA_VERSION,
      count: Math.round(clampFinite(cues.count, 0, 1_000_000, 0)),
      timing: cues.timing === 'word' || cues.timing === 'sentence' ? cues.timing : 'none',
    },
    ...(value.rvc ? { rvc: normalizeRvc(value.rvc) } : {}),
    ...(value.legacy === true ? { legacy: true } : {}),
  }
  return manifest
}

function normalizeRvc(value: unknown): NonNullable<GenerationProvenanceManifest['rvc']> {
  const candidate = record(value)
  return {
    enabled: candidate?.enabled === true,
    modelCount: Math.round(clampFinite(candidate?.modelCount, 0, 2, 0)),
    pitchSemitones: clampFinite(candidate?.pitchSemitones, -24, 24, 0),
    indexRate: clampFinite(candidate?.indexRate, 0, 1, 0),
  }
}

function normalizeCleanup(value: unknown): CleanupOptions {
  const candidate = record(value)
  return {
    citations: candidate?.citations === true,
    urls: candidate?.urls === true,
    acronyms: candidate?.acronyms === true,
    markdown: candidate?.markdown === true,
    footnotes: candidate?.footnotes === true,
    pageArtifacts: candidate?.pageArtifacts === true,
    pdfReflow: candidate?.pdfReflow === true,
    numbers: candidate?.numbers === true,
    metadata: candidate?.metadata === true,
  }
}

function normalizePunctuationPauses(value: unknown): PunctuationPauseSettings {
  const candidate = record(value)
  return {
    comma: clampFinite(candidate?.comma, 0, 2, 0),
    semicolon: clampFinite(candidate?.semicolon, 0, 2, 0),
    colon: clampFinite(candidate?.colon, 0, 2, 0),
    period: clampFinite(candidate?.period, 0, 2, 0),
    question: clampFinite(candidate?.question, 0, 2, 0),
    exclamation: clampFinite(candidate?.exclamation, 0, 2, 0),
    ellipsis: clampFinite(candidate?.ellipsis, 0, 2, 0),
    emDash: clampFinite(candidate?.emDash, 0, 2, 0),
  }
}

function emptyCleanup(): CleanupOptions {
  return { citations: false, urls: false, acronyms: false, markdown: false, footnotes: false, pageArtifacts: false, pdfReflow: false, numbers: false, metadata: false }
}

function emptyPunctuationPauses(): PunctuationPauseSettings {
  return { comma: 0, semicolon: 0, colon: 0, period: 0, question: 0, exclamation: 0, ellipsis: 0, emDash: 0 }
}

function normalizeAudioCleanupMode(value: unknown): AudioCleanupMode {
  return value === 'denoise' || value === 'studio' ? value : 'off'
}

function normalizeFormat(value: unknown): AudioFormat {
  return value === 'mp3' || value === 'opus' || value === 'flac' || value === 'm4b' ? value : 'wav'
}

function normalizeLoudnessPreset(value: unknown): LoudnessPresetId {
  return value === 'audiobook-mono' || value === 'podcast-stereo' ? value : 'off'
}

function loudnessTargetForPresetValue(value: LoudnessPresetId): number | null {
  return value === 'audiobook-mono' ? -19 : value === 'podcast-stereo' ? -16 : null
}

function normalizeSourceKind(value: unknown): ProvenanceSourceKind {
  return value === 'article' || value === 'epub' || value === 'pdf' || value === 'docx' || value === 'subtitle' || value === 'text'
    ? value
    : 'unknown'
}

function normalizeHash(value: unknown): string | undefined {
  return typeof value === 'string' && HASH_PATTERN.test(value) ? value.toLowerCase() : undefined
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined
}

function boundedUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isDate(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  return fallbackHash(value)
}

function fallbackHash(value: string): string {
  const hashes = [2166136261, 2166136261 ^ 0x9e3779b9, 2166136261 ^ 0x85ebca6b, 2166136261 ^ 0xc2b2ae35]
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    for (let hashIndex = 0; hashIndex < hashes.length; hashIndex += 1) {
      hashes[hashIndex] ^= code + hashIndex * 17
      hashes[hashIndex] = Math.imul(hashes[hashIndex], 16777619) >>> 0
    }
  }
  const half = hashes.map((hash) => hash.toString(16).padStart(8, '0')).join('')
  return `${half}${half}`
}
