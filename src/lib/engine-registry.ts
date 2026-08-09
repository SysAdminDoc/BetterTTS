import type { ByoModelOptionId } from './byo-models.ts'
import { CORE_ENGINES } from './capabilities-core.ts'
import type { CapabilityEngineCore, CapabilityEngineId } from './capabilities.ts'

export type {
  EngineAccelerator,
  EngineAdapter,
  EngineAdapterContext,
  EngineAudio,
  EngineAvailability,
  EngineCapabilities,
  EngineDiagnosticField,
  EngineDiagnosticsDescriptor,
  EngineExportFormat,
  EngineHardwareRequirements,
  EngineLicense,
  EngineLicenseTier,
  EngineManifest,
  EngineModelFile,
  EngineModelSource,
  EnginePlatform,
  EngineProbeContext,
  EngineProgress,
  EngineRuntime,
  EngineSafetyTier,
  EngineSynthesisRequest,
} from './engine-adapter.ts'

export type EngineId = CapabilityEngineId

export type PostStageId = 'rvc'

export type PostStageDescriptor = {
  id: PostStageId
  label: string
  desktopOnly: boolean
  consentRequired: boolean
}

export const POST_STAGE_REGISTRY: PostStageDescriptor[] = [
  { id: 'rvc', label: 'RVC voice conversion', desktopOnly: true, consentRequired: true },
]

export type EngineDescriptor = CapabilityEngineCore

export type EngineFlags = {
  piperPlus: boolean
  melo?: boolean
  chatterbox?: boolean
  qwen?: boolean
}

export const EXPERIMENTAL_PIPER_STORAGE_KEY = 'bettertts-experimental-piper'
export const EXPERIMENTAL_CHATTERBOX_STORAGE_KEY = 'bettertts-chatterbox-consent'

export const ENGINE_REGISTRY: readonly EngineDescriptor[] = CORE_ENGINES

export function visibleEngineDescriptors(flags: EngineFlags): EngineDescriptor[] {
  return ENGINE_REGISTRY.filter((engine) =>
    (engine.id !== 'piper' || flags.piperPlus)
    && (engine.id !== 'melo' || flags.melo === true)
    && (engine.id !== 'chatterbox' || flags.chatterbox === true)
    && (engine.id !== 'qwen' || flags.qwen === true),
  )
}

export function engineQueueable(engineId: EngineId): boolean {
  return ENGINE_REGISTRY.find((engine) => engine.id === engineId)?.queueable === true
}

export function engineSupportsPostStage(engineId: EngineId, stage: PostStageId): boolean {
  return stage === 'rvc' && engineId !== 'browser'
}

/** Restricted engines are cataloged only after the user has acknowledged the
 * license gate and registered a local weight location. */
export function visibleUserSuppliedEngines(consent: boolean, modelIds: readonly ByoModelOptionId[]): ByoModelOptionId[] {
  return consent ? [...new Set(modelIds)] : []
}
