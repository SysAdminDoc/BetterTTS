import { installKokoroAssetFallback, kokoroRemoteAssetUrl } from './kokoro-assets.ts'
import type { VoiceId } from './voices.ts'

const CACHE_NAME = 'kokoro-voices'
const STYLE_FLOATS = 510 * 256

const binCache = new Map<string, Float32Array>()

export async function fetchVoiceBin(voiceId: string): Promise<Float32Array> {
  if (binCache.has(voiceId)) return binCache.get(voiceId)!
  installKokoroAssetFallback()
  const url = kokoroRemoteAssetUrl(`voices/${voiceId}.bin`)

  let cache: Cache | undefined
  try {
    cache = await caches.open(CACHE_NAME)
    const cached = await cache.match(url)
    if (cached) {
      const buf = await cached.arrayBuffer()
      const data = new Float32Array(buf)
      binCache.set(voiceId, data)
      return data
    }
  } catch { /* cache unavailable */ }

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch voice bin for ${voiceId}: ${res.status}`)
  const buf = await res.arrayBuffer()
  if (cache) {
    try { await cache.put(url, new Response(buf, { headers: res.headers })) } catch { /* ignore */ }
  }
  const data = new Float32Array(buf)
  binCache.set(voiceId, data)
  return data
}

export type VoiceMixEntry = {
  voiceId: VoiceId
  weight: number
}

export function blendVoiceBins(bins: { data: Float32Array; weight: number }[]): Float32Array {
  if (bins.length === 0) throw new Error('No voice bins to blend')
  if (bins.length === 1) return bins[0].data

  const totalWeight = bins.reduce((sum, b) => sum + b.weight, 0)
  if (totalWeight <= 0) throw new Error('Total weight must be positive')

  const result = new Float32Array(STYLE_FLOATS)
  for (const bin of bins) {
    const w = bin.weight / totalWeight
    for (let i = 0; i < STYLE_FLOATS && i < bin.data.length; i++) {
      result[i] += bin.data[i] * w
    }
  }
  return result
}

export type VoiceMixFormula = {
  name: string
  entries: VoiceMixEntry[]
}

export function parseMixFormula(formula: string): VoiceMixEntry[] | null {
  const parts = formula.trim().split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return null

  const entries: VoiceMixEntry[] = []
  for (const part of parts) {
    const match = part.match(/^([a-z_]+)\s*(?:\((\d+(?:\.\d+)?)\))?$/i)
    if (!match) return null
    entries.push({
      voiceId: match[1] as VoiceId,
      weight: match[2] ? Number.parseFloat(match[2]) : 1,
    })
  }
  return entries
}

export function formatMixFormula(entries: VoiceMixEntry[]): string {
  return entries
    .map((e) => (e.weight === 1 ? e.voiceId : `${e.voiceId}(${e.weight})`))
    .join(' + ')
}
