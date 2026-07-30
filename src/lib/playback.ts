import type { Cue } from './subtitles.ts'

export type PlaybackState = {
  timeSec: number
  cueIndex?: number
  updatedAt: number
}

type PlaybackStore = {
  version: 1
  items: Record<string, PlaybackState>
}

export type PlaybackStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const STORAGE_KEY = 'bettertts-playback-v1'
const MAX_ITEMS = 80
const PLAYBACK_PERSIST_INTERVAL_SECONDS = 1

export function shouldPersistPlayback(previousTimeSec: number, nextTimeSec: number, force = false): boolean {
  if (force) return Number.isFinite(nextTimeSec)
  if (!Number.isFinite(nextTimeSec)) return false
  if (!Number.isFinite(previousTimeSec)) return true
  return Math.abs(nextTimeSec - previousTimeSec) >= PLAYBACK_PERSIST_INTERVAL_SECONDS
}

function browserStorage(): PlaybackStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function emptyStore(): PlaybackStore {
  return { version: 1, items: {} }
}

function normalizeState(raw: unknown): PlaybackState | null {
  const state = raw as Partial<PlaybackState>
  if (!Number.isFinite(state.timeSec) || !Number.isFinite(state.updatedAt)) return null
  const timeSec = Math.max(0, Number(state.timeSec))
  const cueIndex = Number.isInteger(state.cueIndex) && Number(state.cueIndex) >= 0 ? Number(state.cueIndex) : undefined
  return { timeSec, cueIndex, updatedAt: Math.max(0, Number(state.updatedAt)) }
}

function readStore(storage: PlaybackStorage | null = browserStorage()): PlaybackStore {
  if (!storage) return emptyStore()
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyStore()
    const parsed = JSON.parse(raw) as Partial<PlaybackStore>
    if (parsed.version !== 1 || !parsed.items || typeof parsed.items !== 'object') return emptyStore()
    const items: Record<string, PlaybackState> = {}
    for (const [key, value] of Object.entries(parsed.items)) {
      const state = normalizeState(value)
      if (state) items[key] = state
    }
    return { version: 1, items }
  } catch {
    return emptyStore()
  }
}

function writeStore(store: PlaybackStore, storage: PlaybackStorage | null = browserStorage()): void {
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Private browsing or quota errors should not break audio playback.
  }
}

export function loadPlaybackState(key: string, storage: PlaybackStorage | null = browserStorage()): PlaybackState | null {
  return readStore(storage).items[key] ?? null
}

export function savePlaybackState(key: string, state: Omit<PlaybackState, 'updatedAt'> & { updatedAt?: number }, storage: PlaybackStorage | null = browserStorage()): void {
  if (!key.trim() || !Number.isFinite(state.timeSec)) return
  const store = readStore(storage)
  store.items[key] = {
    timeSec: Math.max(0, state.timeSec),
    cueIndex: Number.isInteger(state.cueIndex) && Number(state.cueIndex) >= 0 ? Number(state.cueIndex) : undefined,
    updatedAt: state.updatedAt ?? Date.now(),
  }

  const entries = Object.entries(store.items).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_ITEMS)
  store.items = Object.fromEntries(entries)
  writeStore(store, storage)
}

export function clearPlaybackState(key: string, storage: PlaybackStorage | null = browserStorage()): void {
  if (!storage) return
  const store = readStore(storage)
  delete store.items[key]
  if (Object.keys(store.items).length === 0) {
    try {
      storage.removeItem(STORAGE_KEY)
    } catch {
      // Ignore blocked storage.
    }
    return
  }
  writeStore(store, storage)
}

export function cueIndexAtTime(cues: Cue[], timeSec: number): number {
  if (!Number.isFinite(timeSec) || cues.length === 0) return -1
  const t = Math.max(0, timeSec)
  for (let i = 0; i < cues.length; i += 1) {
    if (t >= cues[i].startSec && t < cues[i].endSec) return i
  }
  return -1
}

export function previousCueIndex(cues: Cue[], timeSec: number): number {
  if (cues.length === 0) return -1
  const active = cueIndexAtTime(cues, timeSec)
  if (active > 0 && timeSec - cues[active].startSec <= 1.25) return active - 1
  if (active >= 0) return active
  for (let i = cues.length - 1; i >= 0; i -= 1) {
    if (timeSec >= cues[i].endSec) return i
  }
  return 0
}

export function nextCueIndex(cues: Cue[], timeSec: number): number {
  if (cues.length === 0) return -1
  const active = cueIndexAtTime(cues, timeSec)
  if (active >= 0) return Math.min(cues.length - 1, active + 1)
  for (let i = 0; i < cues.length; i += 1) {
    if (timeSec < cues[i].startSec) return i
  }
  return cues.length - 1
}

export function clampResumeTime(timeSec: number, durationSec: number): number {
  if (!Number.isFinite(timeSec) || timeSec <= 0) return 0
  if (!Number.isFinite(durationSec) || durationSec <= 0) return timeSec
  return timeSec < Math.max(0, durationSec - 0.5) ? timeSec : 0
}

export function formatPlaybackTime(timeSec: number): string {
  const total = Math.max(0, Math.floor(timeSec))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
