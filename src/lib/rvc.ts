/**
 * Local RVC model registration and post-stage planning.
 *
 * RVC weights are user-managed files. BetterTTS stores bounded metadata only;
 * it never downloads, copies, or activates a model until the user enables the
 * consent gate and selects the post-stage for a render.
 */

export const RVC_MODELS_STORAGE_KEY = 'bettertts-rvc-models'
export const RVC_CONSENT_STORAGE_KEY = 'bettertts-rvc-consent'
export const RVC_SETTINGS_STORAGE_KEY = 'bettertts-rvc-settings'
export const MAX_RVC_MODELS = 8
export const MAX_RVC_PATH_CHARS = 4_096
export const MAX_RVC_NAME_CHARS = 120
export const MAX_RVC_LICENSE_CHARS = 200
export const MAX_RVC_PROVENANCE_CHARS = 600
export const MAX_RVC_SOURCE_URL_CHARS = 2_048

export type RvcModelSelection = {
  canceled: boolean
  path?: string
  name?: string
}
export type RvcModelRecord = {
  id: string
  modelName: string
  modelPath: string
  indexPath?: string
  license: string
  provenance: string
  sourceUrl?: string
  acknowledgedAt: string
  addedAt: string
}

export type RvcModelRecordInput = {
  modelName?: string
  modelPath: string
  indexPath?: string
  license: string
  provenance: string
  sourceUrl?: string
  acknowledgedAt?: string
  addedAt?: string
}

export type RvcSettings = {
  enabled: boolean
  modelId: string | null
  blendModelId: string | null
  blendRatio: number
  pitchSemitones: number
  indexRate: number
}

export const DEFAULT_RVC_SETTINGS: RvcSettings = {
  enabled: false,
  modelId: null,
  blendModelId: null,
  blendRatio: 0.5,
  pitchSemitones: 0,
  indexRate: 0.5,
}

export type RvcInferencePlan = {
  primary: RvcModelRecord
  blend?: RvcModelRecord
  blendRatio: number
  pitchSemitones: number
  indexRate: number
}

export type RvcClipProvenance = {
  stage: 'rvc'
  appliedAt: string
  consentAcknowledgedAt?: string
  models: Array<{
    id: string
    name: string
    license: string
    provenance: string
    acknowledgedAt?: string
  }>
  blendRatio?: number
  pitchSemitones: number
  indexRate: number
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

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === '') return undefined
  return boundedText(value, maxLength) ?? undefined
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validHttpUrl(value: string | undefined): boolean {
  if (!value) return true
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeModelRecord(value: unknown): RvcModelRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = boundedText(record.id, 120)
  const modelName = boundedText(record.modelName, MAX_RVC_NAME_CHARS)
  const modelPath = boundedText(record.modelPath, MAX_RVC_PATH_CHARS)
  const indexPath = optionalText(record.indexPath, MAX_RVC_PATH_CHARS)
  const license = boundedText(record.license, MAX_RVC_LICENSE_CHARS)
  const provenance = boundedText(record.provenance, MAX_RVC_PROVENANCE_CHARS)
  const sourceUrl = optionalText(record.sourceUrl, MAX_RVC_SOURCE_URL_CHARS)
  if (
    !id
    || !modelName
    || !modelPath
    || (record.indexPath !== undefined && record.indexPath !== '' && !indexPath)
    || !license
    || !provenance
    || (record.sourceUrl !== undefined && record.sourceUrl !== '' && !sourceUrl)
    || !validHttpUrl(sourceUrl)
    || !validTimestamp(record.acknowledgedAt)
    || !validTimestamp(record.addedAt)
  ) return null

  return {
    id,
    modelName,
    modelPath,
    ...(indexPath ? { indexPath } : {}),
    license,
    provenance,
    ...(sourceUrl ? { sourceUrl } : {}),
    acknowledgedAt: record.acknowledgedAt,
    addedAt: record.addedAt,
  }
}

export function parseRvcModelRecords(raw: string | null): RvcModelRecord[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeModelRecord)
      .filter((record): record is RvcModelRecord => record !== null)
      .slice(0, MAX_RVC_MODELS)
  } catch {
    return []
  }
}

export function serializeRvcModelRecords(records: RvcModelRecord[]): string {
  return JSON.stringify(records
    .map(normalizeModelRecord)
    .filter((record): record is RvcModelRecord => record !== null)
    .slice(0, MAX_RVC_MODELS))
}

export function parseRvcConsent(raw: string | null): boolean {
  return raw === '1'
}

export function createRvcModelRecord(input: RvcModelRecordInput, now = new Date().toISOString()): RvcModelRecord {
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `rvc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const fallbackName = input.modelPath.split(/[\\/]/u).at(-1)?.replace(/\.pth$/iu, '') || 'RVC model'
  const record = normalizeModelRecord({
    id: randomId,
    modelName: input.modelName?.trim() || fallbackName,
    modelPath: input.modelPath,
    indexPath: input.indexPath ?? '',
    license: input.license,
    provenance: input.provenance,
    sourceUrl: input.sourceUrl ?? '',
    acknowledgedAt: input.acknowledgedAt ?? now,
    addedAt: input.addedAt ?? now,
  })
  if (!record) throw new Error('RVC model metadata is incomplete or exceeds its limits.')
  return record
}

export function upsertRvcModelRecord(records: RvcModelRecord[], next: RvcModelRecord): RvcModelRecord[] {
  const existing = records.findIndex((record) => record.modelPath === next.modelPath)
  if (existing >= 0) {
    const updated = [...records]
    updated[existing] = next
    return updated
  }
  return [...records, next].slice(-MAX_RVC_MODELS)
}

export function removeRvcModelRecord(records: RvcModelRecord[], recordId: string): RvcModelRecord[] {
  return records.filter((record) => record.id !== recordId)
}

function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

export function normalizeRvcSettings(value: unknown): RvcSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_RVC_SETTINGS }
  const settings = value as Record<string, unknown>
  const modelId = typeof settings.modelId === 'string' && settings.modelId.length <= 120 ? settings.modelId : null
  const blendModelId = typeof settings.blendModelId === 'string' && settings.blendModelId.length <= 120 ? settings.blendModelId : null
  return {
    enabled: settings.enabled === true,
    modelId,
    blendModelId,
    blendRatio: clampFinite(settings.blendRatio, 0, 1, DEFAULT_RVC_SETTINGS.blendRatio),
    pitchSemitones: clampFinite(settings.pitchSemitones, -24, 24, DEFAULT_RVC_SETTINGS.pitchSemitones),
    indexRate: clampFinite(settings.indexRate, 0, 1, DEFAULT_RVC_SETTINGS.indexRate),
  }
}

export function parseRvcSettings(raw: string | null): RvcSettings {
  if (!raw) return { ...DEFAULT_RVC_SETTINGS }
  try {
    return normalizeRvcSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_RVC_SETTINGS }
  }
}

export function serializeRvcSettings(settings: RvcSettings): string {
  return JSON.stringify(normalizeRvcSettings(settings))
}

export function resolveRvcInferencePlan(
  settings: RvcSettings,
  models: readonly RvcModelRecord[],
  consent: boolean,
): RvcInferencePlan | null {
  if (!settings.enabled) return null
  if (!consent) throw new Error('Enable the RVC consent gate before using voice conversion.')
  if (!settings.modelId) throw new Error('Choose an RVC model before generating.')
  const primary = models.find((model) => model.id === settings.modelId)
  if (!primary) throw new Error('The selected RVC model is missing. Re-register its local .pth file.')
  const blend = settings.blendModelId
    ? models.find((model) => model.id === settings.blendModelId)
    : undefined
  if (settings.blendModelId && !blend) throw new Error('The selected RVC blend model is missing. Re-register its local .pth file.')
  if (blend && blend.id === primary.id) throw new Error('Choose two different RVC models to blend.')
  return {
    primary,
    ...(blend ? { blend } : {}),
    blendRatio: blend ? clampFinite(settings.blendRatio, 0, 1, 0.5) : 0,
    pitchSemitones: clampFinite(settings.pitchSemitones, -24, 24, 0),
    indexRate: clampFinite(settings.indexRate, 0, 1, 0.5),
  }
}

export function createRvcClipProvenance(plan: RvcInferencePlan, now = new Date().toISOString()): RvcClipProvenance {
  const models = [plan.primary, ...(plan.blend ? [plan.blend] : [])].map((model) => ({
    id: model.id,
    name: model.modelName,
    license: model.license,
    provenance: model.provenance,
    acknowledgedAt: model.acknowledgedAt,
  }))
  const consentAcknowledgedAt = [...models]
    .sort((left, right) => Date.parse(left.acknowledgedAt) - Date.parse(right.acknowledgedAt))
    .at(-1)?.acknowledgedAt
  return {
    stage: 'rvc',
    appliedAt: now,
    ...(consentAcknowledgedAt ? { consentAcknowledgedAt } : {}),
    models,
    ...(plan.blend ? { blendRatio: plan.blendRatio } : {}),
    pitchSemitones: plan.pitchSemitones,
    indexRate: plan.indexRate,
  }
}

/** Linear PCM blend used by tests and by adapters that return both passes. */
export function blendRvcSamples(primary: Float32Array, secondary: Float32Array, ratio: number): Float32Array {
  const weight = clampFinite(ratio, 0, 1, 0.5)
  const result = new Float32Array(Math.max(primary.length, secondary.length))
  for (let index = 0; index < result.length; index += 1) {
    const a = index < primary.length ? primary[index] : 0
    const b = index < secondary.length ? secondary[index] : 0
    result[index] = Math.max(-1, Math.min(1, a * (1 - weight) + b * weight))
  }
  return result
}
