import { useCallback, useEffect, useRef, useState } from 'react'

export type GenerationStats = {
  elapsed: number
  chars: number
  audioDuration: number
  timeToFirstAudioMs: number | null
}

export function useGeneration() {
  const [progress, setProgress] = useState<number | null>(null)
  const [status, setStatus] = useState('Ready')
  const [isGenerating, setIsGenerating] = useState(false)
  const [genStats, setGenStats] = useState<GenerationStats | null>(null)
  const progressTimerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const abortRef = useRef(false)
  const generationAbortRef = useRef<AbortController | null>(null)
  const generatingRef = useRef(false)

  const clearProgressResetTimer = useCallback(() => {
    if (progressTimerRef.current) {
      clearTimeout(progressTimerRef.current)
      progressTimerRef.current = null
    }
  }, [])

  useEffect(() => () => {
    clearProgressResetTimer()
    generationAbortRef.current?.abort()
  }, [clearProgressResetTimer])

  return {
    progress,
    setProgress,
    status,
    setStatus,
    isGenerating,
    setIsGenerating,
    genStats,
    setGenStats,
    progressTimerRef,
    abortRef,
    generationAbortRef,
    generatingRef,
    clearProgressResetTimer,
  }
}
