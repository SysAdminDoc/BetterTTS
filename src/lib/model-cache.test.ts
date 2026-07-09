import { describe, expect, it } from 'vitest'
import { classifyModelCacheEntry, kokoroQ8PrefetchPaths, summarizeModelCacheEntries } from './model-cache.ts'

describe('model cache inventory', () => {
  it('classifies cache entries by engine and shell ownership', () => {
    expect(classifyModelCacheEntry('bettertts-shell-123', 'https://example.test/BetterTTS/assets/index.js')).toBe('shell')
    expect(classifyModelCacheEntry('transformers-cache', 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx')).toBe('kokoro')
    expect(classifyModelCacheEntry('kokoro-voices', 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin')).toBe('kokoro')
    expect(classifyModelCacheEntry('transformers-cache', 'https://huggingface.co/onnx-community/Supertonic-TTS-ONNX/resolve/main/model.onnx')).toBe('supertonic')
    expect(classifyModelCacheEntry('transformers-cache', 'https://huggingface.co/KittenML/kitten-tts-nano-0.1/resolve/main/model.json')).toBe('kitten')
    expect(classifyModelCacheEntry('other-cache', 'https://example.test/file.bin')).toBe('other')
  })

  it('summarizes per-engine bytes and unknown response sizes', () => {
    const summary = summarizeModelCacheEntries([
      { cacheName: 'transformers-cache', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/config.json', sizeBytes: 100 },
      { cacheName: 'kokoro-voices', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin', sizeBytes: 200 },
      { cacheName: 'bettertts-shell-1', url: 'https://example.test/BetterTTS/index.html', sizeBytes: null },
      { cacheName: 'transformers-cache', url: 'https://huggingface.co/KittenML/kitten-tts-mini/resolve/main/model.onnx', sizeBytes: 300 },
    ])

    expect(summary.totalBytes).toBe(600)
    expect(summary.unknownSizeCount).toBe(1)
    expect(summary.engines.find((engine) => engine.id === 'kokoro')?.sizeBytes).toBe(300)
    expect(summary.engines.find((engine) => engine.id === 'shell')?.unknownSizeCount).toBe(1)
    expect(summary.engines.find((engine) => engine.id === 'supertonic')?.entryCount).toBe(0)
  })

  it('builds a selected Kokoro q8 prefetch manifest', () => {
    expect(kokoroQ8PrefetchPaths('af_heart')).toEqual([
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_quantized.onnx',
      'voices/af_heart.bin',
    ])
  })
})
