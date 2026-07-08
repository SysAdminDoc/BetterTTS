export type TextSegment = { type: 'text'; content: string } | { type: 'pause'; duration: number }

export const PAUSE_TAG = /\[pause(?:\s+([\d.]+)\s*s?)?\]/gi

export function parsePauseTags(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(PAUSE_TAG)) {
    const before = text.slice(lastIndex, match.index)
    if (before.trim()) segments.push({ type: 'text', content: before.trim() })
    const duration = match[1] ? Number.parseFloat(match[1]) : 1
    if (duration > 0 && duration <= 30) segments.push({ type: 'pause', duration })
    lastIndex = match.index + match[0].length
  }

  const tail = text.slice(lastIndex)
  if (tail.trim()) segments.push({ type: 'text', content: tail.trim() })
  return segments.length > 0 ? segments : [{ type: 'text', content: text.trim() }]
}

export function splitIntoSentences(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  if (sentences.length === 0) return text.trim() ? [text.trim()] : []

  const chunks: string[] = []
  let buffer = ''

  for (const s of sentences) {
    if (buffer && buffer.length + s.length + 1 > 300) {
      chunks.push(buffer)
      buffer = s
    } else {
      buffer = buffer ? `${buffer} ${s}` : s
    }
  }
  if (buffer) chunks.push(buffer)
  return chunks
}

export function splitInput(text: string, separateLines: boolean): string[] {
  const normalized = text.trim()
  if (!normalized) return []
  if (!separateLines) return [normalized]

  return normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)

  return slug || 'tts4free-audio'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
