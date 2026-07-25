/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

type ShellCacheRequestFactory = (request: Request) => Request | null

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
