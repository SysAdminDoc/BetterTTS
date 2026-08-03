export const MAX_WAVEFORM_BINS = 180

export function buildPeakEnvelope(samples: ArrayLike<number>, bins = MAX_WAVEFORM_BINS): number[] {
  const length = Math.max(0, Math.floor(samples.length))
  if (length === 0) return []
  const count = Math.min(MAX_WAVEFORM_BINS, Math.max(1, Math.floor(bins)))
  const envelope = new Array<number>(count)
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(index * length / count)
    const end = Math.max(start + 1, Math.ceil((index + 1) * length / count))
    let peak = 0
    for (let sampleIndex = start; sampleIndex < end && sampleIndex < length; sampleIndex += 1) {
      const sample = Number(samples[sampleIndex])
      if (Number.isFinite(sample)) peak = Math.max(peak, Math.min(1, Math.abs(sample)))
    }
    envelope[index] = peak
  }
  return envelope
}

export async function decodeAudioPeaks(src: string, bins = MAX_WAVEFORM_BINS): Promise<number[]> {
  if (!src) throw new Error('Audio source is missing.')
  const response = await fetch(src)
  if (!response.ok) throw new Error(`Audio source could not be loaded: HTTP ${response.status}`)
  const bytes = await response.arrayBuffer()
  const Context = typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : typeof AudioContext !== 'undefined' ? AudioContext : null
  if (!Context) throw new Error('This browser cannot decode an output waveform.')
  const context = new Context(1, 1, 24000)
  try {
    const decoded = await context.decodeAudioData(bytes)
    return buildPeakEnvelope(decoded.getChannelData(0), bins)
  } finally {
    if ('close' in context && typeof context.close === 'function') await context.close().catch(() => undefined)
  }
}
