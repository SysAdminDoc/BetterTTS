/**
 * Local registration for user-supplied restricted/non-commercial weights.
 * BetterTTS stores metadata only: it never downloads, copies, or executes
 * these files until a future compatible adapter is explicitly selected.
 */

export const BYO_MODELS_STORAGE_KEY = 'bettertts-byo-models'
export const BYO_CONSENT_STORAGE_KEY = 'bettertts-byo-non-commercial-consent'
export const MAX_BYO_MODELS = 12
export const MAX_BYO_PATH_CHARS = 2_048
export const MAX_BYO_LICENSE_CHARS = 200
export const MAX_BYO_PROVENANCE_CHARS = 600
export const MAX_BYO_SOURCE_URL_CHARS = 2_048

export const BYO_MODEL_OPTIONS = [
  { id: 'f5-tts', label: 'F5-TTS', hint: 'Checkpoint directory or file; verify the exact weight terms.' },
  { id: 'xtts-v2', label: 'XTTS-v2', hint: 'Checkpoint directory or file; verify the exact weight terms.' },
  { id: 'fish-openaudio-s1', label: 'Fish / OpenAudio S1', hint: 'Checkpoint directory or file; verify the exact weight terms.' },
  { id: 'higgs-audio', label: 'Higgs Audio', hint: 'Checkpoint directory or file; verify the exact weight terms.' },
  { id: 'maskgct', label: 'MaskGCT', hint: 'Checkpoint directory or file; verify the exact weight terms.' },
  { id: 'silero', label: 'Silero', hint: 'Checkpoint directory or file; verify the exact weight terms.' },
  { id: 'other', label: 'Other restricted model', hint: 'Register another compatible model only after reviewing its terms.' },
] as const

export type ByoModelOptionId = typeof BYO_MODEL_OPTIONS[number]['id']

export type ByoModelOption = typeof BYO_MODEL_OPTIONS[number]

export type ByoSelectionKind = 'file' | 'directory'

export type ByoWeightsSelection = {
  canceled: boolean
  path?: string
  name?: string
  kind?: ByoSelectionKind
}

export type ByoModelRecord = {
  id: string
  modelId: ByoModelOptionId
  modelName: string
  weightsPath: string
  selectionKind: ByoSelectionKind
  license: string
  provenance: string
  sourceUrl?: string
  acknowledgedAt: string
  addedAt: string
}

export type ByoModelRecordInput = {
  modelId: ByoModelOptionId
  weightsPath: string
  selectionKind: ByoSelectionKind
  license: string
  provenance: string
  sourceUrl?: string
  acknowledgedAt?: string
  addedAt?: string
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || [...trimmed].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })) return null
  return trimmed
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validModelId(value: unknown): value is ByoModelOptionId {
  return typeof value === 'string' && BYO_MODEL_OPTIONS.some((option) => option.id === value)
}

function validSelectionKind(value: unknown): value is ByoSelectionKind {
  return value === 'file' || value === 'directory'
}

function normalizeRecord(value: unknown): ByoModelRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = boundedText(record.id, 120)
  const modelName = boundedText(record.modelName, 120)
  const weightsPath = boundedText(record.weightsPath, MAX_BYO_PATH_CHARS)
  const license = boundedText(record.license, MAX_BYO_LICENSE_CHARS)
  const provenance = boundedText(record.provenance, MAX_BYO_PROVENANCE_CHARS)
  const sourceUrl = record.sourceUrl === undefined || record.sourceUrl === ''
    ? undefined
    : boundedText(record.sourceUrl, MAX_BYO_SOURCE_URL_CHARS)
  if (
    !id
    || !validModelId(record.modelId)
    || !modelName
    || !weightsPath
    || !validSelectionKind(record.selectionKind)
    || !license
    || !provenance
    || (record.sourceUrl !== undefined && record.sourceUrl !== '' && !sourceUrl)
    || !validTimestamp(record.acknowledgedAt)
    || !validTimestamp(record.addedAt)
  ) return null

  return {
    id,
    modelId: record.modelId,
    modelName,
    weightsPath,
    selectionKind: record.selectionKind,
    license,
    provenance,
    ...(sourceUrl ? { sourceUrl } : {}),
    acknowledgedAt: record.acknowledgedAt,
    addedAt: record.addedAt,
  }
}

export function getByoModelOption(modelId: ByoModelOptionId): ByoModelOption {
  return BYO_MODEL_OPTIONS.find((option) => option.id === modelId) ?? BYO_MODEL_OPTIONS[BYO_MODEL_OPTIONS.length - 1]
}

export function parseByoModelRecords(raw: string | null): ByoModelRecord[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeRecord).filter((record): record is ByoModelRecord => record !== null).slice(0, MAX_BYO_MODELS)
  } catch {
    return []
  }
}

export function serializeByoModelRecords(records: ByoModelRecord[]): string {
  return JSON.stringify(records.map(normalizeRecord).filter((record): record is ByoModelRecord => record !== null).slice(0, MAX_BYO_MODELS))
}

export function parseByoConsent(raw: string | null): boolean {
  return raw === '1'
}

export function createByoModelRecord(input: ByoModelRecordInput, now = new Date().toISOString()): ByoModelRecord {
  const option = getByoModelOption(input.modelId)
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `byo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const record = normalizeRecord({
    id: randomId,
    modelId: input.modelId,
    modelName: option.label,
    weightsPath: input.weightsPath,
    selectionKind: input.selectionKind,
    license: input.license,
    provenance: input.provenance,
    sourceUrl: input.sourceUrl ?? '',
    acknowledgedAt: input.acknowledgedAt ?? now,
    addedAt: input.addedAt ?? now,
  })
  if (!record) throw new Error('Bring-your-own model metadata is incomplete or exceeds its limits.')
  return record
}

export function upsertByoModelRecord(records: ByoModelRecord[], next: ByoModelRecord): ByoModelRecord[] {
  const existing = records.findIndex((record) => record.modelId === next.modelId && record.weightsPath === next.weightsPath)
  if (existing >= 0) {
    const updated = [...records]
    updated[existing] = next
    return updated
  }
  return [...records, next].slice(-MAX_BYO_MODELS)
}

export function removeByoModelRecord(records: ByoModelRecord[], recordId: string): ByoModelRecord[] {
  return records.filter((record) => record.id !== recordId)
}
