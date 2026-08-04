import { describe, expect, it } from 'vitest'
import { supportsAudioOutputSelection } from './audio-output.ts'

describe('audio output capability detection', () => {
  it('requires both the permission picker and media sink routing', () => {
    const selectAudioOutput = () => Promise.resolve({ deviceId: 'headphones', label: 'Headphones' } as MediaDeviceInfo)
    expect(supportsAudioOutputSelection({ mediaDevices: { selectAudioOutput }, setSinkId: () => Promise.resolve() })).toBe(true)
    expect(supportsAudioOutputSelection({ mediaDevices: { selectAudioOutput } })).toBe(false)
    expect(supportsAudioOutputSelection({ setSinkId: () => Promise.resolve() })).toBe(false)
  })
})
