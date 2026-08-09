export const VOICE_PROVENANCE_SCHEMA_VERSION = 1 as const

export type VoiceSourceKind = 'built-in' | 'user-supplied' | 'cloned' | 'rvc' | 'sidecar' | 'unknown'

export type VoiceWatermarkStatus = 'retained' | 'absent' | 'not-applicable' | 'unknown'

export type VoiceConsentRecord = {
  required: boolean
  acknowledged: boolean
  acknowledgedAt?: string
}

export type VoiceWatermarkRecord = {
  status: VoiceWatermarkStatus
  label?: string
  modelId?: string
  note?: string
}

export type VoiceSourceRecord = {
  source: VoiceSourceKind
  derivedFrom?: readonly VoiceSourceKind[]
  sourceId?: string
  sourceName?: string
  sourceDurationSeconds?: number
  modelId?: string
  modelLabel?: string
  modelLicense?: string
  provenance?: string
  consent: VoiceConsentRecord
  watermark: VoiceWatermarkRecord
}

export type VoiceSourceInput = {
  source: VoiceSourceKind
  derivedFrom?: readonly VoiceSourceKind[]
  sourceId?: string
  sourceName?: string
  sourceDurationSeconds?: number
  modelId?: string
  modelLabel?: string
  modelLicense?: string
  provenance?: string
  consent?: Partial<VoiceConsentRecord>
  watermark?: Partial<VoiceWatermarkRecord>
}

const SOURCE_KINDS = new Set<VoiceSourceKind>(['built-in', 'user-supplied', 'cloned', 'rvc', 'sidecar', 'unknown'])
const WATERMARK_STATUSES = new Set<VoiceWatermarkStatus>(['retained', 'absent', 'not-applicable', 'unknown'])
const MAX_TEXT_CHARS = 600
const MAX_ID_CHARS = 300

export function createVoiceSourceRecord(input: VoiceSourceInput): VoiceSourceRecord {
  const source = normalizeVoiceSourceKind(input.source)
  const consent = normalizeVoiceConsent(input.consent, source)
  if (consent.required && (!consent.acknowledged || !consent.acknowledgedAt)) {
    throw new Error(`${source} voice provenance requires an explicit consent acknowledgement.`)
  }
  const watermark = normalizeVoiceWatermark(input.watermark, source)
  return {
    source,
    ...(normalizeDerivedFrom(input.derivedFrom, source).length > 0 ? { derivedFrom: normalizeDerivedFrom(input.derivedFrom, source) } : {}),
    ...(boundedText(input.sourceId, MAX_ID_CHARS) ? { sourceId: boundedText(input.sourceId, MAX_ID_CHARS) } : {}),
    ...(boundedText(input.sourceName, MAX_TEXT_CHARS) ? { sourceName: boundedText(input.sourceName, MAX_TEXT_CHARS) } : {}),
    ...(validDuration(input.sourceDurationSeconds) ? { sourceDurationSeconds: input.sourceDurationSeconds } : {}),
    ...(boundedText(input.modelId, MAX_ID_CHARS) ? { modelId: boundedText(input.modelId, MAX_ID_CHARS) } : {}),
    ...(boundedText(input.modelLabel, MAX_TEXT_CHARS) ? { modelLabel: boundedText(input.modelLabel, MAX_TEXT_CHARS) } : {}),
    ...(boundedText(input.modelLicense, MAX_TEXT_CHARS) ? { modelLicense: boundedText(input.modelLicense, MAX_TEXT_CHARS) } : {}),
    ...(boundedText(input.provenance, MAX_TEXT_CHARS) ? { provenance: boundedText(input.provenance, MAX_TEXT_CHARS) } : {}),
    consent,
    watermark,
  }
}

/** Normalize persisted manifests without requiring newly introduced fields. */
export function normalizeVoiceSourceRecord(value: unknown): VoiceSourceRecord {
  const candidate = record(value)
  const source = normalizeVoiceSourceKind(candidate?.source)
  const derivedFrom = normalizeDerivedFrom(candidate?.derivedFrom, source)
  const consent = normalizeVoiceConsent(candidate?.consent, source)
  const watermark = normalizeVoiceWatermark(candidate?.watermark, source)
  return {
    source,
    ...(derivedFrom.length > 0 ? { derivedFrom } : {}),
    ...(boundedText(candidate?.sourceId, MAX_ID_CHARS) ? { sourceId: boundedText(candidate?.sourceId, MAX_ID_CHARS) } : {}),
    ...(boundedText(candidate?.sourceName, MAX_TEXT_CHARS) ? { sourceName: boundedText(candidate?.sourceName, MAX_TEXT_CHARS) } : {}),
    ...(validDuration(candidate?.sourceDurationSeconds) ? { sourceDurationSeconds: Number(candidate?.sourceDurationSeconds) } : {}),
    ...(boundedText(candidate?.modelId, MAX_ID_CHARS) ? { modelId: boundedText(candidate?.modelId, MAX_ID_CHARS) } : {}),
    ...(boundedText(candidate?.modelLabel, MAX_TEXT_CHARS) ? { modelLabel: boundedText(candidate?.modelLabel, MAX_TEXT_CHARS) } : {}),
    ...(boundedText(candidate?.modelLicense, MAX_TEXT_CHARS) ? { modelLicense: boundedText(candidate?.modelLicense, MAX_TEXT_CHARS) } : {}),
    ...(boundedText(candidate?.provenance, MAX_TEXT_CHARS) ? { provenance: boundedText(candidate?.provenance, MAX_TEXT_CHARS) } : {}),
    consent,
    watermark,
  }
}

export function voiceSourceRequiresShareReview(value: Pick<VoiceSourceRecord, 'source' | 'derivedFrom'> | null | undefined): boolean {
  return value?.source === 'cloned' || value?.derivedFrom?.includes('cloned') === true
}

export function normalizeVoiceSourceKind(value: unknown): VoiceSourceKind {
  return typeof value === 'string' && SOURCE_KINDS.has(value as VoiceSourceKind) ? value as VoiceSourceKind : 'unknown'
}

function normalizeVoiceConsent(value: unknown, source: VoiceSourceKind): VoiceConsentRecord {
  const candidate = record(value)
  const required = candidate?.required === true || source === 'cloned' || source === 'rvc' || source === 'user-supplied'
  const acknowledged = candidate?.acknowledged === true
  const acknowledgedAt = validTimestamp(candidate?.acknowledgedAt) ? candidate?.acknowledgedAt as string : undefined
  return {
    required,
    acknowledged,
    ...(acknowledgedAt ? { acknowledgedAt } : {}),
  }
}

function normalizeVoiceWatermark(value: unknown, source: VoiceSourceKind): VoiceWatermarkRecord {
  const candidate = record(value)
  const requestedStatus = candidate?.status
  const status = typeof requestedStatus === 'string' && WATERMARK_STATUSES.has(requestedStatus as VoiceWatermarkStatus)
    ? requestedStatus as VoiceWatermarkStatus
    : source === 'built-in'
      ? 'not-applicable'
      : 'unknown'
  return {
    status,
    ...(boundedText(candidate?.label, MAX_TEXT_CHARS) ? { label: boundedText(candidate?.label, MAX_TEXT_CHARS) } : {}),
    ...(boundedText(candidate?.modelId, MAX_ID_CHARS) ? { modelId: boundedText(candidate?.modelId, MAX_ID_CHARS) } : {}),
    ...(boundedText(candidate?.note, MAX_TEXT_CHARS) ? { note: boundedText(candidate?.note, MAX_TEXT_CHARS) } : {}),
  }
}

function normalizeDerivedFrom(value: unknown, source: VoiceSourceKind): VoiceSourceKind[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .map(normalizeVoiceSourceKind)
    .filter((kind) => kind !== source && kind !== 'unknown'))].slice(0, 5)
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return undefined
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  }) ? undefined : value
}

function validDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3600
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
