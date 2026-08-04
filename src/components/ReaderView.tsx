import { BookOpen, ChevronLeft, ChevronRight, Focus, Pause, Play, RotateCcw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Cue } from '../lib/subtitles.ts'
import {
  buildReaderCueBindings,
  findReaderSentence,
  flattenReaderSentences,
  loadReaderResume,
  readerCueAtTime,
  saveReaderResume,
  type ReaderCueBinding,
  type ReaderDocument,
  type ReaderParagraph,
  type ReaderSentence,
} from '../lib/reader.ts'
import { formatPlaybackTime } from '../lib/playback.ts'
import { playbackController, type PlaybackSnapshot } from '../lib/playback-controller.ts'

export type ReaderAudioTrack = {
  id: string
  label: string
  sourceText: string
  cues?: readonly Cue[]
  src?: string
  load?: () => Promise<Blob | null>
}

type ReaderViewProps = {
  document: ReaderDocument
  tracks: readonly ReaderAudioTrack[]
  onClose: () => void
}

const EMPTY_SNAPSHOT: PlaybackSnapshot = {
  key: null,
  label: null,
  playing: false,
  currentTime: 0,
  duration: 0,
}
const EMPTY_VTT_URL = 'data:text/vtt;charset=utf-8,WEBVTT%0A%0A'

export function ReaderView({ document, tracks, onClose }: ReaderViewProps) {
  const playbackKey = `reader:${document.id}`
  const savedResume = useMemo(() => loadReaderResume(document.id), [document.id])
  const initialChapter = clampChapter(document, savedResume?.chapterIndex ?? 0)
  const [chapterIndex, setChapterIndex] = useState(initialChapter)
  const [selectedTrackId, setSelectedTrackId] = useState(tracks[0]?.id ?? '')
  const [focusMode, setFocusMode] = useState(false)
  const [trackUrl, setTrackUrl] = useState<string | null>(null)
  const [trackLoading, setTrackLoading] = useState(false)
  const [trackError, setTrackError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>(EMPTY_SNAPSHOT)
  const [resumeNote, setResumeNote] = useState<string | null>(savedResume ? 'Resume position restored.' : null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const restoredTrackRef = useRef<string | null>(null)
  const pendingBindingRef = useRef<{ trackId: string; sentenceId: string } | null>(null)

  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) ?? tracks[0]
  const selectedTrackBindings = useMemo(
    () => selectedTrack?.cues?.length
      ? buildReaderCueBindings(document, selectedTrack.sourceText, selectedTrack.cues)
      : [],
    [document, selectedTrack],
  )
  const activeBinding = readerCueAtTime(selectedTrackBindings, snapshot.currentTime)
  const activeSentenceId = activeBinding?.sentenceId ?? null
  const activeWordId = activeBinding?.wordId ?? null
  const chapter = document.chapters[chapterIndex] ?? document.chapters[0]
  const activeSentence = activeSentenceId ? findReaderSentence(document, activeSentenceId) : null
  const activeParagraphId = activeSentence ? findParagraphId(document, activeSentence.id) : null
  const allSentences = useMemo(() => flattenReaderSentences(document), [document])
  const activeSentenceNumber = activeSentenceId
    ? allSentences.findIndex((sentence) => sentence.id === activeSentenceId) + 1
    : 0
  const progressLabel = allSentences.length > 0 && activeSentenceNumber > 0
    ? `${activeSentenceNumber} / ${allSentences.length} sentences`
    : `${allSentences.length} sentences`

  useEffect(() => {
    setSelectedTrackId((current) => tracks.some((track) => track.id === current) ? current : tracks[0]?.id ?? '')
  }, [tracks])

  useEffect(() => {
    if (!savedResume?.sentenceId) return
    const matchingTrack = tracks.find((track) => track.cues?.some((cue) => cue.text && buildReaderCueBindings(document, track.sourceText, track.cues ?? []).some((binding) => binding.sentenceId === savedResume.sentenceId)))
    if (matchingTrack) setSelectedTrackId(matchingTrack.id)
    const sentence = findReaderSentence(document, savedResume.sentenceId)
    if (sentence) setChapterIndex(findChapterIndex(document, sentence.id))
  }, [document, savedResume, tracks])

  useEffect(() => {
    const unsubscribe = playbackController.subscribe((next) => {
      setSnapshot(next.key === playbackKey ? next : EMPTY_SNAPSHOT)
    })
    return unsubscribe
  }, [playbackKey])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !selectedTrack || !trackUrl) return undefined
    return playbackController.register(playbackKey, audio, selectedTrack.label)
  }, [playbackKey, selectedTrack, trackUrl])

  useEffect(() => {
    let cancelled = false
    let ownedUrl: string | null = null
    setTrackUrl(null)
    setTrackError(null)
    setTrackLoading(false)
    restoredTrackRef.current = null
    const track = selectedTrack
    if (!track) return () => { cancelled = true }
    if (track.src) {
      setTrackUrl(track.src)
      return () => { cancelled = true }
    }
    if (!track.load) return () => { cancelled = true }
    setTrackLoading(true)
    track.load().then((blob) => {
      if (cancelled) return
      if (!blob) {
        setTrackError('The saved audio is no longer available. Resume the queue to regenerate it.')
        return
      }
      ownedUrl = URL.createObjectURL(blob)
      setTrackUrl(ownedUrl)
    }).catch((error: unknown) => {
      if (!cancelled) setTrackError(error instanceof Error ? error.message : 'Could not load the selected audio.')
    }).finally(() => {
      if (!cancelled) setTrackLoading(false)
    })
    return () => {
      cancelled = true
      if (ownedUrl) URL.revokeObjectURL(ownedUrl)
    }
  }, [selectedTrack])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !trackUrl || restoredTrackRef.current === selectedTrack?.id) return
    const restore = () => {
      if (restoredTrackRef.current === selectedTrack?.id) return
      restoredTrackRef.current = selectedTrack?.id ?? null
      if (!savedResume) return
      const binding = savedResume.sentenceId
        ? selectedTrackBindings.find((candidate) => candidate.sentenceId === savedResume.sentenceId && (!savedResume.wordId || candidate.wordId === savedResume.wordId))
        : null
      const resumeAt = Number.isFinite(savedResume.timeSec) ? savedResume.timeSec : binding?.startSec
      if (resumeAt === undefined || !Number.isFinite(resumeAt) || resumeAt <= 0) return
      audio.currentTime = resumeAt
      setResumeNote(`Resumed in ${formatPlaybackTime(resumeAt)}.`)
    }
    audio.addEventListener('loadedmetadata', restore)
    if (audio.readyState >= 1) restore()
    return () => audio.removeEventListener('loadedmetadata', restore)
  }, [savedResume, selectedTrack, selectedTrackBindings, trackUrl])

  useEffect(() => {
    if (!activeBinding) return
    saveReaderResume(document.id, {
      chapterIndex: findChapterIndex(document, activeBinding.sentenceId),
      sentenceId: activeBinding.sentenceId,
      wordId: activeBinding.wordId,
      timeSec: snapshot.currentTime,
    })
  }, [activeBinding, document, snapshot.currentTime])

  useEffect(() => {
    const pending = pendingBindingRef.current
    if (!pending || pending.trackId !== selectedTrack?.id || !trackUrl) return
    const binding = selectedTrackBindings.find((candidate) => candidate.sentenceId === pending.sentenceId)
    if (!binding) return
    pendingBindingRef.current = null
    seekToBinding(binding, true)
    // seekToBinding is intentionally stable for this event-like effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTrack?.id, selectedTrackBindings, trackUrl])

  useEffect(() => {
    if (!activeSentenceId || !snapshot.playing) return
    const target = documentRoot().querySelector<HTMLElement>(`[data-reader-sentence-id="${escapeSelector(activeSentenceId)}"]`)
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeSentenceId, snapshot.playing])

  if (!chapter) {
    return (
      <section className="reader-panel" aria-labelledby="reader-heading">
        <div className="reader-toolbar">
          <h2 id="reader-heading"><BookOpen size={19} aria-hidden="true" /> Reader mode</h2>
          <button type="button" onClick={onClose} aria-label="Close reader mode"><X size={16} aria-hidden="true" /> Close</button>
        </div>
        <p className="reader-empty">This document has no readable paragraphs.</p>
      </section>
    )
  }

  const togglePlayback = () => {
    if (!trackUrl) return
    if (snapshot.playing) playbackController.pause(playbackKey)
    else playbackController.play(playbackKey).catch(() => setTrackError('Playback could not start. Try the selected output again.'))
  }

  const seekToBinding = (binding: ReaderCueBinding, play = false) => {
    const audio = audioRef.current
    const nextChapter = findChapterIndex(document, binding.sentenceId)
    setChapterIndex(nextChapter)
    saveReaderResume(document.id, {
      chapterIndex: nextChapter,
      sentenceId: binding.sentenceId,
      wordId: binding.wordId,
      timeSec: binding.startSec,
    })
    if (!audio || !trackUrl) return
    playbackController.seek(playbackKey, binding.startSec + 0.001)
    if (play) playbackController.play(playbackKey).catch(() => setTrackError('Playback could not start.'))
  }

  const jumpToSentence = (sentence: ReaderSentence, wordId?: string) => {
    const binding = selectedTrackBindings.find((candidate) => candidate.sentenceId === sentence.id && (!wordId || candidate.wordId === wordId))
    if (binding) {
      seekToBinding(binding, true)
      return
    }
    saveReaderResume(document.id, { chapterIndex: findChapterIndex(document, sentence.id), sentenceId: sentence.id, wordId })
    setResumeNote('Position saved. Generate or select synced audio to jump here.')
  }

  const jumpToParagraph = (paragraph: ReaderParagraph) => {
    const firstSentence = paragraph.sentences[0]
    if (!firstSentence) return
    const binding = selectedTrackBindings.find((candidate) => candidate.sentenceId === firstSentence.id)
    if (binding) {
      seekToBinding(binding, true)
      return
    }
    const alternate = tracks
      .filter((track) => track.id !== selectedTrack?.id && track.cues?.length)
      .map((track) => ({ track, binding: buildReaderCueBindings(document, track.sourceText, track.cues ?? []).find((candidate) => candidate.sentenceId === firstSentence.id) }))
      .find((entry) => entry.binding)
    if (alternate?.binding) {
      pendingBindingRef.current = { trackId: alternate.track.id, sentenceId: alternate.binding.sentenceId }
      setSelectedTrackId(alternate.track.id)
      setResumeNote('Loading the matching audio segment…')
      return
    }
    jumpToSentence(firstSentence)
  }

  const moveChapter = (delta: -1 | 1) => {
    const next = clampChapter(document, chapterIndex + delta)
    setChapterIndex(next)
    const first = document.chapters[next]?.paragraphs[0]?.sentences[0]
    if (first) saveReaderResume(document.id, { chapterIndex: next, sentenceId: first.id })
  }

  return (
    <section className={focusMode ? 'reader-panel reader-focus-mode' : 'reader-panel'} aria-labelledby="reader-heading">
      <div className="reader-toolbar">
        <div className="reader-title">
          <BookOpen size={19} aria-hidden="true" />
          <div>
            <h2 id="reader-heading">{document.title}</h2>
            <span>{document.kind.toUpperCase()} · {progressLabel}</span>
          </div>
        </div>
        <div className="reader-toolbar-actions">
          <button type="button" className={focusMode ? 'follow-active' : undefined} onClick={() => setFocusMode((current) => !current)} aria-pressed={focusMode} title="Dim paragraphs around the active line">
            <Focus size={16} aria-hidden="true" /> {focusMode ? 'Exit focus' : 'Line focus'}
          </button>
          <button type="button" onClick={onClose} aria-label="Close reader mode"><X size={16} aria-hidden="true" /> Close</button>
        </div>
      </div>

      <div className="reader-controls" aria-label="Reader playback controls">
        <button type="button" onClick={togglePlayback} disabled={!trackUrl} aria-label={snapshot.playing ? 'Pause reader playback' : 'Play reader playback'}>
          {snapshot.playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          {snapshot.playing ? 'Pause' : 'Play'}
        </button>
        <strong>{formatPlaybackTime(snapshot.currentTime)} / {formatPlaybackTime(snapshot.duration)}</strong>
        <input
          className="reader-progress"
          type="range"
          min={0}
          max={snapshot.duration || 0}
          step={0.01}
          value={Math.min(snapshot.currentTime, snapshot.duration || 0)}
          onChange={(event) => playbackController.seek(playbackKey, Number(event.target.value))}
          disabled={!trackUrl || snapshot.duration <= 0}
          aria-label="Reader audio position"
        />
        {tracks.length > 0 ? (
          <label className="reader-track-picker">
            <span className="sr-only">Reader audio</span>
            <select value={selectedTrack?.id ?? ''} onChange={(event) => setSelectedTrackId(event.target.value)} aria-label="Reader audio track">
              {tracks.map((track) => <option value={track.id} key={track.id}>{track.label}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      {trackLoading ? <p className="reader-status" role="status">Loading synced audio…</p> : null}
      {trackError ? <p className="reader-status reader-status-warn" role="status">{trackError}</p> : null}
      {resumeNote ? <p className="reader-status" role="status"><RotateCcw size={14} aria-hidden="true" /> {resumeNote}</p> : null}
      {selectedTrack && selectedTrackBindings.length === 0 && !trackError ? <p className="reader-status">This audio has no matching timing cues. Generate with an export-capable engine for karaoke highlighting.</p> : null}

      {trackUrl ? (
        <audio ref={audioRef} preload="metadata" src={trackUrl} aria-label={`Reader audio for ${document.title}`}>
          <track kind="captions" src={EMPTY_VTT_URL} srcLang="en" label="Reader timing" />
        </audio>
      ) : null}

      <div className="reader-chapter-nav" aria-label="Reader chapter navigation">
        <button type="button" onClick={() => moveChapter(-1)} disabled={chapterIndex <= 0} aria-label="Previous chapter"><ChevronLeft size={16} aria-hidden="true" /> Previous</button>
        <span><strong>{chapter.title}</strong><small>Chapter {chapterIndex + 1} of {document.chapters.length}</small></span>
        <button type="button" onClick={() => moveChapter(1)} disabled={chapterIndex >= document.chapters.length - 1} aria-label="Next chapter">Next <ChevronRight size={16} aria-hidden="true" /></button>
      </div>

      <article className="reader-page" aria-label={`Reading ${document.title}, ${chapter.title}`}>
        {chapter.paragraphs.map((paragraph) => {
          const paragraphActive = paragraph.id === activeParagraphId
          const paragraphClass = focusMode && activeParagraphId && !paragraphActive ? 'reader-paragraph reader-paragraph-dim' : paragraphActive ? 'reader-paragraph reader-paragraph-active' : 'reader-paragraph'
          return (
            <div
              className={paragraphClass}
              data-reader-paragraph-id={paragraph.id}
              key={paragraph.id}
              role="button"
              tabIndex={0}
              onClick={() => jumpToParagraph(paragraph)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return
                event.preventDefault()
                jumpToParagraph(paragraph)
              }}
              title="Jump playback to this paragraph"
            >
              {paragraph.sentences.map((sentence) => (
                <span
                  className={sentence.id === activeSentenceId ? 'reader-sentence reader-sentence-active' : 'reader-sentence'}
                  data-reader-sentence-id={sentence.id}
                  key={sentence.id}
                >
                  {renderSentence(sentence, activeWordId, (wordId) => jumpToSentence(sentence, wordId))}
                  {' '}
                </span>
              ))}
            </div>
          )
        })}
      </article>
    </section>
  )
}

function renderSentence(sentence: ReaderSentence, activeWordId: string | null, onWordClick: (wordId: string) => void) {
  if (sentence.words.length === 0) return sentence.text
  const parts: ReactNode[] = []
  let cursor = 0
  for (const word of sentence.words) {
    const start = Math.max(0, word.start - sentence.start)
    const end = Math.max(start, word.end - sentence.start)
    if (start > cursor) parts.push(<span key={`${word.id}-before`}>{sentence.text.slice(cursor, start)}</span>)
    parts.push(
      <span
        className={word.id === activeWordId ? 'reader-word reader-word-active' : 'reader-word'}
        key={word.id}
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation()
          onWordClick(word.id)
        }}
        onKeyDown={(event) => {
          if (!['Enter', ' '].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          onWordClick(word.id)
        }}
      >
        {sentence.text.slice(start, end)}
      </span>,
    )
    cursor = end
  }
  if (cursor < sentence.text.length) parts.push(<span key={`${sentence.id}-tail`}>{sentence.text.slice(cursor)}</span>)
  return parts
}

function clampChapter(document: ReaderDocument, index: number): number {
  if (document.chapters.length === 0) return 0
  return Math.max(0, Math.min(document.chapters.length - 1, Number.isSafeInteger(index) ? index : 0))
}

function findChapterIndex(document: ReaderDocument, sentenceId: string): number {
  const index = document.chapters.findIndex((chapter) => chapter.paragraphs.some((paragraph) => paragraph.sentences.some((sentence) => sentence.id === sentenceId)))
  return index >= 0 ? index : 0
}

function findParagraphId(document: ReaderDocument, sentenceId: string): string | null {
  for (const chapter of document.chapters) {
    const paragraph = chapter.paragraphs.find((candidate) => candidate.sentences.some((sentence) => sentence.id === sentenceId))
    if (paragraph) return paragraph.id
  }
  return null
}

function documentRoot(): Document {
  return typeof window === 'undefined' ? ({} as Document) : window.document
}

function escapeSelector(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}
