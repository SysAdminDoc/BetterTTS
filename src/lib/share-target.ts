export const SHARE_TARGET_SCHEMA_VERSION = 1
export const SHARE_TARGET_CACHE_NAME = 'bettertts-share-target-v1'
export const SHARE_TARGET_TOKEN_PARAM = 'share'
export const SHARE_TARGET_TTL_MS = 10 * 60 * 1_000
export const MAX_SHARE_TARGET_FILE_BYTES = 25 * 1024 * 1024
export const MAX_SHARE_TARGET_TEXT_CHARS = 100_000
export const MAX_SHARE_TARGET_URL_CHARS = 2_048
export const MAX_SHARE_TARGET_TITLE_CHARS = 200

const SHARE_TARGET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u
const SHARE_TARGET_FILE_EXTENSIONS = new Set(['.txt', '.epub', '.pdf', '.docx'])
const SHARE_TARGET_FILE_TYPES = new Set([
  'text/plain',
  'application/epub+zip',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

export type ShareTargetFileMetadata = {
  readonly name: string
  readonly type: string
  readonly size: number
}

export type ShareTargetMetadata = {
  readonly schemaVersion: typeof SHARE_TARGET_SCHEMA_VERSION
  readonly token: string
  readonly createdAt: number
  readonly title?: string
  readonly text?: string
  readonly url?: string
  readonly file?: ShareTargetFileMetadata
}

export type ShareTargetPayload = {
  readonly title?: string
  readonly text?: string
  readonly url?: string
  readonly file?: File
}

export type ShareTargetHandlers = {
  readonly onUnavailable: () => void
  readonly onFile: (file: File) => void | Promise<void>
  readonly onUrl: (url: string) => void | Promise<void>
  readonly onText: (text: string) => void
}

export type ShareTargetValidationIssue = {
  readonly code: 'invalid-token' | 'invalid-text' | 'invalid-url' | 'invalid-title' | 'invalid-file' | 'empty-payload'
  readonly message: string
}

export function isShareTargetToken(value: string): boolean {
  return SHARE_TARGET_TOKEN_PATTERN.test(value)
}

export function shareTargetFileExtension(name: string): string {
  const normalized = name.trim().toLowerCase()
  const index = normalized.lastIndexOf('.')
  return index >= 0 ? normalized.slice(index) : ''
}

export function isSupportedShareTargetFile(name: string, type = ''): boolean {
  const normalizedType = type.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return SHARE_TARGET_FILE_EXTENSIONS.has(shareTargetFileExtension(name)) || SHARE_TARGET_FILE_TYPES.has(normalizedType)
}

export function validateShareTargetFileMetadata(
  file: Pick<ShareTargetFileMetadata, 'name' | 'type' | 'size'>,
): ShareTargetValidationIssue | null {
  if (!file.name.trim() || file.name.length > 255 || !isSupportedShareTargetFile(file.name, file.type)) {
    return { code: 'invalid-file', message: 'Share supports .txt, .epub, .pdf, and .docx files.' }
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return { code: 'invalid-file', message: 'The shared file is empty or has an invalid size.' }
  }
  if (file.size > MAX_SHARE_TARGET_FILE_BYTES) {
    return { code: 'invalid-file', message: `Shared files must be ${formatShareTargetBytes(MAX_SHARE_TARGET_FILE_BYTES)} or smaller.` }
  }
  return null
}

export function validateShareTargetMetadata(metadata: unknown, now = Date.now()): ShareTargetValidationIssue[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return [{ code: 'empty-payload', message: 'The share handoff was empty.' }]
  }
  const value = metadata as Partial<ShareTargetMetadata>
  const issues: ShareTargetValidationIssue[] = []
  if (value.schemaVersion !== SHARE_TARGET_SCHEMA_VERSION || typeof value.token !== 'string' || !isShareTargetToken(value.token)) {
    issues.push({ code: 'invalid-token', message: 'The share handoff token is invalid.' })
  }
  const createdAt = value.createdAt
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || Math.abs(now - createdAt) > SHARE_TARGET_TTL_MS) {
    issues.push({ code: 'invalid-token', message: 'The share handoff expired. Share the file again.' })
  }
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > MAX_SHARE_TARGET_TITLE_CHARS)) {
    issues.push({ code: 'invalid-title', message: 'The shared title is invalid.' })
  }
  if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > MAX_SHARE_TARGET_TEXT_CHARS)) {
    issues.push({ code: 'invalid-text', message: 'Shared text is too long.' })
  }
  if (value.url !== undefined && (typeof value.url !== 'string' || value.url.length > MAX_SHARE_TARGET_URL_CHARS)) {
    issues.push({ code: 'invalid-url', message: 'The shared URL is invalid or too long.' })
  }
  if (value.file !== undefined) {
    if (!value.file || typeof value.file !== 'object') {
      issues.push({ code: 'invalid-file', message: 'The shared file metadata is invalid.' })
    } else {
      const fileIssue = validateShareTargetFileMetadata(value.file)
      if (fileIssue) issues.push(fileIssue)
    }
  }
  if (!value.text?.trim() && !value.url?.trim() && !value.file) {
    issues.push({ code: 'empty-payload', message: 'The share handoff did not contain text, a URL, or a supported file.' })
  }
  return issues
}

export function formatShareTargetBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

export function shareTargetRequest(token: string, part: 'metadata' | 'file'): Request {
  if (!isShareTargetToken(token)) throw new Error('Invalid share handoff token.')
  return new Request(`https://bettertts.invalid/__bettertts_share_target__/${encodeURIComponent(token)}/${part}`)
}

export function shareTargetCacheKey(token: string, part: 'metadata' | 'file'): string {
  return shareTargetRequest(token, part).url
}

function parseMetadata(value: unknown): ShareTargetMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const metadata = value as Partial<ShareTargetMetadata>
  return metadata.schemaVersion === SHARE_TARGET_SCHEMA_VERSION && typeof metadata.token === 'string'
    ? metadata as ShareTargetMetadata
    : null
}

export async function consumeShareTarget(
  token: string,
  options: { cacheStorage?: CacheStorage; now?: number } = {},
): Promise<ShareTargetPayload | null> {
  if (!isShareTargetToken(token)) return null
  const cacheStorage = options.cacheStorage ?? (typeof caches === 'undefined' ? null : caches)
  if (!cacheStorage) return null

  let cache: Cache
  try {
    cache = await cacheStorage.open(SHARE_TARGET_CACHE_NAME)
  } catch {
    return null
  }

  const metadataRequest = shareTargetRequest(token, 'metadata')
  const fileRequest = shareTargetRequest(token, 'file')
  try {
    const metadataResponse = await cache.match(metadataRequest)
    if (!metadataResponse) return null
    const metadata = parseMetadata(await metadataResponse.json())
    if (!metadata || metadata.token !== token || validateShareTargetMetadata(metadata, options.now).length > 0) return null

    let file: File | undefined
    if (metadata.file) {
      const fileResponse = await cache.match(fileRequest)
      if (!fileResponse) return null
      const blob = await fileResponse.blob()
      if (blob.size !== metadata.file.size) return null
      const type = metadata.file.type || blob.type || 'application/octet-stream'
      file = new File([blob], metadata.file.name, { type })
      const fileIssue = validateShareTargetFileMetadata(file)
      if (fileIssue) return null
    }
    return {
      ...(metadata.title ? { title: metadata.title } : {}),
      ...(metadata.text ? { text: metadata.text } : {}),
      ...(metadata.url ? { url: metadata.url } : {}),
      ...(file ? { file } : {}),
    }
  } catch {
    return null
  } finally {
    // A successful or malformed token is one-shot. This prevents a browser
    // retry, back-button replay, or copied token from re-importing the file.
    await Promise.allSettled([cache.delete(metadataRequest), cache.delete(fileRequest)])
  }
}

export async function handleShareTargetToken(token: string, handlers: ShareTargetHandlers): Promise<void> {
  const payload = await consumeShareTarget(token)
  if (!payload) {
    handlers.onUnavailable()
    return
  }
  if (payload.file) {
    await handlers.onFile(payload.file)
    return
  }
  const urlFromText = payload.text?.match(/https?:\/\/\S+/)?.[0] ?? null
  const sharedUrl = payload.url || urlFromText
  if (sharedUrl) {
    await handlers.onUrl(sharedUrl)
  } else if (payload.text) {
    handlers.onText(payload.text)
  }
}
