export type AudioOutputDevice = {
  deviceId: string
  label: string
}

type AudioOutputApi = {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>
}

type AudioOutputProbe = {
  mediaDevices?: AudioOutputApi
  setSinkId?: unknown
}

export function supportsAudioOutputSelection(probe: AudioOutputProbe = browserProbe()): boolean {
  return typeof probe.mediaDevices?.selectAudioOutput === 'function' && typeof probe.setSinkId === 'function'
}

export async function selectAudioOutputDevice(): Promise<AudioOutputDevice> {
  const probe = browserProbe()
  if (!supportsAudioOutputSelection(probe) || !probe.mediaDevices?.selectAudioOutput) {
    throw new Error('Audio output routing is not supported by this browser.')
  }
  const device = await probe.mediaDevices.selectAudioOutput()
  return {
    deviceId: device.deviceId,
    label: device.label.trim() || 'Selected output',
  }
}

function browserProbe(): AudioOutputProbe {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof document === 'undefined') return {}
  const audio = document.createElement('audio')
  return {
    mediaDevices: navigator.mediaDevices as AudioOutputApi,
    setSinkId: (audio as HTMLAudioElement & { setSinkId?: unknown }).setSinkId,
  }
}
