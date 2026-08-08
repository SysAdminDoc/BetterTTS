import { afterEach, describe, expect, it } from 'vitest'
import { createOpenAiTtsServer, type OpenAiTtsServer } from './openai-server.ts'

const servers: OpenAiTtsServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

function createTestServer() {
  const received: string[] = []
  const server = createOpenAiTtsServer({
    synthesize: async (request) => {
      received.push(`${request.model}:${request.voice}:${request.speed}`)
      const bytes = new Uint8Array(140_000)
      bytes.fill(7)
      return { bytes, mime: 'audio/wav', extension: '.wav', sampleRate: 24_000 }
    },
  })
  servers.push(server)
  return { server, received }
}

function authorization(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function speechRequest(token: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorization(token), ...extraHeaders },
    body: JSON.stringify(body),
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!condition()) throw new Error('Timed out waiting for the test condition.')
}

describe('OpenAI-compatible local TTS server', () => {
  it('parses model, voice, speed, format, and SSE options with safe defaults', async () => {
    const { server, received } = createTestServer()
    const started = await server.start(0)
    expect(started.running).toBe(true)
    expect(started.host).toBe('127.0.0.1')
    expect(started.port).toBeGreaterThan(0)
    if (!started.endpoint) throw new Error('Test server did not expose an endpoint.')
    if (!started.authToken) throw new Error('Test server did not issue an auth token.')

    const response = await fetch(`${started.endpoint}/v1/audio/speech`, {
      ...speechRequest(started.authToken, { input: 'Hello', model: 'kokoro-82m', voice: 'af_heart', speed: 1.1 }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('audio/wav')
    expect((await response.arrayBuffer()).byteLength).toBe(140_000)
    expect(received).toEqual(['kokoro-82m:af_heart:1.1'])
  })

  it('emits bounded SSE audio events followed by the OpenAI done marker', async () => {
    const { server } = createTestServer()
    const started = await server.start(0)
    if (!started.endpoint || !started.authToken) throw new Error('Test server did not start with a token.')
    const response = await fetch(`${started.endpoint}/v1/audio/speech`, {
      ...speechRequest(started.authToken, { input: 'Hello', model: 'kokoro', voice: 'af_heart', stream: true }),
    })
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(text).toContain('event: audio')
    expect(text).toContain('"index":0')
    expect(text).toContain('"index":1')
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  it('rejects invalid requests and fully closes its loopback listener', async () => {
    const { server } = createTestServer()
    const started = await server.start(0)
    if (!started.endpoint || !started.authToken) throw new Error('Test server did not expose an endpoint.')
    const bad = await fetch(`${started.endpoint}/v1/audio/speech`, {
      ...speechRequest(started.authToken, { input: 'Hello', model: 'unknown', voice: 'af_heart' }),
    })
    expect(bad.status).toBe(400)
    await expect(bad.json()).resolves.toMatchObject({ error: { code: 'invalid_request_error' } })

    await expect(fetch(`${started.endpoint}/missing`, { headers: authorization(started.authToken) })).resolves.toMatchObject({ status: 404 })
    const stopped = await server.stop()
    expect(stopped.running).toBe(false)
    expect(stopped.port).toBeNull()
    await expect(fetch(started.endpoint)).rejects.toThrow()
  })

  it('requires a per-start bearer token and reflects only an explicit browser origin', async () => {
    const { server } = createTestServer()
    const started = await server.start(0)
    if (!started.endpoint || !started.authToken) throw new Error('Test server did not start with a token.')

    await expect(fetch(`${started.endpoint}/health`)).resolves.toMatchObject({ status: 401 })
    await expect(fetch(`${started.endpoint}/health`, { headers: { Authorization: 'Bearer invalid' } })).resolves.toMatchObject({ status: 401 })

    const origin = 'http://localhost:5174'
    const health = await fetch(`${started.endpoint}/health`, { headers: { ...authorization(started.authToken), Origin: origin } })
    expect(health.status).toBe(200)
    expect(health.headers.get('access-control-allow-origin')).toBe(origin)
    expect(health.headers.get('access-control-allow-origin')).not.toBe('*')
    expect((await health.json() as { authToken?: string }).authToken).toBeUndefined()

    const preflight = await fetch(`${started.endpoint}/v1/audio/speech`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)

    const disallowed = await fetch(`${started.endpoint}/health`, { headers: { ...authorization(started.authToken), Origin: 'https://evil.example' } })
    expect(disallowed.status).toBe(403)
    expect(disallowed.headers.get('access-control-allow-origin')).toBeNull()
    const disallowedPreflight = await fetch(`${started.endpoint}/health`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })
    expect(disallowedPreflight.status).toBe(403)
  })

  it('rotates the capability on restart and revokes it on stop', async () => {
    const { server } = createTestServer()
    const first = await server.start(0)
    if (!first.authToken) throw new Error('First start did not issue a token.')
    const stopped = await server.stop()
    expect(stopped.authToken).toBeNull()
    const second = await server.start(0)
    expect(second.authToken).toBeTruthy()
    expect(second.authToken).not.toBe(first.authToken)
  })

  it('rejects concurrent work above the configured bound', async () => {
    let entered = false
    let release = () => {}
    const { server } = (() => {
      const server = createOpenAiTtsServer({
        maxConcurrentRequests: 1,
        synthesize: async (_request, signal) => await new Promise((resolve, reject) => {
          entered = true
          release = () => resolve({ bytes: new Uint8Array([1]), mime: 'audio/wav', extension: '.wav', sampleRate: 24_000 })
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }),
      })
      servers.push(server)
      return { server }
    })()
    const started = await server.start(0)
    if (!started.endpoint || !started.authToken) throw new Error('Test server did not start with a token.')
    const first = fetch(`${started.endpoint}/v1/audio/speech`, speechRequest(started.authToken, { input: 'one', voice: 'af_heart' }))
    await waitFor(() => entered)
    const second = await fetch(`${started.endpoint}/v1/audio/speech`, speechRequest(started.authToken, { input: 'two', voice: 'af_heart' }))
    expect(second.status).toBe(429)
    release()
    expect((await first).status).toBe(200)
  })

  it('enforces a bounded request rate and synthesis timeout', async () => {
    const { server } = (() => {
      const server = createOpenAiTtsServer({
        maxRequestsPerMinute: 1,
        requestTimeoutMs: 15,
        synthesize: async (_request, signal) => await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('native work stopped')), { once: true })
        }),
      })
      servers.push(server)
      return { server }
    })()
    const started = await server.start(0)
    if (!started.endpoint || !started.authToken) throw new Error('Test server did not start with a token.')
    const timedOut = await fetch(`${started.endpoint}/v1/audio/speech`, speechRequest(started.authToken, { input: 'one', voice: 'af_heart' }))
    expect(timedOut.status).toBe(504)
    await expect(timedOut.json()).resolves.toMatchObject({ error: { code: 'timeout_error' } })
    const rateLimited = await fetch(`${started.endpoint}/v1/audio/speech`, speechRequest(started.authToken, { input: 'two', voice: 'af_heart' }))
    expect(rateLimited.status).toBe(429)
    expect(rateLimited.headers.get('retry-after')).toBe('60')
  })

  it('cancels active synthesis during client disconnect and shutdown', async () => {
    let entered = false
    let aborted = false
    const { server } = (() => {
      const server = createOpenAiTtsServer({
        synthesize: async (_request, signal) => await new Promise((_resolve, reject) => {
          entered = true
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('cancelled'))
          }, { once: true })
        }),
      })
      servers.push(server)
      return { server }
    })()
    const started = await server.start(0)
    if (!started.endpoint || !started.authToken) throw new Error('Test server did not start with a token.')
    const pending = fetch(`${started.endpoint}/v1/audio/speech`, speechRequest(started.authToken, { input: 'one', voice: 'af_heart' }))
    await waitFor(() => entered)
    const stopped = await server.stop()
    expect(stopped.running).toBe(false)
    expect(stopped.authToken).toBeNull()
    await waitFor(() => aborted)
    await expect(pending).rejects.toThrow()
  })
})
