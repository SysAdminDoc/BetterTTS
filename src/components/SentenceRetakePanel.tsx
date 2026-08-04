import { Check, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Cue } from '../lib/subtitles.ts'
import { type SentenceRetakeAudio } from '../lib/sentence-retakes.ts'
import { toVTT } from '../lib/subtitles.ts'
import './SentenceRetakePanel.css'

type SentenceRetakeTake = SentenceRetakeAudio & {
  id: string
  text: string
  url: string
}

type RetakeNotice = {
  tone: 'ok' | 'warn' | 'error'
  message: string
}

export type SentenceRetakePanelProps = {
  jobId: string
  chunkIndex: number
  cues: readonly Cue[]
  regenerating: boolean
  onRetake: (jobId: string, chunkIndex: number, cue: Cue, text: string) => Promise<SentenceRetakeAudio | null>
  onSplice: (jobId: string, chunkIndex: number, cue: Cue, take: SentenceRetakeAudio, text: string) => Promise<boolean>
  onNotice: (toast: RetakeNotice) => void
}

function cueDataUrl(cues: readonly Cue[]): string {
  return `data:text/vtt;charset=utf-8,${encodeURIComponent(toVTT([...cues]))}`
}

export function SentenceRetakePanel({ jobId, chunkIndex, cues, regenerating, onRetake, onSplice, onNotice }: SentenceRetakePanelProps) {
  const [selectedCueIndex, setSelectedCueIndex] = useState<number | null>(null)
  const [retakeText, setRetakeText] = useState('')
  const [retakeBusy, setRetakeBusy] = useState<string | null>(null)
  const [retakeTakes, setRetakeTakes] = useState<Record<number, SentenceRetakeTake[]>>({})
  const takeUrls = useMemo(() => new Set<string>(), [])
  const takeIdRef = useRef(0)
  const selectedCue = useMemo(() => cues.find((cue) => cue.index === selectedCueIndex) ?? null, [cues, selectedCueIndex])
  const selectedTakes = selectedCue ? retakeTakes[selectedCue.index] ?? [] : []

  useEffect(() => {
    return () => {
      for (const takeUrl of takeUrls) URL.revokeObjectURL(takeUrl)
      takeUrls.clear()
    }
  }, [takeUrls])

  useEffect(() => {
    for (const takeUrl of takeUrls) URL.revokeObjectURL(takeUrl)
    takeUrls.clear()
    setRetakeTakes({})
    setSelectedCueIndex(null)
    setRetakeText('')
  }, [chunkIndex, cues, takeUrls])

  const retakeSelectedCue = async () => {
    if (!selectedCue || !retakeText.trim() || regenerating || retakeBusy) return
    const text = retakeText.trim()
    const busyKey = `retake:${selectedCue.index}`
    setRetakeBusy(busyKey)
    try {
      const audio = await onRetake(jobId, chunkIndex, selectedCue, text)
      if (!audio) return
      const url = URL.createObjectURL(audio.blob)
      takeUrls.add(url)
      const take: SentenceRetakeTake = {
        ...audio,
        id: `${selectedCue.index}:${Date.now()}:${takeIdRef.current++}`,
        text,
        url,
      }
      setRetakeTakes((previous) => {
        const prior = previous[selectedCue.index] ?? []
        if (prior.length >= 4) {
          const evicted = prior[0]
          URL.revokeObjectURL(evicted.url)
          takeUrls.delete(evicted.url)
        }
        return { ...previous, [selectedCue.index]: [...prior.slice(-3), take] }
      })
    } catch (error) {
      onNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Sentence retake failed.' })
    } finally {
      setRetakeBusy(null)
    }
  }

  const spliceSelectedTake = async (take: SentenceRetakeTake) => {
    if (!selectedCue || regenerating || retakeBusy) return
    setRetakeBusy(`splice:${take.id}`)
    try {
      const applied = await onSplice(jobId, chunkIndex, selectedCue, take, take.text)
      if (applied) {
        for (const takeUrl of takeUrls) URL.revokeObjectURL(takeUrl)
        takeUrls.clear()
        setRetakeTakes({})
        setSelectedCueIndex(null)
        setRetakeText('')
      }
    } catch (error) {
      onNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Sentence splice failed. Old audio kept.' })
    } finally {
      setRetakeBusy(null)
    }
  }

  return (
    <section className="sentence-retake-panel" aria-label={`Sentence retakes for chunk ${chunkIndex + 1}`}>
      <div className="sentence-retake-heading">
        <strong>Sentence retakes</strong>
        <small>Select a sentence, make an optional edit, and keep up to four A/B takes.</small>
      </div>
      <div className="sentence-retake-list" role="list" aria-label="Sentences">
        {cues.map((cue) => (
          <button
            key={cue.index}
            type="button"
            className={selectedCueIndex === cue.index ? 'sentence-retake-item selected' : 'sentence-retake-item'}
            aria-pressed={selectedCueIndex === cue.index}
            onClick={() => {
              setSelectedCueIndex(cue.index)
              setRetakeText(cue.text)
            }}
            disabled={regenerating || retakeBusy !== null}
          >
            <span>{cue.index}.</span>
            <span>{cue.text}</span>
          </button>
        ))}
      </div>
      {selectedCue ? (
        <div className="sentence-retake-editor">
          <label>
            Retake text
            <textarea
              aria-label={`Retake text for sentence ${selectedCue.index}`}
              value={retakeText}
              onChange={(event) => setRetakeText(event.target.value)}
              rows={3}
            />
          </label>
          <button type="button" onClick={retakeSelectedCue} disabled={regenerating || retakeBusy !== null || !retakeText.trim()}>
            {retakeBusy === `retake:${selectedCue.index}` ? <Loader2 size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
            Retake sentence
          </button>
          {selectedTakes.length ? (
            <div className="sentence-retake-takes" aria-label={`A/B takes for sentence ${selectedCue.index}`}>
              {selectedTakes.map((take, takeIndex) => (
                <div className="sentence-retake-take" key={take.id}>
                  <strong>Take {takeIndex + 1}</strong>
                  <small>{take.text}</small>
                  <audio controls preload="metadata" src={take.url} aria-label={`Retake ${takeIndex + 1} for sentence ${selectedCue.index}`}>
                    <track
                      kind="captions"
                      src={cueDataUrl([{ index: 1, startSec: 0, endSec: take.samples.length / take.sampleRate, text: take.text }])}
                      srcLang="en"
                      label="Sentence text"
                    />
                  </audio>
                  <button type="button" onClick={() => spliceSelectedTake(take)} disabled={regenerating || retakeBusy !== null}>
                    {retakeBusy === `splice:${take.id}` ? <Loader2 size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
                    Use take
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <small>No retake takes yet. The original remains unchanged until you use one.</small>
          )}
        </div>
      ) : (
        <small>Select a sentence to create and compare a retake.</small>
      )}
    </section>
  )
}
