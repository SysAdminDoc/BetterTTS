/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

type ShellCacheRequestFactory = (request: Request) => Request | null

type ServiceWorkerContext = {
  listeners: Map<string, (event: { waitUntil: (promise: Promise<unknown>) => void }) => void>
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
  const listeners = new Map<string, (event: { waitUntil: (promise: Promise<unknown>) => void }) => void>()
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
  }
  const worker = {
    navigator: { userAgent: 'Chrome/120' },
    location: { origin: 'https://example.test' },
    addEventListener: (type: string, listener: (event: { waitUntil: (promise: Promise<unknown>) => void }) => void) => listeners.set(type, listener),
    skipWaiting: () => { context.skipWaitingCalls += 1 },
    clients: { claim: () => undefined },
  }
  Object.assign(context, { URL, Request, caches: cachesApi, self: worker })
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
