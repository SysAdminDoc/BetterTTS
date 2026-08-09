// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  MAX_SHARE_TARGET_FILE_BYTES,
  SHARE_TARGET_CACHE_NAME,
  SHARE_TARGET_SCHEMA_VERSION,
  SHARE_TARGET_TTL_MS,
  consumeShareTarget,
  isShareTargetToken,
  isSupportedShareTargetFile,
  shareTargetRequest,
  validateShareTargetFileMetadata,
  validateShareTargetMetadata,
} from './share-target.ts'

class MemoryCache {
  private readonly entries = new Map<string, Response>()

  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)
  }

  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, response)
  }

  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url)
  }
}

describe('PWA share target handoff', () => {
  it('accepts supported document extensions or MIME types and rejects unsafe files', () => {
    expect(isSupportedShareTargetFile('chapter.epub', '')).toBe(true)
    expect(isSupportedShareTargetFile('chapter.bin', 'application/pdf')).toBe(true)
    expect(isSupportedShareTargetFile('chapter.exe', 'application/octet-stream')).toBe(false)
    expect(validateShareTargetFileMetadata({ name: 'empty.txt', type: 'text/plain', size: 0 })?.code).toBe('invalid-file')
    expect(validateShareTargetFileMetadata({ name: 'large.txt', type: 'text/plain', size: MAX_SHARE_TARGET_FILE_BYTES + 1 })?.message).toContain('25 MB')
  })

  it('validates schema, expiry, and non-empty payload before import', () => {
    const now = 1_000_000
    const metadata = {
      schemaVersion: SHARE_TARGET_SCHEMA_VERSION,
      token: 'share-token-1234567890',
      createdAt: now,
      text: 'Hello from share',
    }
    expect(isShareTargetToken(metadata.token)).toBe(true)
    expect(validateShareTargetMetadata(metadata, now)).toEqual([])
    expect(validateShareTargetMetadata({ ...metadata, createdAt: now - SHARE_TARGET_TTL_MS - 1 }, now)).toEqual([
      expect.objectContaining({ code: 'invalid-token' }),
    ])
    expect(validateShareTargetMetadata({ ...metadata, text: '' }, now)).toEqual([
      expect.objectContaining({ code: 'empty-payload' }),
    ])
  })

  it('consumes a file handoff once and deletes metadata plus file entries', async () => {
    const cache = new MemoryCache()
    const token = 'share-token-1234567890'
    const createdAt = 1_000_000
    const file = new File(['hello'], 'chapter.txt', { type: 'text/plain' })
    await cache.put(
      shareTargetRequest(token, 'metadata'),
      new Response(JSON.stringify({
        schemaVersion: SHARE_TARGET_SCHEMA_VERSION,
        token,
        createdAt,
        file: { name: file.name, type: file.type, size: file.size },
      })),
    )
    await cache.put(shareTargetRequest(token, 'file'), new Response('hello', { headers: { 'Content-Type': file.type } }))
    expect(validateShareTargetMetadata({
      schemaVersion: SHARE_TARGET_SCHEMA_VERSION,
      token,
      createdAt,
      file: { name: file.name, type: file.type, size: file.size },
    }, createdAt)).toEqual([])
    const cacheStorage = { open: async (name: string) => {
      expect(name).toBe(SHARE_TARGET_CACHE_NAME)
      return cache
    } } as unknown as CacheStorage

    const payload = await consumeShareTarget(token, { cacheStorage, now: createdAt })
    expect(payload?.file?.name).toBe('chapter.txt')
    expect(await payload?.file?.text()).toBe('hello')
    await expect(consumeShareTarget(token, { cacheStorage, now: createdAt })).resolves.toBeNull()
  })
})
