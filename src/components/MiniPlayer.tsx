import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Pause, PictureInPicture2, Play, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import './MiniPlayer.css'
import { formatPlaybackTime } from '../lib/playback.ts'
import { playbackController, type PlaybackSnapshot } from '../lib/playback-controller.ts'

type DocumentPictureInPictureApi = {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>
}

type WindowWithDocumentPictureInPicture = Window & {
  documentPictureInPicture?: DocumentPictureInPictureApi
}

type MiniPlayerProps = {
  theme: 'dark' | 'light'
}

export function MiniPlayer({ theme }: MiniPlayerProps) {
  const [supported] = useState(() => Boolean(documentPictureInPictureApi()))
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>(() => playbackController.getSnapshot())
  const [pipWindow, setPipWindow] = useState<Window | null>(null)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const activeCue = playbackController.getActiveCue()
  const cueCount = snapshot.key ? playbackController.getCueCount(snapshot.key) : 0

  useEffect(() => playbackController.subscribe(setSnapshot), [])

  useEffect(() => {
    if (!pipWindow) {
      setPortalTarget(null)
      return undefined
    }

    const pipDocument = pipWindow.document
    pipDocument.title = 'BetterTTS mini player'
    pipDocument.documentElement.dataset.theme = theme
    pipDocument.head.replaceChildren()
    for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      pipDocument.head.appendChild(node.cloneNode(true))
    }
    pipDocument.body.replaceChildren()
    const target = pipDocument.createElement('div')
    target.id = 'bettertts-mini-player-root'
    pipDocument.body.appendChild(target)
    setPortalTarget(target)

    const close = () => setPipWindow((current) => current === pipWindow ? null : current)
    pipWindow.addEventListener('pagehide', close)
    pipWindow.addEventListener('unload', close)
    return () => {
      pipWindow.removeEventListener('pagehide', close)
      pipWindow.removeEventListener('unload', close)
      setPortalTarget(null)
    }
  }, [pipWindow, theme])

  if (!supported) return null

  const togglePlayback = () => {
    if (!snapshot.key) return
    if (snapshot.playing) {
      playbackController.pause(snapshot.key)
      return
    }
    playbackController.play(snapshot.key).catch((nextError: unknown) => {
      setError(nextError instanceof Error ? nextError.message : 'Playback could not start.')
    })
  }

  const openMiniPlayer = async () => {
    const api = documentPictureInPictureApi()
    if (!api || pipWindow) return
    setError(null)
    try {
      const nextWindow = await api.requestWindow({ width: 390, height: 236 })
      setPipWindow(nextWindow)
    } catch (nextError: unknown) {
      setError(nextError instanceof Error ? nextError.message : 'The mini player could not be opened.')
    }
  }

  const closeMiniPlayer = () => {
    pipWindow?.close()
    setPipWindow(null)
  }

  const seek = (value: number) => {
    if (snapshot.key && Number.isFinite(value)) playbackController.seek(snapshot.key, value)
  }

  const player = (
    <main className="mini-player" aria-label="BetterTTS mini player">
      <header className="mini-player-header">
        <div>
          <span className="mini-player-kicker">BetterTTS · listening</span>
          <strong title={snapshot.label ?? undefined}>{snapshot.label ?? 'Nothing selected'}</strong>
        </div>
        <button type="button" className="mini-player-close" onClick={closeMiniPlayer} aria-label="Close mini player" title="Close mini player">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <p className="mini-player-cue" aria-live="polite">
        {activeCue?.text ?? (snapshot.key ? (cueCount > 0 ? 'Between sentences' : 'Sentence highlighting is unavailable for this clip.') : 'Start playback in BetterTTS.')}
      </p>
      <div className="mini-player-transport">
        <button type="button" onClick={() => playbackController.seekRelativeCue(-1)} disabled={!snapshot.key || cueCount === 0} aria-label="Previous sentence" title="Previous sentence">
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <button type="button" className="mini-player-play" onClick={togglePlayback} disabled={!snapshot.key} aria-label={snapshot.playing ? 'Pause playback' : 'Play playback'}>
          {snapshot.playing ? <Pause size={17} aria-hidden="true" /> : <Play size={17} aria-hidden="true" />}
        </button>
        <button type="button" onClick={() => playbackController.seekRelativeCue(1)} disabled={!snapshot.key || cueCount === 0} aria-label="Next sentence" title="Next sentence">
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <strong>{formatPlaybackTime(snapshot.currentTime)} / {formatPlaybackTime(snapshot.duration)}</strong>
      </div>
      <input
        className="mini-player-progress"
        type="range"
        min={0}
        max={snapshot.duration || 0}
        step={0.01}
        value={Math.min(snapshot.currentTime, snapshot.duration || 0)}
        onChange={(event) => seek(Number(event.target.value))}
        disabled={!snapshot.key || snapshot.duration <= 0}
        aria-label="Playback position"
        aria-valuetext={`${formatPlaybackTime(snapshot.currentTime)} of ${formatPlaybackTime(snapshot.duration)}`}
      />
    </main>
  )

  return (
    <>
      <button
        type="button"
        className="mini-player-trigger"
        onClick={pipWindow ? closeMiniPlayer : openMiniPlayer}
        disabled={!pipWindow && !playbackController.hasRegisteredAudio()}
        aria-label={pipWindow ? 'Close mini player' : 'Open mini player'}
        title={pipWindow ? 'Close mini player' : 'Open an always-on-top listening controller'}
        data-testid="mini-player-trigger"
      >
        <PictureInPicture2 size={15} aria-hidden="true" />
        {pipWindow ? 'Mini player open' : 'Mini player'}
      </button>
      {error ? <span className="mini-player-error" role="status">{error}</span> : null}
      {portalTarget ? createPortal(player, portalTarget) : null}
    </>
  )
}

function documentPictureInPictureApi(): DocumentPictureInPictureApi | null {
  if (typeof window === 'undefined') return null
  return (window as WindowWithDocumentPictureInPicture).documentPictureInPicture ?? null
}
