// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

type WorkerListener = (event: MessageEvent<unknown> | Event) => void

class FakeWorker {
  static instances: FakeWorker[] = []
  terminated = false
  private listeners = new Map<string, WorkerListener[]>()

  constructor() {
    FakeWorker.instances.push(this)
  }

  addEventListener(type: string, listener: WorkerListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  postMessage(message: unknown) {
    const request = message as { id: number; kind: string }
    queueMicrotask(() => {
      this.emit('message', {
        data: { type: 'progress', id: request.id, phase: 'parse', done: 1, total: 1 },
      } as MessageEvent)
      this.emit('message', {
        data: {
          type: 'result',
          id: request.id,
          result: { kind: request.kind, title: 'Fixture', text: 'Worker text.' },
        },
      } as MessageEvent)
    })
  }

  terminate() {
    this.terminated = true
  }

  private emit(type: string, event: MessageEvent<unknown> | Event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function fixtureFile(name = 'fixture.pdf'): File {
  return {
    name,
    type: 'application/pdf',
    size: 3,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as File
}

beforeEach(() => {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.resetModules()
})

describe('document worker client', () => {
  it('transfers parsing off-thread and reports read/parse progress', async () => {
    const { importDocumentInWorker } = await import('./document-worker.ts')
    const progress: unknown[] = []
    const result = await importDocumentInWorker(fixtureFile(), (info) => progress.push(info))

    expect(result).toMatchObject({ kind: 'pdf', text: 'Worker text.' })
    expect(progress).toEqual([
      { phase: 'read', done: 0, total: 3 },
      { phase: 'read', done: 3, total: 3 },
      { phase: 'parse', done: 1, total: 1 },
    ])
    expect(FakeWorker.instances[0].terminated).toBe(true)
  })

  it('terminates the parser and rejects deterministically on cancellation', async () => {
    class WaitingWorker extends FakeWorker {
      override postMessage() {}
    }
    vi.stubGlobal('Worker', WaitingWorker)
    const { importDocumentInWorker } = await import('./document-worker.ts')
    const controller = new AbortController()
    const pending = importDocumentInWorker(fixtureFile(), () => {}, controller.signal)
    await Promise.resolve()
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances[0].terminated).toBe(true)
  })
})
