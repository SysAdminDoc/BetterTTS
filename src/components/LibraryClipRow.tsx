import { Download, Info, Loader2, Play, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState, type ComponentType } from 'react'
import type { Cue } from '../lib/subtitles.ts'
import { toVTT } from '../lib/subtitles.ts'
import { deleteClipWithSnapshot, getClipBlob, type ClipRecord, type ClipSnapshot } from '../lib/library.ts'
import type { GenerationProvenanceManifest, ProvenanceReplayContext } from '../lib/provenance.ts'
import { libraryEngineId, libraryEngineLabel } from '../lib/library-view.ts'
import { formatBytes } from '../lib/text.ts'

export type PlaybackAudioProps = {
  playbackKey: string
  src: string
  label: string
  cues?: Cue[]
  vttUrl?: string
  srcLang?: string
}

export type LibraryNotice = {
  tone: 'ok' | 'warn' | 'error'
  message: string
  action?: {
    label: string
    run: () => void | Promise<void>
  }
}

export type LibraryClipRowProps = {
  clip: ClipRecord
  onDeleted: (snapshot: ClipSnapshot) => void
  onNotice: (notice: LibraryNotice) => void
  replayContext?: ProvenanceReplayContext
  playbackAudio: ComponentType<PlaybackAudioProps>
}

function cueDataUrl(cues?: Cue[]): string | undefined {
  if (!cues?.length) return undefined
  return `data:text/vtt;charset=utf-8,${encodeURIComponent(toVTT(cues))}`
}

function provenanceReplayWarning(manifest: GenerationProvenanceManifest | null | undefined, current?: ProvenanceReplayContext): string | null {
  const engine = manifest?.engine
  const sourceHash = manifest?.source?.textHash
  if (!manifest || manifest.legacy || !engine || engine.id === 'unknown' || !sourceHash) {
    return 'Replay may differ: this clip has incomplete generation provenance from an older runtime.'
  }
  if (!current) return null
  if (engine.id !== current.engineId) return `Replay may differ: this clip used ${engine.id}, but the current engine is ${current.engineId}.`
  if (current.modelId && (engine.modelId !== current.modelId || engine.modelRevision !== current.modelRevision)) {
    return 'Replay may differ: the selected model revision does not match this clip.'
  }
  return manifest.runtime?.label === current.runtimeLabel
    ? null
    : 'Replay may differ: the selected runtime does not match this clip.'
}

export function LibraryClipRow({ clip, onDeleted, onNotice, replayContext, playbackAudio: PlaybackAudio }: LibraryClipRowProps) {
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState<'load' | 'download' | 'delete' | null>(null)
  const [audioState, setAudioState] = useState<'idle' | 'ready' | 'missing' | 'error'>('idle')
  const vttUrl = useMemo(() => cueDataUrl(clip.cues), [clip.cues])
  const replayWarning = provenanceReplayWarning(clip.generationProvenance, replayContext)

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [url])

  const loadPlayer = async () => {
    if (url) return
    setBusy('load')
    try {
      const blob = await getClipBlob(clip.id)
      if (!blob) {
        setAudioState('missing')
        onNotice({ tone: 'warn', message: 'Saved audio is missing for this clip.' })
        return
      }
      setUrl(URL.createObjectURL(blob))
      setAudioState('ready')
    } catch {
      setAudioState('error')
      onNotice({ tone: 'error', message: 'Could not load saved audio.' })
    } finally {
      setBusy(null)
    }
  }

  const downloadClip = async () => {
    setBusy('download')
    try {
      const blob = await getClipBlob(clip.id)
      if (!blob) {
        setAudioState('missing')
        onNotice({ tone: 'warn', message: 'Saved audio is missing for this clip.' })
        return
      }
      const downloadUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = downloadUrl
      a.download = clip.filename
      a.click()
      setAudioState('ready')
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
    } catch {
      setAudioState('error')
      onNotice({ tone: 'error', message: 'Could not download saved audio.' })
    } finally {
      setBusy(null)
    }
  }

  const removeClip = async () => {
    setBusy('delete')
    try {
      const snapshot = await deleteClipWithSnapshot(clip.id)
      if (!snapshot) throw new Error('Saved audio is missing for this clip.')
      if (url) URL.revokeObjectURL(url)
      onDeleted(snapshot)
    } catch (error) {
      onNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not remove this saved clip.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="result-row library-row">
      <div className="result-meta">
        <span className="ready-dot" aria-hidden="true" />
        <strong>{clip.label}</strong>
        <span title={clip.filename}>{clip.filename}</span>
        <span>{libraryEngineLabel(libraryEngineId(clip))}</span>
        <span>{clip.voice}</span>
        <span>{clip.duration}</span>
        <span>{formatBytes(clip.size)}</span>
        {clip.cues?.length ? <span>{clip.cues.length} cues</span> : <span>time resume</span>}
      </div>
      {replayWarning ? (
        <div className="capability-strip warn" role="status">
          <Info size={15} aria-hidden="true" />
          <span>{replayWarning}</span>
        </div>
      ) : null}
      {audioState === 'missing' ? (
        <div className="library-missing" role="alert">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>Audio file is missing from local storage. Remove this entry to recover.</span>
          <button type="button" onClick={removeClip} disabled={busy !== null}>Remove missing entry</button>
        </div>
      ) : audioState === 'error' ? (
        <div className="library-missing" role="status">Audio could not be loaded. Try again or remove this entry.</div>
      ) : null}
      {url ? <PlaybackAudio playbackKey={`clip:${clip.id}`} src={url} label={clip.filename} cues={clip.cues} vttUrl={vttUrl} /> : null}
      <div className="result-actions">
        <button type="button" onClick={loadPlayer} disabled={busy !== null || url !== null}>
          {busy === 'load' ? <Loader2 size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          {url ? 'Loaded' : 'Play'}
        </button>
        <button type="button" onClick={downloadClip} disabled={busy !== null}>
          {busy === 'download' ? <Loader2 size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
          Download
        </button>
        <button type="button" onClick={removeClip} disabled={busy !== null} aria-label={`Remove ${clip.label}`}>
          {busy === 'delete' ? <Loader2 size={16} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}
