import { describe, expect, it } from 'vitest'
import { RVC_MAX_PCM_BYTES, validateRvcRequest, validateRvcWeightsRequest } from './rvc-ipc.ts'

const base = {
  type: 'convert' as const,
  id: 1,
  samples: new Float32Array([0.1, -0.2]),
  sampleRate: 24_000,
  modelPath: 'C:\\Models\\voice.pth',
  indexPath: 'C:\\Models\\voice.index',
  blendModelPath: 'C:\\Models\\other.pth',
  blendIndexPath: 'C:\\Models\\other.index',
  blendRatio: 0.6,
  pitchSemitones: -2,
  indexRate: 0.5,
}

describe('RVC IPC validation', () => {
  it('accepts bounded status/setup/cancel and conversion requests', () => {
    expect(validateRvcRequest({ type: 'status', id: 1 })).toEqual({ type: 'status', id: 1 })
    expect(validateRvcRequest({ type: 'setup', id: 2 })).toEqual({ type: 'setup', id: 2 })
    expect(validateRvcRequest({ type: 'cancel', id: 3 })).toEqual({ type: 'cancel', id: 3 })
    expect(validateRvcRequest(base)).toMatchObject({ type: 'convert', modelPath: base.modelPath, blendRatio: 0.6 })
    expect(validateRvcWeightsRequest({ action: 'model' })).toEqual({ action: 'model' })
    expect(validateRvcWeightsRequest({ action: 'index' })).toEqual({ action: 'index' })
  })

  it('rejects paths, ranges, samples, and actions outside the adapter contract', () => {
    expect(validateRvcRequest({ ...base, modelPath: '../voice.pth' })).toBeNull()
    expect(validateRvcRequest({ ...base, modelPath: 'C:\\Models\\voice.bin' })).toBeNull()
    expect(validateRvcRequest({ ...base, blendRatio: 2 })).toBeNull()
    expect(validateRvcRequest({ ...base, sampleRate: 1_000 })).toBeNull()
    expect(validateRvcRequest({ ...base, samples: [0.1] })).toBeNull()
    expect(validateRvcRequest({ ...base, samples: new Float32Array(RVC_MAX_PCM_BYTES / 2 + 1) })).toBeNull()
    expect(validateRvcWeightsRequest({ action: 'run' })).toBeNull()
    expect(validateRvcRequest({ type: 'status', id: -1 })).toBeNull()
  })
})
