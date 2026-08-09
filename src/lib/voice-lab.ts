import {
  CHATTERBOX_MAX_REFERENCE_SECONDS,
  CHATTERBOX_MIN_REFERENCE_SECONDS,
  chatterboxModelId,
  chatterboxModelLabel,
  type ChatterboxModelVariant,
} from './chatterbox-config.ts'
import type { ChatterboxReference } from './chatterbox.ts'
import { createVoiceSourceRecord, type VoiceConsentRecord, type VoiceSourceRecord, type VoiceWatermarkRecord } from './voice-provenance.ts'

export type VoiceLabLicenseTier = 'permissive' | 'restricted' | 'non-commercial'

export type VoiceLabModel = {
  id: string
  label: string
  license: {
    spdx: string
    tier: VoiceLabLicenseTier
  }
  referenceVoice: boolean
}

export type VoiceProvenance = {
  kind: 'reference-voice'
  source: 'cloned'
  referenceId: string
  referenceName: string
  referenceDurationSeconds: number
  acknowledgedAt: string
  modelId: string
  modelLabel: string
  modelLicenseSpdx: string
  modelLicenseTier: 'permissive'
  consent: VoiceConsentRecord
  watermark: VoiceWatermarkRecord
}

export type VoiceProvenanceInput = {
  referenceId: string
  referenceName: string
  referenceDurationSeconds: number
  acknowledgedAt?: string
  model: VoiceLabModel
}

const CHATTERBOX_LICENSE = { spdx: 'MIT', tier: 'permissive' } as const

export function chatterboxVoiceLabModel(variant: ChatterboxModelVariant): VoiceLabModel {
  return {
    id: chatterboxModelId(variant),
    label: chatterboxModelLabel(variant),
    license: { ...CHATTERBOX_LICENSE },
    referenceVoice: true,
  }
}

/** Keep restricted and non-commercial weights out of the default voice lab. */
export function assertVoiceLabModelAllowed(model: VoiceLabModel): void {
  if (!model.referenceVoice) throw new Error(`${model.label} does not support reference-voice synthesis.`)
  if (model.license.tier !== 'permissive') {
    throw new Error(`${model.label} uses a ${model.license.tier} license and is blocked from the default voice lab.`)
  }
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const hasControlCharacter = [...text].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  return text && text.length <= maxLength && !hasControlCharacter ? text : null
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validReferenceDuration(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= CHATTERBOX_MIN_REFERENCE_SECONDS
    && value <= CHATTERBOX_MAX_REFERENCE_SECONDS
}

export function createVoiceProvenance(input: VoiceProvenanceInput): VoiceProvenance {
  assertVoiceLabModelAllowed(input.model)
  const referenceId = boundedText(input.referenceId, 200)
  const referenceName = boundedText(input.referenceName, 300)
  const modelId = boundedText(input.model.id, 200)
  const modelLabel = boundedText(input.model.label, 200)
  const modelLicenseSpdx = boundedText(input.model.license.spdx, 120)
  if (!referenceId || !referenceName || !validReferenceDuration(input.referenceDurationSeconds) || !validTimestamp(input.acknowledgedAt)) {
    throw new Error('Reference-voice provenance requires a valid local clip and consent acknowledgement.')
  }
  if (!modelId || !modelLabel || !modelLicenseSpdx) throw new Error('Voice-lab model metadata is incomplete.')
  return {
    kind: 'reference-voice',
    source: 'cloned',
    referenceId,
    referenceName,
    referenceDurationSeconds: input.referenceDurationSeconds,
    acknowledgedAt: input.acknowledgedAt,
    modelId,
    modelLabel,
    modelLicenseSpdx,
    modelLicenseTier: 'permissive',
    consent: {
      required: true,
      acknowledged: true,
      acknowledgedAt: input.acknowledgedAt,
    },
    watermark: {
      status: 'retained',
      label: 'PerTh',
      modelId,
      note: 'Chatterbox model-specific watermark retained; this status does not apply to other voice models.',
    },
  }
}

export default function createChatterboxVoiceProvenance(reference: ChatterboxReference, variant: ChatterboxModelVariant): VoiceProvenance {
  return createVoiceProvenance({
    referenceId: reference.id,
    referenceName: reference.name,
    referenceDurationSeconds: reference.durationSeconds,
    acknowledgedAt: reference.at,
    model: chatterboxVoiceLabModel(variant),
  })
}

export function voiceLabProvenanceToSource(provenance: VoiceProvenance): VoiceSourceRecord {
  return createVoiceSourceRecord({
    source: 'cloned',
    sourceId: provenance.referenceId,
    sourceName: provenance.referenceName,
    sourceDurationSeconds: provenance.referenceDurationSeconds,
    modelId: provenance.modelId,
    modelLabel: provenance.modelLabel,
    modelLicense: provenance.modelLicenseSpdx,
    provenance: 'Reference clip supplied by the operator; source audio is not persisted by BetterTTS.',
    consent: provenance.consent,
    watermark: provenance.watermark,
  })
}

/** Fail closed when old or externally edited library records lack the policy fields. */
export function migrateVoiceProvenance(value: unknown): VoiceProvenance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<VoiceProvenance>
  if (
    candidate.kind !== 'reference-voice'
    || (candidate.source !== undefined && candidate.source !== 'cloned')
    || candidate.modelLicenseTier !== 'permissive'
    || !validTimestamp(candidate.acknowledgedAt)
    || !validReferenceDuration(candidate.referenceDurationSeconds)
  ) return null
  const referenceId = boundedText(candidate.referenceId, 200)
  const referenceName = boundedText(candidate.referenceName, 300)
  const modelId = boundedText(candidate.modelId, 200)
  const modelLabel = boundedText(candidate.modelLabel, 200)
  const modelLicenseSpdx = boundedText(candidate.modelLicenseSpdx, 120)
  if (!referenceId || !referenceName || !modelId || !modelLabel || !modelLicenseSpdx) return null
  const consent = candidate.consent
  if (consent !== undefined && (consent.required !== true || consent.acknowledged !== true || consent.acknowledgedAt !== candidate.acknowledgedAt)) return null
  const watermark = candidate.watermark
  if (watermark !== undefined && (watermark.status !== 'retained' || watermark.modelId !== modelId)) return null
  return {
    kind: 'reference-voice',
    source: 'cloned',
    referenceId,
    referenceName,
    referenceDurationSeconds: candidate.referenceDurationSeconds,
    acknowledgedAt: candidate.acknowledgedAt,
    modelId,
    modelLabel,
    modelLicenseSpdx,
    modelLicenseTier: 'permissive',
    consent: consent ?? {
      required: true,
      acknowledged: true,
      acknowledgedAt: candidate.acknowledgedAt,
    },
    watermark: watermark ?? {
      status: 'retained',
      label: 'PerTh',
      modelId,
      note: 'Chatterbox model-specific watermark retained; this status does not apply to other voice models.',
    },
  }
}
