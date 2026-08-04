import rawCapabilities from '../../capabilities.json'

export type CapabilityPlatform = 'web' | 'windows' | 'macos' | 'linux'
export type CapabilityRuntime = 'browser' | 'native' | 'sidecar'
export type CapabilityAudioFormat = 'wav' | 'mp3' | 'opus' | 'flac' | 'm4b'
export type CapabilityPostStageId = 'rvc'
export type CapabilityEngineId = 'kokoro' | 'supertonic' | 'kitten' | 'chatterbox' | 'piper' | 'melo' | 'qwen' | 'browser'

export type CapabilityLicense = {
  spdx: string
  tier: 'permissive' | 'restricted' | 'non-commercial'
}

export type CapabilityEngine = {
  id: CapabilityEngineId
  label: string
  platforms: readonly CapabilityPlatform[]
  runtime: readonly CapabilityRuntime[]
  queueable: boolean
  streaming: boolean
  timestamps: boolean
  exportFormats: readonly CapabilityAudioFormat[]
  experimental: boolean
  firstLoad: 'default' | 'lazy'
  modelId: string
  modelLicenseIds: readonly string[]
  postStages: readonly CapabilityPostStageId[]
}

export type CapabilityModel = {
  id: string
  label: string
  modelId: string
  license: CapabilityLicense
  usedFor: string
}

export type CapabilityLicenseRow = {
  name: string
  spdx: string
  usedFor: string
}

export type CapabilityManifest = {
  schemaVersion: 1
  app: {
    name: 'BetterTTS'
    version: string
    supportedPlatforms: readonly CapabilityPlatform[]
  }
  testMetrics: {
    testFiles: number
    tests: number
  }
  queue: {
    resumable: boolean
    engines: readonly CapabilityEngineId[]
  }
  exports: {
    audioFormats: readonly CapabilityAudioFormat[]
    captionFormats: readonly string[]
    bundleFormats: readonly string[]
  }
  engines: readonly CapabilityEngine[]
  modelRows: readonly {
    name: string
    engine: string
    size: string
    coverage: string
    status: string
  }[]
  models: readonly CapabilityModel[]
  runtimeLicenses: {
    application: CapabilityLicenseRow
    packages: readonly CapabilityLicenseRow[]
    additional: readonly CapabilityLicenseRow[]
  }
}

export const CAPABILITIES: CapabilityManifest = rawCapabilities as unknown as CapabilityManifest

export function capabilityEngine(engineId: string): CapabilityEngine | undefined {
  return CAPABILITIES.engines.find((engine) => engine.id === engineId)
}

export function capabilityLicenseRows(): readonly CapabilityLicenseRow[] {
  return [
    CAPABILITIES.runtimeLicenses.application,
    ...CAPABILITIES.runtimeLicenses.packages,
    ...CAPABILITIES.runtimeLicenses.additional,
    ...CAPABILITIES.models.map((model) => ({
      name: model.label,
      spdx: model.license.spdx,
      usedFor: model.usedFor,
    })),
  ]
}
