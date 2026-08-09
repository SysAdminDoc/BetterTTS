export const MAX_WAVEFORM_BINS = 180
export const MAX_WAVEFORM_DECODE_BYTES = 32 * 1024 * 1024
export const MAX_WAVEFORM_DECODE_SECONDS = 30 * 60

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

export async function readBoundedResponseBytes(response: Response, maxBytes = MAX_WAVEFORM_DECODE_BYTES): Promise<ArrayBuffer> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Waveform decoding is limited to ${Math.round(maxBytes / (1024 * 1024))} MB.`)
  }
  if (!response.body) {
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > maxBytes) throw new Error(`Waveform decoding is limited to ${Math.round(maxBytes / (1024 * 1024))} MB.`)
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > maxBytes) {
        await reader.cancel('waveform decode limit exceeded')
        throw new Error(`Waveform decoding is limited to ${Math.round(maxBytes / (1024 * 1024))} MB.`)
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes.buffer
}

export async function decodeAudioPeaks(src: string, bins = MAX_WAVEFORM_BINS, signal?: AbortSignal): Promise<number[]> {
  if (!src) throw new Error('Audio source is missing.')
  const response = await fetch(src, signal ? { signal } : undefined)
  if (!response.ok) throw new Error(`Audio source could not be loaded: HTTP ${response.status}`)
  const bytes = await readBoundedResponseBytes(response)
  const Context = typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : typeof AudioContext !== 'undefined' ? AudioContext : null
  if (!Context) throw new Error('This browser cannot decode an output waveform.')
  const context = new Context(1, 1, 24000)
  try {
    const decoded = await context.decodeAudioData(bytes)
    if (decoded.duration > MAX_WAVEFORM_DECODE_SECONDS) {
      throw new Error(`Waveform decoding is limited to ${Math.round(MAX_WAVEFORM_DECODE_SECONDS / 60)} minutes.`)
    }
    return buildPeakEnvelope(decoded.getChannelData(0), bins)
  } finally {
    if ('close' in context && typeof context.close === 'function') await context.close().catch(() => undefined)
  }
}
