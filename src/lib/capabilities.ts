import rawCapabilities from '../../capabilities.json'

export type CapabilityPlatform = 'web' | 'windows' | 'macos' | 'linux'
export type CapabilityRuntime = 'browser' | 'native' | 'sidecar'
export type CapabilityAudioFormat = 'wav' | 'mp3' | 'opus' | 'flac' | 'm4b'
export type CapabilityPostStageId = 'rvc'
export type CapabilityEngineId = 'kokoro' | 'supertonic' | 'kitten' | 'chatterbox' | 'piper' | 'melo' | 'qwen' | 'browser'
export type CapabilityRuntimeIdentityKind = 'npm' | 'sidecar' | 'platform'

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
  provenance: {
    modelIds: readonly string[]
    runtimeIds: readonly string[]
  }
  postStages: readonly CapabilityPostStageId[]
}

export type CapabilityEngineCore = Omit<CapabilityEngine, 'provenance'>

export type CapabilityModelArtifact = {
  path: string
  sizeBytes: number
  sha256: string
  sourceUrl?: string
}

export type CapabilityModelVariant = {
  id: string
  modelId: string
  revision: string
  sourceUrl: string
  artifacts?: readonly CapabilityModelArtifact[]
}

export type CapabilityModel = {
  id: string
  label: string
  modelId: string
  revision: string
  sourceUrl: string
  assetManifest?: string
  artifacts?: readonly CapabilityModelArtifact[]
  variants?: readonly CapabilityModelVariant[]
  license: CapabilityLicense
  usedFor: string
}

export type CapabilityRuntimePackage = {
  name: string
  version: string
  integrity?: string
  resolved?: string
  sha256?: string
  sourceUrl?: string
}

export type CapabilityRuntimeIdentity = {
  id: string
  runtime: CapabilityRuntime
  kind: CapabilityRuntimeIdentityKind
  revision: string
  sourceUrl: string
  packages: readonly CapabilityRuntimePackage[]
  manifestFile?: string
  manifestSha256?: string
}

export type CapabilityLicenseRow = {
  name: string
  spdx: string
  usedFor: string
}

export type CapabilityManifest = {
  schemaVersion: 2
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
  runtimeIdentities: readonly CapabilityRuntimeIdentity[]
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

export function capabilityModel(modelId: string): CapabilityModel | undefined {
  return CAPABILITIES.models.find((model) => model.id === modelId)
}

export function capabilityModelVariant(modelId: string, variantId: string): CapabilityModelVariant | undefined {
  return capabilityModel(modelId)?.variants?.find((variant) => variant.id === variantId)
}

export function capabilityRuntime(runtimeId: string): CapabilityRuntimeIdentity | undefined {
  return CAPABILITIES.runtimeIdentities.find((runtime) => runtime.id === runtimeId)
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
