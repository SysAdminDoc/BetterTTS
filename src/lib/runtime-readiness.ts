export const TRANSFORMERS_RUNTIME_VERSION = '4.2.0'
export const TRANSFORMERS_V43_TARGET_VERSION = '4.3.0'
export const WEBGPU_ADAPTER_DENYLIST_STORAGE_KEY = 'bettertts-webgpu-adapter-denylist'

const MAX_WEBGPU_DENYLIST_ENTRIES = 8
const WEBGPU_ADAPTER_INFO_KEYS = ['vendor', 'architecture', 'device', 'description', 'name'] as const

export type WebGpuAdapterInfo = Record<string, string | number | boolean | null>

export type WebGpuDenylistEntry = {
  adapterKey: string
  adapterInfo?: WebGpuAdapterInfo
  reason: string
  reportedAt: string
}

export type WebGpuProbeResult = {
  supported: boolean
  adapterAvailable: boolean
  usable: boolean
  denylisted: boolean
  status: string
  adapterInfo?: WebGpuAdapterInfo
  adapterKey?: string
  denylistReason?: string
  error?: string
}

type WebGpuNavigatorLike = {
  gpu?: {
    requestAdapter?: (options?: { powerPreference?: 'high-performance' | 'low-power' }) => Promise<unknown | null>
  }
}

type WebGpuAdapterLike = {
  info?: unknown
  requestAdapterInfo?: () => Promise<unknown>
  [key: string]: unknown
}

let memoryWebGpuDenylist: WebGpuDenylistEntry[] | null = null

export async function probeWebGpuCapability(
  navigatorLike: WebGpuNavigatorLike | undefined = typeof navigator === 'undefined' ? undefined : navigator as unknown as WebGpuNavigatorLike,
): Promise<WebGpuProbeResult> {
  const gpu = navigatorLike?.gpu
  if (!gpu) {
    return {
      supported: false,
      adapterAvailable: false,
      usable: false,
      denylisted: false,
      status: 'navigator.gpu unavailable',
    }
  }
  if (typeof gpu.requestAdapter !== 'function') {
    return {
      supported: true,
      adapterAvailable: false,
      usable: false,
      denylisted: false,
      status: 'requestAdapter unavailable',
    }
  }

  try {
    let adapter: unknown | null = null
    try {
      adapter = await gpu.requestAdapter()
    } catch {
      // Older implementations may require the optional preference dictionary.
      try {
        adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
      } catch {
        adapter = null
      }
    }
    if (!adapter) {
      return {
        supported: true,
        adapterAvailable: false,
        usable: false,
        denylisted: false,
        status: 'no adapter available',
      }
    }

    const adapterInfo = await readWebGpuAdapterInfo(adapter)
    const adapterKey = createWebGpuAdapterKey(adapterInfo)
    const denylistEntry = adapterKey
      ? readWebGpuAdapterDenylist().find((entry) => entry.adapterKey === adapterKey)
      : undefined
    const denylisted = denylistEntry != null
    return {
      supported: true,
      adapterAvailable: true,
      usable: !denylisted,
      denylisted,
      status: denylisted ? 'adapter denylisted' : 'adapter available',
      adapterInfo,
      adapterKey,
      denylistReason: denylistEntry?.reason,
    }
  } catch (err) {
    return {
      supported: true,
      adapterAvailable: false,
      usable: false,
      denylisted: false,
      status: 'adapter probe failed',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function readWebGpuAdapterDenylist(): WebGpuDenylistEntry[] {
  if (memoryWebGpuDenylist) return cloneWebGpuDenylist(memoryWebGpuDenylist)

  let parsed: unknown
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(WEBGPU_ADAPTER_DENYLIST_STORAGE_KEY)
    parsed = raw ? JSON.parse(raw) : []
  } catch {
    parsed = []
  }
  memoryWebGpuDenylist = normalizeWebGpuDenylist(parsed)
  return cloneWebGpuDenylist(memoryWebGpuDenylist)
}

export function denylistWebGpuAdapter(
  adapterKey: string | undefined,
  adapterInfo: WebGpuAdapterInfo | undefined,
  reason = 'User reported corrupted or unusable WebGPU audio.',
  now = new Date(),
): boolean {
  if (!adapterKey) return false
  const entry: WebGpuDenylistEntry = {
    adapterKey: adapterKey.slice(0, 500),
    ...(adapterInfo ? { adapterInfo: cloneWebGpuAdapterInfo(adapterInfo) } : {}),
    reason: reason.slice(0, 240),
    reportedAt: now.toISOString(),
  }
  const entries = [entry, ...readWebGpuAdapterDenylist().filter((current) => current.adapterKey !== entry.adapterKey)]
  writeWebGpuDenylist(entries.slice(0, MAX_WEBGPU_DENYLIST_ENTRIES))
  return true
}

export function clearWebGpuAdapterDenylist(adapterKey?: string): void {
  const entries = adapterKey
    ? readWebGpuAdapterDenylist().filter((entry) => entry.adapterKey !== adapterKey)
    : []
  writeWebGpuDenylist(entries)
}

export type CrossOriginStorageStatus = {
  api: 'navigator.crossOriginStorage'
  exposed: boolean
  requestFileHandle: boolean
  secureContext: boolean | null
  usable: boolean
  defaultBehavior: 'disabled'
  message: string
}

export type TransformersUpgradeCriterion = {
  id: string
  label: string
  met: boolean
  required: boolean
}

export type TransformersUpgradeReadiness = {
  currentVersion: string
  targetVersion: string
  readyToSwitch: boolean
  criteria: TransformersUpgradeCriterion[]
}

type CrossOriginStorageProbe = {
  navigator?: {
    crossOriginStorage?: unknown
  }
  secureContext?: boolean | null
}

type TransformersReadinessInput = {
  currentVersion?: string
  targetVersion?: string
  candidateEngineSuitePassed?: boolean
  currentRegistryApisVerified?: boolean
}

type CrossOriginStorageManagerLike = {
  requestFileHandle?: unknown
}

export function detectCrossOriginStorage(probe: CrossOriginStorageProbe = {}): CrossOriginStorageStatus {
  const navigatorLike = probe.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator as CrossOriginStorageProbe['navigator'])
  const secureContext = probe.secureContext ?? (typeof isSecureContext === 'boolean' ? isSecureContext : null)
  const manager = navigatorLike?.crossOriginStorage as CrossOriginStorageManagerLike | undefined
  const exposed = manager != null && typeof manager === 'object'
  const requestFileHandle = typeof manager?.requestFileHandle === 'function'
  const usable = exposed && requestFileHandle && secureContext !== false

  return {
    api: 'navigator.crossOriginStorage',
    exposed,
    requestFileHandle,
    secureContext,
    usable,
    defaultBehavior: 'disabled',
    message: usable
      ? 'Experimental Cross-Origin Storage API detected; BetterTTS still uses the per-origin Cache API by default.'
      : exposed
        ? 'Experimental Cross-Origin Storage is exposed but does not provide the expected requestFileHandle() method.'
        : 'Cross-Origin Storage is not exposed; BetterTTS uses the per-origin Cache API by default.',
  }
}

export function transformersUpgradeReadiness(input: TransformersReadinessInput = {}): TransformersUpgradeReadiness {
  const currentVersion = input.currentVersion ?? TRANSFORMERS_RUNTIME_VERSION
  const targetVersion = input.targetVersion ?? TRANSFORMERS_V43_TARGET_VERSION
  const criteria: TransformersUpgradeCriterion[] = [
    {
      id: 'candidate-version',
      label: `Candidate runtime is ${targetVersion} or newer`,
      met: compareSemver(currentVersion, targetVersion) >= 0,
      required: true,
    },
    {
      id: 'registry-apis',
      label: 'ModelRegistry cache and metadata APIs are present',
      met: input.currentRegistryApisVerified ?? true,
      required: true,
    },
    {
      id: 'engine-suite',
      label: 'Kokoro, Supertonic, KittenTTS, and Transformers.js v4 compatibility tests pass under the candidate runtime',
      met: input.candidateEngineSuitePassed ?? false,
      required: true,
    },
  ]

  return {
    currentVersion,
    targetVersion,
    readyToSwitch: criteria.every((criterion) => !criterion.required || criterion.met),
    criteria,
  }
}

async function readWebGpuAdapterInfo(adapter: unknown): Promise<WebGpuAdapterInfo | undefined> {
  const candidate = adapter as WebGpuAdapterLike
  let info = candidate.info
  if ((!info || typeof info !== 'object') && typeof candidate.requestAdapterInfo === 'function') {
    try {
      info = await candidate.requestAdapterInfo()
    } catch {
      info = undefined
    }
  }

  const source: Record<string, unknown> = info && typeof info === 'object' ? info as Record<string, unknown> : candidate as Record<string, unknown>
  const entries: Array<[string, string | number | boolean | null]> = WEBGPU_ADAPTER_INFO_KEYS.flatMap((key) => {
    const value = source[key] ?? (candidate[key] as unknown)
    if (!['string', 'number', 'boolean'].includes(typeof value) && value != null) return []
    return [[key, (typeof value === 'string' ? value.slice(0, 200) : value) as string | number | boolean | null]]
  })
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function createWebGpuAdapterKey(adapterInfo: WebGpuAdapterInfo | undefined): string | undefined {
  if (!adapterInfo) return undefined
  const values = WEBGPU_ADAPTER_INFO_KEYS.map((key) => {
    const value = adapterInfo[key]
    return typeof value === 'string' ? value.trim().toLowerCase() : value == null ? '' : String(value)
  })
  if (!values.some(Boolean)) return undefined
  return WEBGPU_ADAPTER_INFO_KEYS.map((key, index) => `${key}=${values[index]}`).join('|')
}

function normalizeWebGpuDenylist(value: unknown): WebGpuDenylistEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Partial<WebGpuDenylistEntry> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      adapterKey: typeof entry.adapterKey === 'string' ? entry.adapterKey.slice(0, 500) : '',
      ...(entry.adapterInfo && typeof entry.adapterInfo === 'object' ? { adapterInfo: cloneWebGpuAdapterInfo(entry.adapterInfo as WebGpuAdapterInfo) } : {}),
      reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 240) : 'User reported corrupted or unusable WebGPU audio.',
      reportedAt: typeof entry.reportedAt === 'string' ? entry.reportedAt : new Date(0).toISOString(),
    }))
    .filter((entry) => entry.adapterKey.length > 0)
    .slice(0, MAX_WEBGPU_DENYLIST_ENTRIES)
}

function writeWebGpuDenylist(entries: WebGpuDenylistEntry[]): void {
  memoryWebGpuDenylist = cloneWebGpuDenylist(entries)
  try {
    if (typeof window === 'undefined') return
    if (entries.length === 0) window.localStorage.removeItem(WEBGPU_ADAPTER_DENYLIST_STORAGE_KEY)
    else window.localStorage.setItem(WEBGPU_ADAPTER_DENYLIST_STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // The in-memory denylist still protects this session when storage is blocked.
  }
}

function cloneWebGpuDenylist(entries: WebGpuDenylistEntry[]): WebGpuDenylistEntry[] {
  return entries.map((entry) => ({
    ...entry,
    ...(entry.adapterInfo ? { adapterInfo: cloneWebGpuAdapterInfo(entry.adapterInfo) } : {}),
  }))
}

function cloneWebGpuAdapterInfo(info: WebGpuAdapterInfo): WebGpuAdapterInfo {
  const entries: Array<[string, string | number | boolean | null]> = Object.entries(info)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value) || value == null)
    .map(([key, value]) => [key, (typeof value === 'string' ? value.slice(0, 200) : value) as string | number | boolean | null])
  return Object.fromEntries(entries)
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left)
  const b = parseSemver(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

function parseSemver(version: string): [number, number, number] {
  const parts = version.replace(/^[^\d]*/, '').split('.').map((part) => Number.parseInt(part, 10))
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ]
}
