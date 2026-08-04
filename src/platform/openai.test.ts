// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  getOpenAiTtsServerStatus,
  openAiTtsServerAvailable,
  startOpenAiTtsServer,
  stopOpenAiTtsServer,
} from './openai.ts'

afterEach(() => {
  delete window.betterttsPlatform
})

describe('local OpenAI-compatible TTS bridge', () => {
  it('reports the web build as unavailable and stopped', async () => {
    expect(openAiTtsServerAvailable()).toBe(false)
    await expect(getOpenAiTtsServerStatus()).resolves.toMatchObject({ running: false, endpoint: null })
    await expect(stopOpenAiTtsServer()).resolves.toMatchObject({ running: false })
  })

  it('delegates status, start, and stop to the desktop bridge', async () => {
    const status = { running: true, host: '127.0.0.1' as const, port: 8765, endpoint: 'http://127.0.0.1:8765', models: ['kokoro'] }
    const calls: string[] = []
    window.betterttsPlatform = {
      isDesktop: true,
      kind: 'desktop',
      versions: { electron: '43', chrome: '134', node: '22' },
      openAiServer: {
        status: async () => { calls.push('status'); return status },
        start: async (port) => { calls.push(`start:${port}`); return status },
        stop: async () => { calls.push('stop'); return { ...status, running: false, port: null, endpoint: null } },
      },
    }
    expect(openAiTtsServerAvailable()).toBe(true)
    await expect(getOpenAiTtsServerStatus()).resolves.toEqual(status)
    await expect(startOpenAiTtsServer(8765)).resolves.toEqual(status)
    await expect(stopOpenAiTtsServer()).resolves.toMatchObject({ running: false })
    expect(calls).toEqual(['status', 'start:8765', 'stop'])
  })

  it('rejects ports outside the user-facing range before IPC', async () => {
    window.betterttsPlatform = {
      isDesktop: true,
      kind: 'desktop',
      versions: { electron: '43', chrome: '134', node: '22' },
      openAiServer: { status: async () => ({ running: false, host: '127.0.0.1', port: null, endpoint: null, models: [] }), start: async () => { throw new Error('should not call') }, stop: async () => ({ running: false, host: '127.0.0.1', port: null, endpoint: null, models: [] }) },
    }
    await expect(startOpenAiTtsServer(1023)).rejects.toThrow('1024')
    await expect(startOpenAiTtsServer(65_536)).rejects.toThrow('65535')
  })
})
