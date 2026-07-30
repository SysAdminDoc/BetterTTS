import { formatBytes } from './text.ts'

export const MAX_BGM_FILE_BYTES = 20 * 1024 * 1024

export function validateBackgroundMusicFile(file: Pick<File, 'name' | 'size' | 'type'>, maxBytes = MAX_BGM_FILE_BYTES): string | null {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return 'Background music is empty or has an invalid size.'
  }
  if (file.type && !file.type.toLowerCase().startsWith('audio/')) {
    return 'Background music must be an audio file.'
  }
  if (file.size > maxBytes) {
    return `Background music must be ${formatBytes(maxBytes)} or smaller.`
  }
  return null
}
