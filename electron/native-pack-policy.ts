import {
  NativeModelPackError,
  type NativeModelPackErrorKind,
  type PackStatus,
} from './native-models.ts'

export const DEV_MODEL_FALLBACK_ENV = 'BETTERTTS_DEV_ALLOW_UNVERIFIED_MODEL_FALLBACK'
export const PACKAGED_APP_ENV = 'BETTERTTS_APP_PACKAGED'

export type NativePackFailure = {
  kind: NativeModelPackErrorKind
  message: string
}

type EnsureResult = {
  localModelRoot: string
  status: PackStatus
}

type InitializeNativeRuntimeOptions<T> = {
  ensure: () => Promise<EnsureResult>
  readStatus: () => Promise<PackStatus | undefined>
  createRuntime: (localModelRoot: string | null) => Promise<T>
  env?: Record<string, string | undefined>
  onFailure?: (failure: NativePackFailure, fallbackAllowed: boolean) => void
}

export class NativePackLoadError extends Error {
  readonly failure: NativePackFailure

  constructor(failure: NativePackFailure, options?: ErrorOptions) {
    super(`Native model pack ${failure.kind} check failed: ${failure.message}`, options)
    this.name = 'NativePackLoadError'
    this.failure = failure
  }
}

export function classifyNativePackFailure(error: unknown): NativePackFailure {
  if (error instanceof NativeModelPackError) {
    return { kind: error.kind, message: error.message }
  }
  return {
    kind: 'unavailable',
    message: error instanceof Error ? error.message : String(error),
  }
}

export function devModelFallbackAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env[DEV_MODEL_FALLBACK_ENV] === '1' && env[PACKAGED_APP_ENV] !== '1'
}

export async function initializeNativeRuntimeWithPack<T>(
  options: InitializeNativeRuntimeOptions<T>,
): Promise<{ runtime: T; modelPack?: PackStatus; failure?: NativePackFailure }> {
  let localModelRoot: string | null
  let modelPack: PackStatus | undefined
  let failure: NativePackFailure | undefined
  try {
    const ensured = await options.ensure()
    localModelRoot = ensured.localModelRoot
    modelPack = ensured.status
  } catch (error) {
    failure = classifyNativePackFailure(error)
    const fallbackAllowed = devModelFallbackAllowed(options.env)
    options.onFailure?.(failure, fallbackAllowed)
    if (!fallbackAllowed) throw new NativePackLoadError(failure, { cause: error })

    localModelRoot = null
    modelPack = await options.readStatus().catch(() => undefined)
  }
  const runtime = await options.createRuntime(localModelRoot)
  return { runtime, modelPack, ...(failure ? { failure } : {}) }
}
