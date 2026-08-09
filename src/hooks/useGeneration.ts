import { useCallback, useEffect, useReducer, useRef, type Dispatch } from 'react'
import { generationReducer, INITIAL_GENERATION_STATE, type GenerationStats } from '../lib/app-shell-state.ts'

export type { GenerationStats } from '../lib/app-shell-state.ts'

export function useGeneration() {
  const [state, dispatch] = useReducer(generationReducer, INITIAL_GENERATION_STATE)
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

  const setProgress = useCallback((value: number | null) => dispatch({ type: 'set-progress', value }), [])
  const setStatus = useCallback((value: string) => dispatch({ type: 'set-status', value }), [])
  const setIsGenerating = useCallback((value: boolean) => dispatch({ type: 'set-busy', value }), [])
  const setGenStats = useCallback((value: GenerationStats | null) => dispatch({ type: 'set-stats', value }), [])

  return {
    progress: state.progress,
    setProgress,
    status: state.status,
    setStatus,
    isGenerating: state.phase === 'starting' || state.phase === 'running' || state.phase === 'cancelling',
    setIsGenerating,
    genStats: state.stats,
    setGenStats,
    generationPhase: state.phase,
    generationError: state.error,
    generationRunId: state.runId,
    partialOutput: state.partialOutput,
    dispatchGeneration: dispatch as Dispatch<Parameters<typeof generationReducer>[1]>,
    progressTimerRef,
    abortRef,
    generationAbortRef,
    generatingRef,
    clearProgressResetTimer,
  }
}
