import { describe, expect, it } from 'vitest'
import {
  ArticleImportPolicyError,
  fetchArticleResponse,
  formatArticleImportDestination,
  normalizeArticleImportUrl,
  readArticleResponseText,
} from './article-import.ts'

describe('readArticleResponseText', () => {
  it('reads supported article text responses', async () => {
    const response = new Response('<article>Hello</article>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })

    await expect(readArticleResponseText(response, 128)).resolves.toBe('<article>Hello</article>')
  })

  it('rejects unsupported content types before reading the body', async () => {
    const response = new Response('not an article', {
      headers: { 'content-type': 'image/svg+xml' },
    })

    await expect(readArticleResponseText(response, 128)).rejects.toThrow('Unsupported article content type')
  })

  it('rejects oversized content-length before reading the body', async () => {
    const response = new Response('small body', {
      headers: {
        'content-length': '4096',
        'content-type': 'text/html',
      },
    })

    await expect(readArticleResponseText(response, 128)).rejects.toThrow('Article response is too large')
  })

  it('cancels streaming responses once the byte cap is crossed', async () => {
    let cancelled = false
    let pullCount = 0
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1
        controller.enqueue(encoder.encode('x'.repeat(80)))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = new Response(stream, {
      headers: { 'content-type': 'text/html' },
    })

    await expect(readArticleResponseText(response, 128)).rejects.toThrow('Article response is too large')
    expect(cancelled).toBe(true)
    expect(pullCount).toBeLessThan(4)
  })
})

describe('article destination policy', () => {
  it('defaults bare hosts to HTTPS and rejects credentials, insecure schemes, and local destinations', () => {
    expect(normalizeArticleImportUrl('example.com/story').toString()).toBe('https://example.com/story')
    expect(() => normalizeArticleImportUrl('http://example.com/story')).toThrow(ArticleImportPolicyError)
    expect(() => normalizeArticleImportUrl('file:///Users/alice/story.html')).toThrow(ArticleImportPolicyError)
    expect(() => normalizeArticleImportUrl('https://user:password@example.com/story')).toThrow(/credentials/)

    for (const value of [
      'https://localhost/story',
      'https://printer.local/story',
      'https://10.0.0.2/story',
      'https://192.168.1.2/story',
      'https://169.254.1.2/story',
      'https://[::1]/story',
      'https://[fd00::2]/story',
      'https://[fe80::2]/story',
    ]) {
      expect(() => normalizeArticleImportUrl(value)).toThrow(/local, private|public hostname/)
    }
  })

  it('uses credential-free manual CORS requests and validates an exposed final URL', async () => {
    const calls: RequestInit[] = []
    const response = new Response('<article>Final</article>', { headers: { 'content-type': 'text/html' } })
    Object.defineProperty(response, 'url', { value: 'https://example.com/final/article' })
    const result = await fetchArticleResponse(normalizeArticleImportUrl('https://example.com/start'), {
      fetchImpl: async (_input, init) => {
        calls.push(init ?? {})
        return response
      },
    })

    expect(calls[0]).toMatchObject({
      credentials: 'omit',
      mode: 'cors',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
    })
    expect(result.finalUrl.toString()).toBe('https://example.com/final/article')
    expect(formatArticleImportDestination(new URL('https://example.com/final/article?token=secret#story'))).toBe('https://example.com/final/article')
  })

  it('follows only inspectable public redirects and enforces the hop limit', async () => {
    let calls = 0
    const result = await fetchArticleResponse(normalizeArticleImportUrl('https://source.example.com/start'), {
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) return new Response(null, { status: 302, headers: { location: 'https://example.com/final' } })
        const response = new Response('<article>Final</article>', { headers: { 'content-type': 'text/html' } })
        Object.defineProperty(response, 'url', { value: 'https://example.com/final' })
        return response
      },
    })
    expect(result.redirectCount).toBe(1)
    expect(result.finalUrl.hostname).toBe('example.com')

    await expect(fetchArticleResponse(normalizeArticleImportUrl('https://source.example.com/start'), {
      maxRedirects: 1,
      fetchImpl: async (input) => new Response(null, { status: 302, headers: { location: `${String(input)}/next` } }),
    })).rejects.toMatchObject({ code: 'redirect-limit' })
  })

  it('blocks private and opaque redirects and preserves CORS failures', async () => {
    await expect(fetchArticleResponse(normalizeArticleImportUrl('https://example.com/start'), {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/admin' } }),
    })).rejects.toMatchObject({ code: 'private-destination' })

    await expect(fetchArticleResponse(normalizeArticleImportUrl('https://example.com/start'), {
      fetchImpl: async () => new Response(null, { status: 302 }),
    })).rejects.toMatchObject({ code: 'redirect-uninspectable' })

    const corsError = new TypeError('Failed to fetch')
    await expect(fetchArticleResponse(normalizeArticleImportUrl('https://example.com/start'), {
      fetchImpl: async () => { throw corsError },
    })).rejects.toBe(corsError)
  })

  it('aborts a stalled redirect hop', async () => {
    await expect(fetchArticleResponse(normalizeArticleImportUrl('https://example.com/start'), {
      hopTimeoutMs: 5,
      fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      }),
    })).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})
