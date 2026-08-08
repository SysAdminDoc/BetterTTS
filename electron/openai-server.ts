import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

export const OPENAI_TTS_HOST = '127.0.0.1'
export const DEFAULT_OPENAI_TTS_PORT = 8765
export const MAX_OPENAI_INPUT_CHARS = 10_000
export const MAX_OPENAI_BODY_BYTES = 128 * 1024
export const OPENAI_SSE_CHUNK_BYTES = 64 * 1024
export const OPENAI_MAX_CONCURRENT_REQUESTS = 2
export const OPENAI_MAX_REQUESTS_PER_MINUTE = 30
export const OPENAI_RATE_WINDOW_MS = 60_000
export const OPENAI_REQUEST_TIMEOUT_MS = 180_000
export const OPENAI_DEFAULT_ALLOWED_ORIGINS = [
  'app://bettertts',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
] as const

export const OPENAI_MODEL_OPTIONS = [
  { id: 'kokoro', label: 'Kokoro local', engine: 'kokoro' },
  { id: 'kokoro-82m', label: 'Kokoro 82M', engine: 'kokoro' },
  { id: 'piper', label: 'Piper-plus', engine: 'piper' },
  { id: 'piper-plus', label: 'Piper-plus', engine: 'piper' },
  { id: 'melo', label: 'MeloTTS Chinese + English', engine: 'melo' },
] as const

export type OpenAiModelId = typeof OPENAI_MODEL_OPTIONS[number]['id']
export type OpenAiEngine = typeof OPENAI_MODEL_OPTIONS[number]['engine']
export type OpenAiResponseFormat = 'wav' | 'mp3' | 'opus' | 'flac'

export type OpenAiSpeechRequest = {
  input: string
  model: OpenAiModelId
  engine: OpenAiEngine
  voice: string
  speed: number
  responseFormat: OpenAiResponseFormat
  stream: boolean
}

export type OpenAiAudio = {
  bytes: Uint8Array
  mime: string
  extension: string
  sampleRate: number
}

export type OpenAiSpeechSynthesizer = (
  request: OpenAiSpeechRequest,
  signal: AbortSignal,
) => Promise<OpenAiAudio>

export type OpenAiTtsServerStatus = {
  running: boolean
  host: typeof OPENAI_TTS_HOST
  port: number | null
  endpoint: string | null
  authToken: string | null
  models: OpenAiModelId[]
  lastError?: string
}

export type OpenAiParseResult =
  | { ok: true; request: OpenAiSpeechRequest }
  | { ok: false; message: string }

export type OpenAiTtsServerOptions = {
  synthesize: OpenAiSpeechSynthesizer
  allowedOrigins?: readonly string[]
  maxConcurrentRequests?: number
  maxRequestsPerMinute?: number
  requestTimeoutMs?: number
}

const RESPONSE_FORMATS: readonly OpenAiResponseFormat[] = ['wav', 'mp3', 'opus', 'flac']

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

export function parseOpenAiSpeechRequest(value: unknown): OpenAiParseResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'The request body must be a JSON object.' }
  }
  const body = value as Record<string, unknown>
  if (!boundedString(body.input, MAX_OPENAI_INPUT_CHARS) || body.input.trim().length === 0) {
    return { ok: false, message: `input must be a non-empty string of ${MAX_OPENAI_INPUT_CHARS} characters or fewer.` }
  }

  const rawModel = body.model === undefined ? 'kokoro' : body.model
  if (!boundedString(rawModel, 100)) return { ok: false, message: 'model must be a non-empty string.' }
  const model = OPENAI_MODEL_OPTIONS.find((option) => option.id === rawModel.toLowerCase())
  if (!model) {
    return { ok: false, message: `Unsupported model. Choose one of: ${OPENAI_MODEL_OPTIONS.map((option) => option.id).join(', ')}.` }
  }

  if (!boundedString(body.voice, 100)) return { ok: false, message: 'voice must be a non-empty string of 100 characters or fewer.' }

  const speed = body.speed === undefined ? 1 : body.speed
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 1.5) {
    return { ok: false, message: 'speed must be a number between 0.5 and 1.5.' }
  }

  const rawFormat = body.response_format === undefined ? 'wav' : body.response_format
  if (typeof rawFormat !== 'string' || !RESPONSE_FORMATS.includes(rawFormat as OpenAiResponseFormat)) {
    return { ok: false, message: `response_format must be one of: ${RESPONSE_FORMATS.join(', ')}.` }
  }

  const stream = body.stream === undefined ? body.stream_format === 'sse' : body.stream
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return { ok: false, message: 'stream must be a boolean.' }
  }
  if (body.stream_format !== undefined && body.stream_format !== 'sse') {
    return { ok: false, message: 'stream_format must be "sse" when provided.' }
  }

  return {
    ok: true,
    request: {
      input: body.input,
      model: model.id,
      engine: model.engine,
      voice: body.voice,
      speed,
      responseFormat: rawFormat as OpenAiResponseFormat,
      stream: stream === true,
    },
  }
}

function corsHeaders(origin: string | undefined, allowedOrigins: ReadonlySet<string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  }
  if (origin && allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers.Vary = 'Origin'
  }
  return headers
}

function validBearerToken(value: string | string[] | undefined, expected: string | null): boolean {
  if (!expected || typeof value !== 'string') return false
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/iu.exec(value)
  if (!match) return false
  const actual = Buffer.from(match[1], 'utf8')
  const target = Buffer.from(expected, 'utf8')
  return actual.byteLength === target.byteLength && timingSafeEqual(actual, target)
}

function writeJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  const bytes = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    ...headers,
    'Content-Length': String(bytes.byteLength),
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(bytes)
}

function writeError(response: ServerResponse, status: number, message: string, code = 'invalid_request_error', headers: Record<string, string> = {}): void {
  writeJson(response, status, { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', code } }, headers)
}

function isAllowedOrigin(origin: string | undefined, allowedOrigins: ReadonlySet<string>): boolean {
  return !origin || allowedOrigins.has(origin)
}

/*
 * A response header origin is deliberately reflected only after an exact set
 * membership check.  The token is required independently, so CORS is not an
 * authentication mechanism.
 */
function unauthenticatedHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    'WWW-Authenticate': 'Bearer',
  }
}

async function readJsonBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false

    const cleanup = () => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += bytes.byteLength
      if (totalBytes > MAX_OPENAI_BODY_BYTES) {
        finish(() => reject(new Error(`Request body exceeds the ${MAX_OPENAI_BODY_BYTES}-byte limit.`)))
        request.destroy()
        return
      }
      chunks.push(bytes)
    }
    const onEnd = () => {
      finish(() => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
        } catch {
          reject(new Error('Request body is not valid JSON.'))
        }
      })
    }
    const onError = (error: Error) => finish(() => reject(error))
    const onAbort = () => finish(() => reject(new Error('The client disconnected.')))

    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => response.once('drain', resolve))
}

async function writeSse(response: ServerResponse, audio: OpenAiAudio, signal: AbortSignal, headers: Record<string, string>): Promise<void> {
  response.writeHead(200, {
    ...headers,
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  })
  const requestId = `bettertts-${randomUUID()}`
  const chunkCount = Math.max(1, Math.ceil(audio.bytes.byteLength / OPENAI_SSE_CHUNK_BYTES))
  for (let index = 0; index < chunkCount; index += 1) {
    if (signal.aborted || response.destroyed) return
    const start = index * OPENAI_SSE_CHUNK_BYTES
    const chunk = audio.bytes.slice(start, start + OPENAI_SSE_CHUNK_BYTES)
    const payload = JSON.stringify({
      id: requestId,
      type: 'audio',
      index,
      audio: Buffer.from(chunk).toString('base64'),
      format: audio.extension.replace(/^\./, ''),
      sample_rate: audio.sampleRate,
    })
    if (!response.write(`event: audio\ndata: ${payload}\n\n`) && !signal.aborted) await waitForDrain(response)
  }
  if (!signal.aborted && !response.destroyed) response.end('data: [DONE]\n\n')
}

export class OpenAiTtsServer {
  private readonly synthesize: OpenAiSpeechSynthesizer
  private readonly allowedOrigins: ReadonlySet<string>
  private readonly maxConcurrentRequests: number
  private readonly maxRequestsPerMinute: number
  private readonly requestTimeoutMs: number
  private server: Server | null = null
  private port: number | null = null
  private authToken: string | null = null
  private lastError: string | undefined
  private readonly sockets = new Set<Socket>()
  private readonly activeControllers = new Set<AbortController>()
  private activeRequests = 0
  private recentRequestTimes: number[] = []

  constructor(options: OpenAiTtsServerOptions) {
    this.synthesize = options.synthesize
    this.allowedOrigins = new Set(options.allowedOrigins ?? OPENAI_DEFAULT_ALLOWED_ORIGINS)
    this.maxConcurrentRequests = Math.max(1, Math.floor(options.maxConcurrentRequests ?? OPENAI_MAX_CONCURRENT_REQUESTS))
    this.maxRequestsPerMinute = Math.max(1, Math.floor(options.maxRequestsPerMinute ?? OPENAI_MAX_REQUESTS_PER_MINUTE))
    this.requestTimeoutMs = Math.max(1, Math.floor(options.requestTimeoutMs ?? OPENAI_REQUEST_TIMEOUT_MS))
  }

  status(): OpenAiTtsServerStatus {
    return {
      running: this.server?.listening === true,
      host: OPENAI_TTS_HOST,
      port: this.port,
      endpoint: this.port === null ? null : `http://${OPENAI_TTS_HOST}:${this.port}`,
      authToken: this.authToken,
      models: OPENAI_MODEL_OPTIONS.map((option) => option.id),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  async start(port = DEFAULT_OPENAI_TTS_PORT): Promise<OpenAiTtsServerStatus> {
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('The local TTS server port must be between 0 and 65535.')
    if (this.server?.listening && this.port === port) return this.status()
    if (this.server) await this.stop()

    const server = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    server.headersTimeout = 10_000
    server.requestTimeout = this.requestTimeoutMs + 10_000
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    this.server = server
    this.port = null
    this.authToken = null
    this.lastError = undefined

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen({ host: OPENAI_TTS_HOST, port })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('The local TTS server did not expose a TCP port.')
      this.port = address.port
      this.authToken = randomBytes(32).toString('base64url')
      return this.status()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.server = null
      this.port = null
      this.authToken = null
      server.close()
      throw error
    }
  }

  async stop(): Promise<OpenAiTtsServerStatus> {
    const server = this.server
    this.server = null
    this.port = null
    this.authToken = null
    for (const controller of this.activeControllers) controller.abort()
    if (server) {
      for (const socket of this.sockets) socket.destroy()
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
      })
    }
    this.sockets.clear()
    this.recentRequestTimes = []
    return this.status()
  }

  private admissionFailure(): 'busy' | 'rate' | null {
    const now = Date.now()
    this.recentRequestTimes = this.recentRequestTimes.filter((timestamp) => now - timestamp < OPENAI_RATE_WINDOW_MS)
    if (this.activeRequests >= this.maxConcurrentRequests) return 'busy'
    if (this.recentRequestTimes.length >= this.maxRequestsPerMinute) return 'rate'
    this.activeRequests += 1
    this.recentRequestTimes.push(now)
    return null
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${OPENAI_TTS_HOST}`)
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
    const headers = corsHeaders(origin, this.allowedOrigins)
    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin(origin, this.allowedOrigins)) {
        writeError(response, 403, 'Browser origin is not allowed.', 'origin_not_allowed', headers)
      } else {
        response.writeHead(204, headers)
        response.end()
      }
      return
    }
    if (!isAllowedOrigin(origin, this.allowedOrigins)) {
      writeError(response, 403, 'Browser origin is not allowed.', 'origin_not_allowed', headers)
      return
    }
    if (!validBearerToken(request.headers.authorization, this.authToken)) {
      writeError(response, 401, 'A valid Bearer token is required.', 'authentication_error', unauthenticatedHeaders(headers))
      return
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      const { authToken: _authToken, ...publicStatus } = this.status()
      writeJson(response, 200, { ok: true, ...publicStatus }, headers)
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      writeJson(response, 200, {
        object: 'list',
        data: OPENAI_MODEL_OPTIONS.map((option) => ({ id: option.id, object: 'model', owned_by: 'bettertts' })),
      }, headers)
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/audio/speech') {
      writeError(response, 404, 'Route not found.', 'not_found', headers)
      return
    }
    const admissionFailure = this.admissionFailure()
    if (admissionFailure === 'busy') {
      writeError(response, 429, 'The local TTS server is at its concurrent request limit.', 'server_busy', { ...headers, 'Retry-After': '5' })
      return
    }
    if (admissionFailure === 'rate') {
      writeError(response, 429, 'The local TTS server rate limit was reached.', 'rate_limit_error', { ...headers, 'Retry-After': '60' })
      return
    }

    const controller = new AbortController()
    this.activeControllers.add(controller)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.requestTimeoutMs)
    const onAborted = () => controller.abort()
    const onResponseClose = () => {
      if (!response.writableEnded) controller.abort()
    }
    request.once('aborted', onAborted)
    response.once('close', onResponseClose)
    try {
      const body = await readJsonBody(request, controller.signal)
      const parsed = parseOpenAiSpeechRequest(body)
      if (!parsed.ok) {
        writeError(response, 400, parsed.message, 'invalid_request_error', headers)
        return
      }
      const audio = await this.synthesize(parsed.request, controller.signal)
      if (controller.signal.aborted || response.destroyed) return
      if (parsed.request.stream) {
        await writeSse(response, audio, controller.signal, headers)
      } else {
        const bytes = Buffer.from(audio.bytes)
        response.writeHead(200, {
          ...headers,
          'Content-Length': String(bytes.byteLength),
          'Content-Type': audio.mime,
        })
        response.end(bytes)
      }
    } catch (error) {
      if (response.destroyed) return
      if (controller.signal.aborted) {
        if (timedOut) writeError(response, 504, 'The local TTS request timed out.', 'timeout_error', headers)
        return
      }
      const message = error instanceof Error ? error.message : 'Speech synthesis failed.'
      const status = message.includes('limit') || message.includes('JSON') ? 400 : 500
      writeError(response, status, message, status >= 500 ? 'synthesis_error' : 'invalid_request_error', headers)
    } finally {
      clearTimeout(timeout)
      this.activeControllers.delete(controller)
      this.activeRequests = Math.max(0, this.activeRequests - 1)
      request.off('aborted', onAborted)
      response.off('close', onResponseClose)
    }
  }
}

export function createOpenAiTtsServer(options: OpenAiTtsServerOptions): OpenAiTtsServer {
  return new OpenAiTtsServer(options)
}
