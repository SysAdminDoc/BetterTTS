/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

type ShellCacheRequestFactory = (request: Request) => Request | null

type ServiceWorkerContext = {
  listeners: Map<string, (event: {
    waitUntil?: (promise: Promise<unknown>) => void
    request?: Request
    respondWith?: (promise: Promise<Response>) => void
  }) => void>
  skipWaitingCalls: number
  deletedCaches: string[]
}

function loadShellCacheRequestFactory(): ShellCacheRequestFactory {
  const testDir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(resolve(testDir, '../../public/sw.js'), 'utf8')
  const context = {
    URL,
    Request,
    self: {
      navigator: { userAgent: 'Chrome/120' },
      location: { origin: 'https://example.test' },
      addEventListener: () => {},
      skipWaiting: () => undefined,
      clients: { claim: () => undefined },
    },
  }

  vm.createContext(context)
  vm.runInContext(source, context)
  return (context as typeof context & { createShellCacheRequest: ShellCacheRequestFactory }).createShellCacheRequest
}

function loadServiceWorkerLifecycle(): ServiceWorkerContext {
  const testDir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(resolve(testDir, '../../public/sw.js'), 'utf8')
  const listeners = new Map<string, (event: {
    waitUntil?: (promise: Promise<unknown>) => void
    request?: Request
    respondWith?: (promise: Promise<Response>) => void
  }) => void>()
  const context: ServiceWorkerContext & Record<string, unknown> = {
    listeners,
    skipWaitingCalls: 0,
    deletedCaches: [],
  }
  const cachesApi = {
    keys: async () => ['bettertts-shell-old', 'bettertts-shell-__BUILD_ID__', 'unrelated-cache'],
    delete: async (name: string) => {
      context.deletedCaches.push(name)
      return true
    },
    open: async () => ({
      keys: async () => [],
      match: async () => undefined,
      put: async () => undefined,
      delete: async () => false,
    }),
    match: async () => undefined,
  }
  const worker = {
    navigator: { userAgent: 'Chrome/120' },
    location: { origin: 'https://example.test' },
    addEventListener: (type: string, listener: (event: {
      waitUntil?: (promise: Promise<unknown>) => void
      request?: Request
      respondWith?: (promise: Promise<Response>) => void
    }) => void) => listeners.set(type, listener),
    skipWaiting: () => { context.skipWaitingCalls += 1 },
    clients: { claim: () => undefined },
  }
  Object.assign(context, {
    URL,
    Request,
    Response,
    FormData,
    File,
    Blob,
    caches: cachesApi,
    self: { ...worker, crypto: { randomUUID: () => 'share-token-1234567890' } },
  })
  vm.createContext(context)
  vm.runInContext(source, context)
  return context
}

describe('service worker shell cache keys', () => {
  const createShellCacheRequest = loadShellCacheRequestFactory()

  it('strips share-target query and hash payloads from shell cache keys', () => {
    const cacheRequest = createShellCacheRequest(new Request('https://example.test/BetterTTS/?text=secret&url=https%3A%2F%2Farticle.test%2Fprivate#clip'))

    expect(cacheRequest?.url).toBe('https://example.test/BetterTTS/')
  })

  it('keeps static same-origin assets with normalized cache keys', () => {
    const cacheRequest = createShellCacheRequest(new Request('https://example.test/BetterTTS/assets/index.js?v=123#bundle'))

    expect(cacheRequest?.url).toBe('https://example.test/BetterTTS/assets/index.js')
  })

  it('excludes model, api, non-get, and cross-origin requests from the shell cache', () => {
    expect(createShellCacheRequest(new Request('https://example.test/BetterTTS/models/onnx-community/Kokoro/model.onnx'))).toBeNull()
    expect(createShellCacheRequest(new Request('https://example.test/BetterTTS/api/health'))).toBeNull()
    expect(createShellCacheRequest(new Request('https://example.test/BetterTTS/', { method: 'POST' }))).toBeNull()
    expect(createShellCacheRequest(new Request('https://cdn.example.test/BetterTTS/assets/index.js'))).toBeNull()
  })

  it('hands off a supported multipart share file through a one-shot token', async () => {
    const testDir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(testDir, '../../public/sw.js'), 'utf8')
    const entries = new Map<string, Response>()
    const cache = {
      put: async (request: Request, response: Response) => { entries.set(request.url, response) },
      match: async (request: Request) => entries.get(request.url),
      delete: async (request: Request) => entries.delete(request.url),
      keys: async () => [...entries.keys()].map((url) => new Request(url)),
    }
    const listeners = new Map<string, (event: {
      waitUntil?: (promise: Promise<unknown>) => void
      request?: Request
      respondWith?: (promise: Promise<Response>) => void
    }) => void>()
    const context = {
      URL,
      Request,
      Response,
      FormData,
      File,
      Blob,
      self: {
        crypto: { randomUUID: () => 'share-token-1234567890' },
        navigator: { userAgent: 'Chrome/120' },
        location: { origin: 'https://example.test' },
        addEventListener: (type: string, listener: (event: {
          waitUntil?: (promise: Promise<unknown>) => void
          request?: Request
          respondWith?: (promise: Promise<Response>) => void
        }) => void) => listeners.set(type, listener),
      },
      caches: {
        open: async () => cache,
        keys: async () => [],
        match: async (request: Request) => entries.get(request.url),
      },
    }
    vm.createContext(context)
    vm.runInContext(source, context)
    const form = new FormData()
    form.append('title', 'Shared chapter')
    form.append('files', new File(['hello'], 'chapter.txt', { type: 'text/plain' }))
    const event = { request: new Request('https://example.test/BetterTTS/', { method: 'POST', body: form }) }
    let responsePromise: Promise<Response> | undefined
    listeners.get('fetch')?.({
      request: event.request,
      respondWith: (promise) => { responsePromise = promise },
    })
    const response = await responsePromise
    expect(response?.status).toBe(303)
    const location = response?.headers.get('location') ?? ''
    expect(location).toContain('/BetterTTS/?share=share-token-1234567890')
    expect(entries.size).toBe(2)
    const metadata = JSON.parse(await (await cache.match(new Request('https://bettertts.invalid/__bettertts_share_target__/share-token-1234567890/metadata')))?.text() ?? '{}')
    expect(metadata.file).toMatchObject({ name: 'chapter.txt', size: 5, type: 'text/plain' })
  })

  it('redirects unsupported or oversized share payloads without storing data', async () => {
    const context = loadServiceWorkerLifecycle()
    const fetchHandler = context.listeners.get('fetch')
    expect(fetchHandler).toBeDefined()
    const form = new FormData()
    form.append('files', new File(['not allowed'], 'payload.exe', { type: 'application/octet-stream' }))
    const request = new Request('https://example.test/BetterTTS/', { method: 'POST', body: form })
    let responsePromise: Promise<Response> | undefined
    fetchHandler?.({ request, respondWith: (promise) => { responsePromise = promise } })
    const response = await responsePromise
    expect(response?.status).toBe(303)
    expect(response?.headers.get('location')).toContain('share-error=invalid')
  })
})

describe('service worker update lifecycle', () => {
  it('leaves replacement workers waiting and cleans old generations only at activation', async () => {
    const context = loadServiceWorkerLifecycle()

    expect(context.listeners.has('install')).toBe(false)
    expect(context.skipWaitingCalls).toBe(0)

    const activation = context.listeners.get('activate')
    expect(activation).toBeDefined()
    let activationPromise: Promise<unknown> | undefined
    activation?.({ waitUntil: (promise) => { activationPromise = promise } })
    await activationPromise

    expect(context.deletedCaches).toEqual(['bettertts-shell-old'])
  })
})
