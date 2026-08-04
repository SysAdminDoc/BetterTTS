export const DEFAULT_LISTENING_PROFILE_ID = 'default'
export const LISTENING_TRAINER_STORAGE_KEY = `bettertts-listening-trainer-v1:${DEFAULT_LISTENING_PROFILE_ID}`
export const LISTENING_TRAINER_STEP = 0.05
export const LISTENING_TRAINER_MIN_CAP = 1
export const LISTENING_TRAINER_MAX_CAP = 2
export const LISTENING_TRAINER_INTERVALS = [5, 10, 15, 20] as const

export type ListeningTrainerSettings = {
  enabled: boolean
  intervalMinutes: number
  cap: number
  listenedSeconds: number
}

export const DEFAULT_LISTENING_TRAINER: ListeningTrainerSettings = {
  enabled: false,
  intervalMinutes: LISTENING_TRAINER_INTERVALS[0],
  cap: 1.5,
  listenedSeconds: 0,
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function intervalMinutes(value: unknown): number {
  return boundedNumber(value, DEFAULT_LISTENING_TRAINER.intervalMinutes, 1, 60)
}

export function parseListeningTrainerSetting(raw: string | null): ListeningTrainerSettings {
  if (!raw) return DEFAULT_LISTENING_TRAINER
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!plainRecord(parsed)) return DEFAULT_LISTENING_TRAINER
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_LISTENING_TRAINER.enabled,
      intervalMinutes: intervalMinutes(parsed.intervalMinutes),
      cap: boundedNumber(parsed.cap, DEFAULT_LISTENING_TRAINER.cap, LISTENING_TRAINER_MIN_CAP, LISTENING_TRAINER_MAX_CAP),
      listenedSeconds: boundedNumber(parsed.listenedSeconds, 0, 0, 7 * 24 * 60 * 60),
    }
  } catch {
    return DEFAULT_LISTENING_TRAINER
  }
}

export function listeningTrainerRate(settings: ListeningTrainerSettings): number {
  if (!settings.enabled) return 1
  const steps = Math.floor(Math.max(0, settings.listenedSeconds) / (Math.max(1, settings.intervalMinutes) * 60))
  return Math.min(settings.cap, 1 + steps * LISTENING_TRAINER_STEP)
}

export function addListeningSeconds(settings: ListeningTrainerSettings, seconds: number): ListeningTrainerSettings {
  if (!Number.isFinite(seconds) || seconds <= 0) return settings
  return {
    ...settings,
    listenedSeconds: Math.min(7 * 24 * 60 * 60, Math.max(0, settings.listenedSeconds + seconds)),
  }
}

export function resetListeningTrainer(settings: ListeningTrainerSettings): ListeningTrainerSettings {
  return { ...settings, listenedSeconds: 0 }
}

export function listeningTrainerSecondsToNextStep(settings: ListeningTrainerSettings): number | null {
  if (!settings.enabled || listeningTrainerRate(settings) >= settings.cap) return null
  const intervalSeconds = Math.max(1, settings.intervalMinutes) * 60
  const remainder = Math.max(0, settings.listenedSeconds) % intervalSeconds
  return remainder === 0 ? intervalSeconds : intervalSeconds - remainder
}
