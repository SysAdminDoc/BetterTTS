import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDesktopDiagnostics,
  clearDesktopLogs,
  getDesktopLogs,
  recordDesktopLog,
  sanitizeDesktopText,
} from './desktop-diagnostics.ts'

afterEach(() => {
  clearDesktopLogs()
})

describe('desktop diagnostics logs', () => {
  it('keeps a bounded redacted native log ring', () => {
    recordDesktopLog('error', 'qwen.stderr', 'Bearer abc123 C:\\Users\\alice\\AppData\\Roaming\\BetterTTS\\sidecar token=private')
    for (let index = 0; index < 105; index += 1) recordDesktopLog('info', 'test', `event ${index}`)

    const logs = getDesktopLogs()
    expect(logs).toHaveLength(100)
    expect(logs[0].message).toBe('event 5')
    expect(sanitizeDesktopText('C:\\Users\\alice\\project\\book.txt?password=secret')).not.toContain('alice')
    expect(sanitizeDesktopText('Bearer abc123?token=private')).toContain('Bearer REDACTED')
  })
})

describe('buildDesktopDiagnostics', () => {
  it('reports runtime and manifest state without user paths or imported URLs', () => {
    const snapshot = buildDesktopDiagnostics({
      selection: {
        engine: 'piper',
        engineStatus: 'Ready',
        runtime: 'sherpa-onnx-node',
        selectedModel: 'private script text must not be forwarded',
        modelRoutes: {
          piperModel: 'https://huggingface.co/csukuangfj/vits-piper-en_GB-cori-medium',
          importedArticle: 'https://article.test/private/story',
          localPath: 'C:\\Users\\alice\\project\\book.txt',
        },
      },
      generation: {
        engine: 'piper',
        runtime: 'sherpa-onnx-node',
        elapsedMs: 120,
        timeToFirstAudioMs: 60,
        audioDurationSeconds: 2,
        chars: 42,
      },
      runtime: {
        native: {
          runtime: 'sherpa-onnx-node',
          nativeAddon: { present: true },
          modelCacheDir: 'C:\\Users\\alice\\AppData\\Roaming\\BetterTTS\\native-models',
        },
        qwen: { available: false, message: 'Python unavailable' },
      },
    }, {
      appVersion: '0.24.0',
      electronVersion: '43.1.0',
      chromeVersion: '134.0.0.0',
      nodeVersion: '22.0.0',
      packaged: false,
      userDataPath: 'C:\\Users\\alice\\AppData\\Roaming\\BetterTTS',
      resourcesPath: 'C:\\Program Files\\BetterTTS\\resources',
      modelCachePath: 'C:\\Users\\alice\\AppData\\Roaming\\BetterTTS\\native-models',
      nativeManifests: {
        piper: {
          id: 'sherpa-piper-en-gb-cori-medium',
          modelId: 'csukuangfj/vits-piper-en_GB-cori-medium',
          revision: 'e304c95c578725ba9cab0cff451c4e5d9aaf889e',
          installed: true,
          verified: true,
          files: [{ path: 'model.onnx' }],
          totalBytes: 100,
          expectedBytes: 100,
        },
      },
      ffmpeg: { available: true, version: '7.0' },
    })

    const serialized = JSON.stringify(snapshot)
    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.selection.provider).toContain('Piper-plus')
    expect(snapshot.selection.modelManifest.status).toBe('verified')
    expect(snapshot.runtimes.native.nativeAddonPresent).toBe(true)
    expect(snapshot.ffmpeg).toMatchObject({ available: true, version: '7.0' })
    expect(snapshot.paths).toEqual({
      userData: '<user-data>',
      project: '<renderer-managed>',
      modelCache: '<user-data>/native-models',
      resources: '<resources>',
    })
    expect(serialized).not.toContain('alice')
    expect(serialized).not.toContain('article.test')
    expect(serialized).not.toContain('private script text')
    expect(snapshot.selection.modelRoutes.importedArticle).toBe('<url>')
  })
})
