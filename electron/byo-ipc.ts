import { BYO_MODEL_OPTIONS, type ByoModelOptionId, type ByoWeightsSelection } from '../src/lib/byo-models.ts'

export const BYO_WEIGHTS_CHANNEL = 'bettertts:byo-weights'

export type ValidByoWeightsRequest = {
  modelId: ByoModelOptionId
}

export function validateByoWeightsRequest(value: unknown): ValidByoWeightsRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const request = value as Record<string, unknown>
  if (typeof request.modelId !== 'string' || !BYO_MODEL_OPTIONS.some((option) => option.id === request.modelId)) return null
  return { modelId: request.modelId as ByoModelOptionId }
}

export type ByoWeightsBridgeResponse = ByoWeightsSelection
