import { describe, expect, it } from 'vitest'
import { PlaybackController } from './playback-controller.ts'

class FakeAudio extends EventTarget {
  paused = true
  currentTime = 0
  duration = 30

  play(): Promise<void> {
    this.paused = false
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
}

describe('shared playback controller', () => {
  it('keeps one active audio element and mirrors its transport state', async () => {
    const controller = new PlaybackController()
    const first = new FakeAudio()
    const second = new FakeAudio()
    controller.register('first', first as unknown as HTMLAudioElement, 'First')
    controller.register('second', second as unknown as HTMLAudioElement, 'Second')

    await controller.play('first')
    expect(controller.getSnapshot()).toMatchObject({ key: 'first', label: 'First', playing: true })

    await controller.play('second')
    expect(first.paused).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ key: 'second', label: 'Second', playing: true })

    controller.seek('second', 12.5)
    expect(second.currentTime).toBe(12.5)
    expect(controller.getSnapshot().currentTime).toBe(12.5)
  })

  it('clears the active snapshot when its audio element is removed', async () => {
    const controller = new PlaybackController()
    const audio = new FakeAudio()
    const unregister = controller.register('clip', audio as unknown as HTMLAudioElement, 'Clip')
    await controller.play('clip')

    unregister()

    expect(controller.getSnapshot()).toEqual({
      key: null,
      label: null,
      playing: false,
      currentTime: 0,
      duration: 0,
    })
  })
})
