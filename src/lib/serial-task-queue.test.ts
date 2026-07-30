import { describe, expect, it } from 'vitest'
import { SerialTaskQueue } from './serial-task-queue.ts'

describe('SerialTaskQueue', () => {
  it('serializes work and drains tasks queued during an active save', async () => {
    const queue = new SerialTaskQueue()
    const events: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = queue.run(async () => {
      events.push('first:start')
      await gate
      events.push('first:end')
      return 1
    })
    const second = queue.run(async () => {
      events.push('second')
      return 2
    })
    expect(queue.size).toBe(2)
    await Promise.resolve()
    expect(events).toEqual(['first:start'])

    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    await queue.drain()
    expect(events).toEqual(['first:start', 'first:end', 'second'])
    expect(queue.size).toBe(0)
  })

  it('continues with the newest task after an earlier save fails', async () => {
    const queue = new SerialTaskQueue()
    const failed = queue.run(async () => { throw new Error('disk full') })
    const newest = queue.run(async () => 'newest snapshot')

    await expect(failed).rejects.toThrow('disk full')
    await expect(newest).resolves.toBe('newest snapshot')
    await expect(queue.drain()).resolves.toBeUndefined()
  })
})
