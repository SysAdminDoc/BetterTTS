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
  cleanup: () => void
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
  private mediaSessionInstalled = false

  register(key: string, audio: HTMLAudioElement, label: string): () => void {
    this.entries.get(key)?.cleanup()
    audio.playbackRate = this.playbackRate
    const update = () => this.updateSnapshot(key)
    const onPlay = () => {
      this.activate(key)
      update()
    }
    const onPause = () => update()
    const onTimeUpdate = () => update()
    const onLoadedMetadata = () => update()
    const onEnded = () => {
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
    audio.addEventListener('ended', onEnded)
    this.installMediaSession()

    const cleanup = () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('ended', onEnded)
      if (this.entries.get(key)?.audio === audio) this.entries.delete(key)
      if (this.snapshot.key === key) {
        this.snapshot = emptySnapshot()
        this.syncMediaSession()
        this.emit()
      }
    }
    this.entries.set(key, { audio, label, cleanup })
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
  }

  getPlaybackRate(): number {
    return this.playbackRate
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
  }

  private syncMediaSession(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    const session = navigator.mediaSession
    if (this.snapshot.key && this.snapshot.label) {
      if (typeof MediaMetadata !== 'undefined') session.metadata = new MediaMetadata({ title: this.snapshot.label, artist: 'BetterTTS' })
      session.playbackState = this.snapshot.playing ? 'playing' : 'paused'
    } else {
      session.metadata = null
      session.playbackState = 'none'
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshot)
  }
}

export const playbackController = new PlaybackController()

function emptySnapshot(): PlaybackSnapshot {
  return { key: null, label: null, playing: false, currentTime: 0, duration: 0 }
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
