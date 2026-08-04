import { type ByoModelOptionId, type ByoWeightsSelection } from '../lib/byo-models.ts'
import { getByoWeightsBridge } from './index.ts'

export type { ByoWeightsSelection }

export function byoWeightsAvailable(): boolean {
  return getByoWeightsBridge() !== null
}

export async function chooseByoWeights(modelId: ByoModelOptionId): Promise<ByoWeightsSelection> {
  const bridge = getByoWeightsBridge()
  if (!bridge) {
    return {
      canceled: true,
    }
  }
  return bridge.choose(modelId)
}
