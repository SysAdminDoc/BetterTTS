import { describe, expect, it } from 'vitest'
import { PlaybackController } from './playback-controller.ts'

class FakeAudio extends EventTarget {
  paused = true
  playbackRate = 1
  sinkId = ''
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

  setSinkId(sinkId: string): Promise<void> {
    this.sinkId = sinkId
    return Promise.resolve()
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

  it('applies a sanitized playback rate to current and future registrations', () => {
    const controller = new PlaybackController()
    const first = new FakeAudio()
    controller.setPlaybackRate(1.25)
    controller.register('first', first as unknown as HTMLAudioElement, 'First')
    expect(first.playbackRate).toBe(1.25)

    controller.setPlaybackRate(9)
    expect(first.playbackRate).toBe(4)
    expect(controller.getPlaybackRate()).toBe(4)
    const second = new FakeAudio()
    controller.register('second', second as unknown as HTMLAudioElement, 'Second')
    expect(second.playbackRate).toBe(4)
  })

  it('routes current and future audio and exposes active sentence cues', async () => {
    const controller = new PlaybackController()
    const first = new FakeAudio()
    const cues = [
      { index: 0, startSec: 0, endSec: 5, text: 'First sentence' },
      { index: 1, startSec: 5, endSec: 10, text: 'Second sentence' },
    ]
    controller.register('first', first as unknown as HTMLAudioElement, 'First', cues)
    await controller.setSinkId('headphones')
    expect(first.sinkId).toBe('headphones')

    await controller.play('first')
    first.currentTime = 6
    first.dispatchEvent(new Event('timeupdate'))
    expect(controller.getActiveCue()?.text).toBe('Second sentence')
    controller.seekRelativeCue(-1)
    expect(first.currentTime).toBe(0.001)

    const second = new FakeAudio()
    controller.register('second', second as unknown as HTMLAudioElement, 'Second')
    expect(second.sinkId).toBe('headphones')
  })

  it('publishes Media Session metadata and bounded position state', async () => {
    const mediaSession = {
      metadata: null as unknown,
      playbackState: 'none' as MediaSessionPlaybackState,
      handlers: new Map<string, (details: MediaSessionActionDetails) => void>(),
      positions: [] as MediaPositionState[],
      setActionHandler(action: MediaSessionAction, handler: ((details: MediaSessionActionDetails) => void) | null) {
        if (handler) this.handlers.set(action, handler)
        else this.handlers.delete(action)
      },
      setPositionState(position: MediaPositionState) {
        this.positions.push(position)
      },
    }
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const originalMetadata = Object.getOwnPropertyDescriptor(globalThis, 'MediaMetadata')
    class FakeMetadata {
      title: string
      artist: string

      constructor(init: { title: string; artist: string }) {
        this.title = init.title
        this.artist = init.artist
      }
    }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaSession } })
    Object.defineProperty(globalThis, 'MediaMetadata', { configurable: true, value: FakeMetadata })

    try {
      const controller = new PlaybackController()
      const audio = new FakeAudio()
      const unregister = controller.register('chapter', audio as unknown as HTMLAudioElement, 'Chapter one')
      await controller.play('chapter')
      audio.currentTime = 12
      audio.dispatchEvent(new Event('timeupdate'))
      controller.setPlaybackRate(1.5)

      expect(mediaSession.metadata).toMatchObject({ title: 'Chapter one', artist: 'BetterTTS' })
      expect(mediaSession.playbackState).toBe('playing')
      expect(mediaSession.positions.at(-1)).toEqual({ duration: 30, playbackRate: 1.5, position: 12 })

      mediaSession.handlers.get('seekto')?.({ seekTime: 7 } as MediaSessionActionDetails)
      expect(audio.currentTime).toBe(7)
      unregister()
      expect(mediaSession.metadata).toBeNull()
      expect(mediaSession.playbackState).toBe('none')
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
      else Reflect.deleteProperty(globalThis, 'navigator')
      if (originalMetadata) Object.defineProperty(globalThis, 'MediaMetadata', originalMetadata)
      else Reflect.deleteProperty(globalThis, 'MediaMetadata')
    }
  })
})
