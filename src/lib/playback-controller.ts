import {
  cueIndexAtTime,
  nextCueIndex,
  previousCueIndex,
} from './playback.ts'
import type { Cue } from './subtitles.ts'
import { PlaybackChoppinessTracker, releaseAudioElement, type PlaybackChoppinessSnapshot } from './playback-resources.ts'

export type PlaybackSnapshot = {
  key: string | null
  label: string | null
  playing: boolean
  currentTime: number
  duration: number
}

type PlaybackEntry = {
  audio: HTMLAudioElement
  label: string
  cues: readonly Cue[]
  choppiness: PlaybackChoppinessTracker
  cleanup: () => void
}

type SinkAudioElement = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>
}

export type PlaybackListener = (snapshot: PlaybackSnapshot) => void

export class PlaybackController {
  private readonly entries = new Map<string, PlaybackEntry>()
  private readonly listeners = new Set<PlaybackListener>()
  private snapshot: PlaybackSnapshot = {
    key: null,
    label: null,
    playing: false,
    currentTime: 0,
    duration: 0,
  }
  private playbackRate = 1
  private sinkId = ''
  private mediaSessionInstalled = false

  register(key: string, audio: HTMLAudioElement, label: string, cues: readonly Cue[] = []): () => void {
    this.entries.get(key)?.cleanup()
    audio.playbackRate = this.playbackRate
    if (this.sinkId) void this.applySink(audio, this.sinkId)
    const choppiness = new PlaybackChoppinessTracker()
    const update = () => this.updateSnapshot(key)
    const onPlay = () => {
      choppiness.start()
      choppiness.recordPlaying()
      this.activate(key)
      update()
    }
    const onPause = () => update()
    const onTimeUpdate = () => update()
    const onLoadedMetadata = () => update()
    const onWaiting = () => {
      choppiness.recordWaiting()
      update()
    }
    const onStalled = () => {
      choppiness.recordStalled()
      update()
    }
    const onPlaying = () => {
      choppiness.recordPlaying()
      update()
    }
    const onEnded = () => {
      choppiness.recordPlaying()
      if (this.snapshot.key === key) {
        this.snapshot = {
          key,
          label,
          playing: false,
          currentTime: 0,
          duration: finiteDuration(audio.duration),
        }
        this.syncMediaSession()
        this.emit()
      }
    }
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('stalled', onStalled)
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('ended', onEnded)
    this.installMediaSession()

    const cleanup = () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('stalled', onStalled)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('ended', onEnded)
      choppiness.finish()
      releaseAudioElement(audio)
      if (this.entries.get(key)?.audio === audio) this.entries.delete(key)
      if (this.snapshot.key === key) {
        this.snapshot = emptySnapshot()
        this.syncMediaSession()
        this.emit()
      }
    }
    this.entries.set(key, { audio, label, cues, choppiness, cleanup })
    update()
    return cleanup
  }

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): PlaybackSnapshot {
    return this.snapshot
  }

  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate)) return
    this.playbackRate = Math.min(4, Math.max(0.25, rate))
    for (const entry of this.entries.values()) entry.audio.playbackRate = this.playbackRate
    this.syncMediaSession()
  }

  getPlaybackRate(): number {
    return this.playbackRate
  }

  async setSinkId(sinkId: string): Promise<void> {
    if (!sinkId.trim() && sinkId !== '') return
    const entries = Array.from(this.entries.values())
    await Promise.all(entries.map((entry) => this.applySink(entry.audio, sinkId)))
    this.sinkId = sinkId
  }

  getSinkId(): string {
    return this.sinkId
  }

  hasRegisteredAudio(): boolean {
    return this.entries.size > 0
  }

  releaseByPrefix(prefix: string): void {
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (key.startsWith(prefix)) entry.cleanup()
    }
  }

  getCueCount(key = this.snapshot.key): number {
    return key ? this.entries.get(key)?.cues.length ?? 0 : 0
  }

  getActiveCue(key = this.snapshot.key): Cue | null {
    if (!key) return null
    const entry = this.entries.get(key)
    if (!entry) return null
    const index = cueIndexAtTime(entry.cues, this.snapshot.currentTime)
    return index >= 0 ? entry.cues[index] ?? null : null
  }

  getChoppiness(key = this.snapshot.key): PlaybackChoppinessSnapshot {
    if (!key) return emptyChoppinessSnapshot()
    return this.entries.get(key)?.choppiness.snapshot() ?? emptyChoppinessSnapshot()
  }

  seekRelativeCue(direction: -1 | 1, key = this.snapshot.key): void {
    if (!key) return
    const entry = this.entries.get(key)
    if (!entry || entry.cues.length === 0) return
    const index = direction < 0
      ? previousCueIndex(entry.cues, this.snapshot.currentTime)
      : nextCueIndex(entry.cues, this.snapshot.currentTime)
    const cue = index >= 0 ? entry.cues[index] : undefined
    if (!cue) return
    this.seek(key, cue.startSec + 0.001)
  }

  async play(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry) throw new Error('The selected audio is no longer available.')
    this.activate(key)
    await entry.audio.play()
    this.updateSnapshot(key)
  }

  pause(key = this.snapshot.key): void {
    if (!key) return
    this.entries.get(key)?.audio.pause()
    this.updateSnapshot(key)
  }

  seek(key: string, timeSec: number): void {
    const entry = this.entries.get(key)
    if (!entry || !Number.isFinite(timeSec)) return
    const duration = finiteDuration(entry.audio.duration)
    entry.audio.currentTime = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, timeSec))
    this.updateSnapshot(key)
  }

  private activate(key: string): void {
    for (const [otherKey, entry] of this.entries) {
      if (otherKey !== key && !entry.audio.paused) entry.audio.pause()
    }
    const entry = this.entries.get(key)
    if (!entry) return
    this.snapshot = {
      key,
      label: entry.label,
      playing: !entry.audio.paused,
      currentTime: finiteTime(entry.audio.currentTime),
      duration: finiteDuration(entry.audio.duration),
    }
    this.syncMediaSession()
    this.emit()
  }

  private updateSnapshot(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    if (entry.audio.paused && this.snapshot.key !== key) return
    this.snapshot = {
      key,
      label: entry.label,
      playing: !entry.audio.paused,
      currentTime: finiteTime(entry.audio.currentTime),
      duration: finiteDuration(entry.audio.duration),
    }
    this.syncMediaSession()
    this.emit()
  }

  private installMediaSession(): void {
    if (this.mediaSessionInstalled || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    this.mediaSessionInstalled = true
    const session = navigator.mediaSession
    setMediaAction(session, 'play', () => {
      if (this.snapshot.key) void this.play(this.snapshot.key).catch(() => undefined)
    })
    setMediaAction(session, 'pause', () => this.pause())
    setMediaAction(session, 'seekbackward', (details) => this.seek(this.snapshot.key ?? '', this.snapshot.currentTime - (details.seekOffset ?? 10)))
    setMediaAction(session, 'seekforward', (details) => this.seek(this.snapshot.key ?? '', this.snapshot.currentTime + (details.seekOffset ?? 10)))
    setMediaAction(session, 'seekto', (details) => {
      if (typeof details.seekTime === 'number') this.seek(this.snapshot.key ?? '', details.seekTime)
    })
    setMediaAction(session, 'previoustrack', () => this.seekRelativeCue(-1))
    setMediaAction(session, 'nexttrack', () => this.seekRelativeCue(1))
  }

  private syncMediaSession(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    const session = navigator.mediaSession
    if (this.snapshot.key && this.snapshot.label) {
      if (typeof MediaMetadata !== 'undefined') session.metadata = new MediaMetadata({ title: this.snapshot.label, artist: 'BetterTTS' })
      session.playbackState = this.snapshot.playing ? 'playing' : 'paused'
      if (typeof session.setPositionState === 'function' && this.snapshot.duration > 0) {
        try {
          session.setPositionState({
            duration: this.snapshot.duration,
            playbackRate: this.playbackRate,
            position: Math.min(this.snapshot.currentTime, this.snapshot.duration),
          })
        } catch {
          // Safari rejects position updates when the media duration is still changing.
        }
      }
    } else {
      session.metadata = null
      session.playbackState = 'none'
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshot)
  }

  private async applySink(audio: HTMLAudioElement, sinkId: string): Promise<void> {
    const setSinkId = (audio as SinkAudioElement).setSinkId
    if (typeof setSinkId !== 'function') throw new Error('Audio output routing is not supported by this browser.')
    await setSinkId.call(audio, sinkId)
  }
}

export const playbackController = new PlaybackController()

function emptySnapshot(): PlaybackSnapshot {
  return { key: null, label: null, playing: false, currentTime: 0, duration: 0 }
}

function emptyChoppinessSnapshot(): PlaybackChoppinessSnapshot {
  return {
    waitingEvents: 0,
    stalledEvents: 0,
    recoveries: 0,
    observedSeconds: 0,
    bufferingSeconds: 0,
    choppyRatio: 0,
    status: 'insufficient',
  }
}

function finiteTime(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function finiteDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function setMediaAction(
  session: MediaSession,
  action: MediaSessionAction,
  handler: (details: MediaSessionActionDetails) => void,
): void {
  try {
    session.setActionHandler(action, handler)
  } catch {
    // Safari and older Chromium versions reject actions they do not support.
  }
}
