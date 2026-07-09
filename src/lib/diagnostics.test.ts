import { afterEach, describe, expect, it } from 'vitest'
import {
  clearDiagnosticEvents,
  collectDiagnostics,
  getRecentDiagnosticEvents,
  recordDiagnosticEvent,
  sanitizeDiagnosticLocation,
  sanitizeDiagnosticText,
} from './diagnostics.ts'

afterEach(() => {
  clearDiagnosticEvents()
})

describe('diagnostic events', () => {
  it('redacts bearer tokens and query secrets before storing recent events', () => {
    recordDiagnosticEvent('error', 'Fetch failed: Bearer abc.def?token=secret&ok=1', 'https://example.test/?api_key=abc123')

    const events = getRecentDiagnosticEvents()
    expect(events).toHaveLength(1)
    expect(events[0].message).toContain('Bearer REDACTED')
    expect(events[0].message).toContain('token=REDACTED')
    expect(events[0].source).toContain('api_key=REDACTED')
  })

  it('keeps only the latest twenty diagnostic events', () => {
    for (let i = 0; i < 25; i += 1) recordDiagnosticEvent('warn', `event ${i}`)

    const events = getRecentDiagnosticEvents()
    expect(events).toHaveLength(20)
    expect(events[0].message).toBe('event 5')
    expect(events[19].message).toBe('event 24')
  })
})

describe('collectDiagnostics', () => {
  it('assembles app, browser, capability, storage, cache, selection, and recent event state', async () => {
    recordDiagnosticEvent('warn', 'AAC unavailable')

    const bundle = await collectDiagnostics({
      appVersion: '0.13.0',
      selection: {
        engine: 'kokoro',
        engineStatus: 'English US - WebAssembly q8',
        runtime: 'WebAssembly q8',
        voice: 'af_heart',
        language: 'en-us',
        format: 'opus',
        bitrate: 96,
        speed: 1,
        selectedModel: 'Kokoro q8',
        modelRoutes: {
          kokoroRemote: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/',
        },
      },
    }, {
      now: () => new Date('2026-07-09T00:00:00.000Z'),
      location: { href: 'https://example.test/BetterTTS/?url=https%3A%2F%2Farticle.example%2Fprivate&text=Shared%20article#clip' },
      navigator: {
        userAgent: 'UnitTest',
        platform: 'Win32',
        language: 'en-US',
        languages: ['en-US'],
        onLine: true,
        hardwareConcurrency: 8,
        deviceMemory: 16,
      },
      webGpu: async () => ({ supported: true, adapterAvailable: false, status: 'no adapter available' }),
      storage: async () => ({ supported: true, persisted: true, usageBytes: 10, quotaBytes: 100, usagePct: 10 }),
      cache: async () => ({ supported: true, engines: [], totalBytes: 0, unknownSizeCount: 0 }),
      m4b: async () => ({ supported: false, reason: 'aac-unsupported', message: 'AAC missing' }),
      opus: () => true,
      crossOriginStorage: () => ({
        api: 'navigator.crossOriginStorage',
        exposed: false,
        requestFileHandle: false,
        secureContext: true,
        usable: false,
        defaultBehavior: 'disabled',
        message: 'Cross-Origin Storage is not exposed.',
      }),
      transformers: () => ({
        currentVersion: '4.2.0',
        targetVersion: '4.3.0',
        readyToSwitch: false,
        criteria: [],
      }),
      piperPlus: () => ({
        packageVersion: '0.6.0',
        model: 'ayousanz/piper-plus-tsukuyomi-chan',
        modelLabel: 'Tsukuyomi-chan',
        supported: true,
        wasm: true,
        indexedDb: true,
        webGpu: false,
        defaultFirstLoad: false,
        notes: ['lazy'],
      }),
    })

    expect(bundle.generatedAt).toBe('2026-07-09T00:00:00.000Z')
    expect(bundle.app.version).toBe('0.13.0')
    expect(bundle.app.location).toBe('https://example.test/BetterTTS/')
    expect(bundle.browser).toMatchObject({ userAgent: 'UnitTest', hardwareConcurrency: 8, deviceMemoryGb: 16 })
    expect(bundle.capabilities.webGpu.status).toBe('no adapter available')
    expect(bundle.capabilities.webCodecs.opus).toBe(true)
    expect(bundle.capabilities.webCodecs.aacM4b.supported).toBe(false)
    expect(bundle.capabilities.crossOriginStorage.defaultBehavior).toBe('disabled')
    expect(bundle.capabilities.transformers.currentVersion).toBe('4.2.0')
    expect(bundle.capabilities.transformers.readyToSwitch).toBe(false)
    expect(bundle.capabilities.piperPlus.model).toBe('ayousanz/piper-plus-tsukuyomi-chan')
    expect(bundle.capabilities.piperPlus.defaultFirstLoad).toBe(false)
    expect(bundle.storage.browser.usagePct).toBe(10)
    expect(bundle.selection.modelRoutes.kokoroRemote).toContain('Kokoro-82M')
    expect(bundle.recentEvents[0].message).toBe('AAC unavailable')
  })
})

describe('sanitizeDiagnosticText', () => {
  it('redacts common secret patterns', () => {
    expect(sanitizeDiagnosticText('https://x.test/token/abc123?password=hunter2 Authorization: Basic abc123')).toBe(
      'https://x.test/token/REDACTED?password=REDACTED Authorization: Basic REDACTED',
    )
  })
})

describe('sanitizeDiagnosticLocation', () => {
  it('keeps app origin and path but removes share-target payloads', () => {
    expect(sanitizeDiagnosticLocation('https://x.test/BetterTTS/?url=https%3A%2F%2Fsource.test%2Fstory&text=Private#read')).toBe(
      'https://x.test/BetterTTS/',
    )
  })

  it('falls back safely for malformed locations', () => {
    expect(sanitizeDiagnosticLocation('not a url?token=abc#hash')).toBe('not a url')
  })
})
