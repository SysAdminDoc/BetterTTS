// Platform abstraction seam. The web build resolves everything to browser APIs;
// the Electron desktop build injects `window.betterttsPlatform` via its preload
// and, in later phases, will route synthesis/export/storage to native backends.
// Keeping this indirection in one module lets `App.tsx` stay platform-agnostic.

export type PlatformKind = 'web' | 'desktop'

export type NativeTtsBridge = {
  post: (message: unknown) => void
  onMessage: (listener: (message: unknown) => void) => () => void
}

export type DesktopUpdateStatus = {
  state: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  percent?: number
  message?: string
  manual?: boolean
}

export type DesktopUpdaterBridge = {
  check: () => void
  download: () => void
  install: () => void
  onStatus: (listener: (status: DesktopUpdateStatus) => void) => () => void
}

export type DesktopProjectResult = {
  canceled: boolean
  name?: string
  bytes?: Uint8Array
  conflictResolution?: 'reload' | 'save-copy' | 'overwrite' | 'cancel'
}

export type DesktopProjectBridge = {
  save: (bytes: Uint8Array, suggestedName: string, saveAs?: boolean) => Promise<DesktopProjectResult>
  open: () => Promise<DesktopProjectResult>
  forget: () => Promise<DesktopProjectResult>
}

export type NativeAudioFormat = 'wav' | 'mp3' | 'opus' | 'flac' | 'm4b'

export type DesktopFfmpegBridge = {
  status: () => Promise<{ available: boolean; version?: string; message?: string }>
  transcode: (request: {
    samples: Float32Array
    sampleRate: number
    format: NativeAudioFormat
    bitrate: number
    title: string
    loudnessTarget?: number
  }) => Promise<{ bytes: Uint8Array; extension: string; mime: string }>
  audiobook: (request: {
    chunks: Array<{ bytes: Uint8Array; title: string }>
    title: string
    bitrate: number
    loudnessTarget?: number
    cover?: { bytes: Uint8Array }
  }) => Promise<{ bytes: Uint8Array; extension: '.m4b'; mime: 'audio/mp4'; chapterCount: number }>
}

export type WhisperBridge = {
  post: (message: unknown) => void
  onMessage: (listener: (message: unknown) => void) => () => void
}

export type SidecarBridge = {
  post: (message: unknown) => void
  onMessage: (listener: (message: unknown) => void) => () => void
}

export type ByoWeightsBridge = {
  choose: (modelId: string) => Promise<{
    canceled: boolean
    path?: string
    name?: string
    kind?: 'file' | 'directory'
  }>
}

export type OpenAiTtsServerStatus = {
  running: boolean
  host: '127.0.0.1'
  port: number | null
  endpoint: string | null
  models: string[]
  lastError?: string
}

export type OpenAiTtsServerBridge = {
  status: () => Promise<OpenAiTtsServerStatus>
  start: (port: number) => Promise<OpenAiTtsServerStatus>
  stop: () => Promise<OpenAiTtsServerStatus>
}

export type DesktopBridge = {
  isDesktop: true
  kind: 'desktop'
  versions: { electron: string; chrome: string; node: string }
  nativeTts?: NativeTtsBridge
  updater?: DesktopUpdaterBridge
  projects?: DesktopProjectBridge
  ffmpeg?: DesktopFfmpegBridge
  whisper?: WhisperBridge
  sidecar?: SidecarBridge
  byoWeights?: ByoWeightsBridge
  openAiServer?: OpenAiTtsServerBridge
}

declare global {
  interface Window {
    betterttsPlatform?: DesktopBridge
  }
}

export type PlatformInfo = {
  isDesktop: boolean
  kind: PlatformKind
  versions?: DesktopBridge['versions']
}

export function getPlatform(): PlatformInfo {
  if (typeof window !== 'undefined' && window.betterttsPlatform?.isDesktop) {
    return { isDesktop: true, kind: 'desktop', versions: window.betterttsPlatform.versions }
  }
  return { isDesktop: false, kind: 'web' }
}

export function isDesktop(): boolean {
  return getPlatform().isDesktop
}

export function getNativeTtsBridge(): NativeTtsBridge | null {
  if (typeof window === 'undefined') return null
  return window.betterttsPlatform?.nativeTts ?? null
}

export function getDesktopUpdaterBridge(): DesktopUpdaterBridge | null {
  if (typeof window === 'undefined') return null
  return window.betterttsPlatform?.updater ?? null
}

export function getDesktopProjectBridge(): DesktopProjectBridge | null {
  if (typeof window === 'undefined') return null
  return window.betterttsPlatform?.projects ?? null
}

export function getDesktopFfmpegBridge(): DesktopFfmpegBridge | null {
  if (typeof window === 'undefined') return null
  return window.betterttsPlatform?.ffmpeg ?? null
}

export function getWhisperBridge(): WhisperBridge | null {
  if (typeof window === 'undefined') return null
  return window.betterttsPlatform?.whisper ?? null
}

export function getSidecarBridge(): SidecarBridge | null {
  if (typeof window === 'undefined') return null
  return window.betterttsPlatform?.sidecar ?? null
}

export function getByoWeightsBridge(): ByoWeightsBridge | null {
  if (typeof window === 'undefined') return null
  return window.betterttsPlatform?.byoWeights ?? null
}

export function getOpenAiTtsServerBridge(): OpenAiTtsServerBridge | null {
  if (typeof window === 'undefined') return null
  return window.betterttsPlatform?.openAiServer ?? null
}
