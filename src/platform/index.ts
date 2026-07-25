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
}

export type DesktopProjectBridge = {
  save: (bytes: Uint8Array, suggestedName: string, saveAs?: boolean) => Promise<DesktopProjectResult>
  open: () => Promise<DesktopProjectResult>
  forget: () => Promise<DesktopProjectResult>
}

export type DesktopBridge = {
  isDesktop: true
  kind: 'desktop'
  versions: { electron: string; chrome: string; node: string }
  nativeTts?: NativeTtsBridge
  updater?: DesktopUpdaterBridge
  projects?: DesktopProjectBridge
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
