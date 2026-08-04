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

describe('OpenAI-compatible local TTS server', () => {
  it('parses model, voice, speed, format, and SSE options with safe defaults', async () => {
    const { server, received } = createTestServer()
    const started = await server.start(0)
    expect(started.running).toBe(true)
    expect(started.host).toBe('127.0.0.1')
    expect(started.port).toBeGreaterThan(0)
    if (!started.endpoint) throw new Error('Test server did not expose an endpoint.')

    const response = await fetch(`${started.endpoint}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Hello', model: 'kokoro-82m', voice: 'af_heart', speed: 1.1 }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('audio/wav')
    expect((await response.arrayBuffer()).byteLength).toBe(140_000)
    expect(received).toEqual(['kokoro-82m:af_heart:1.1'])
  })

  it('emits bounded SSE audio events followed by the OpenAI done marker', async () => {
    const { server } = createTestServer()
    const started = await server.start(0)
    const response = await fetch(`${started.endpoint}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Hello', model: 'kokoro', voice: 'af_heart', stream: true }),
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
    if (!started.endpoint) throw new Error('Test server did not expose an endpoint.')
    const bad = await fetch(`${started.endpoint}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Hello', model: 'unknown', voice: 'af_heart' }),
    })
    expect(bad.status).toBe(400)
    await expect(bad.json()).resolves.toMatchObject({ error: { code: 'invalid_request_error' } })

    await expect(fetch(`${started.endpoint}/missing`)).resolves.toMatchObject({ status: 404 })
    const stopped = await server.stop()
    expect(stopped.running).toBe(false)
    expect(stopped.port).toBeNull()
    await expect(fetch(started.endpoint)).rejects.toThrow()
  })
})
