import { describe, expect, it } from 'vitest'
import {
  addListeningSeconds,
  DEFAULT_LISTENING_TRAINER,
  listeningTrainerRate,
  listeningTrainerSecondsToNextStep,
  parseListeningTrainerSetting,
  resetListeningTrainer,
} from './listening-trainer.ts'

describe('listening speed trainer', () => {
  it('stays at normal speed until enabled and ramps in five percent steps', () => {
    expect(listeningTrainerRate(DEFAULT_LISTENING_TRAINER)).toBe(1)
    const enabled = { ...DEFAULT_LISTENING_TRAINER, enabled: true }
    expect(listeningTrainerRate(enabled)).toBe(1)
    expect(listeningTrainerRate(addListeningSeconds(enabled, 5 * 60))).toBe(1.05)
    expect(listeningTrainerRate(addListeningSeconds(enabled, 10 * 60))).toBe(1.1)
  })

  it('never exceeds the selected cap and reports the next step', () => {
    const settings = { ...DEFAULT_LISTENING_TRAINER, enabled: true, cap: 1.1, listenedSeconds: 25 * 60 + 10 }
    expect(listeningTrainerRate(settings)).toBe(1.1)
    expect(listeningTrainerSecondsToNextStep(settings)).toBeNull()
    expect(listeningTrainerSecondsToNextStep({ ...settings, cap: 1.5, listenedSeconds: 4 * 60 + 20 })).toBe(40)
  })

  it('bounds persisted state and resets only listening progress', () => {
    const parsed = parseListeningTrainerSetting(JSON.stringify({
      enabled: true,
      intervalMinutes: 999,
      cap: 9,
      listenedSeconds: -4,
    }))
    expect(parsed).toMatchObject({ enabled: true, intervalMinutes: 60, cap: 2, listenedSeconds: 0 })
    expect(resetListeningTrainer({ ...parsed, listenedSeconds: 120 })).toEqual({ ...parsed, listenedSeconds: 0 })
    expect(parseListeningTrainerSetting('{')).toEqual(DEFAULT_LISTENING_TRAINER)
  })
})
