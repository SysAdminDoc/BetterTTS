import { extname } from 'node:path'

export type DesktopIntegrationKind = 'hotkey' | 'explorer' | 'ocr' | 'tray' | 'notifications'

export type DesktopIntegrationSettings = {
  hotkeyEnabled: boolean
  explorerEnabled: boolean
  ocrEnabled: boolean
  trayEnabled: boolean
  notificationsEnabled: boolean
}

export type DesktopIntegrationStatus = DesktopIntegrationSettings & {
  hotkey: string
  hotkeyRegistered: boolean
  explorerRegistered: boolean
  associationRegistered: boolean
  ocrAvailable: boolean
  trayReady: boolean
  notificationsAvailable: boolean
  renderState: DesktopRenderState
  renderMessage?: string
  renderProgress?: number
  tesseractPath?: string
  lastError?: string
}

export type DesktopRenderState = 'idle' | 'running' | 'complete' | 'error'

export type DesktopRenderStatus = {
  state: DesktopRenderState
  message?: string
  progress?: number
}

export const DESKTOP_INTEGRATION_HOTKEY = 'CommandOrControl+Alt+B'
export const SUPPORTED_EXTERNAL_EXTENSIONS = ['.txt', '.epub', '.pdf', '.docx'] as const
export const MAX_FOLDER_IMPORT_FILES = 100
export const MAX_FOLDER_IMPORT_BYTES = 100 * 1024 * 1024
export const DESKTOP_APPLICATION_NAME = 'BetterTTS.exe'

export const DEFAULT_DESKTOP_INTEGRATIONS: DesktopIntegrationSettings = {
  hotkeyEnabled: false,
  explorerEnabled: false,
  ocrEnabled: false,
  trayEnabled: false,
  notificationsEnabled: false,
}

export function sanitizeDesktopIntegrationSettings(raw: unknown): DesktopIntegrationSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DESKTOP_INTEGRATIONS }
  const candidate = raw as Partial<DesktopIntegrationSettings>
  return {
    hotkeyEnabled: candidate.hotkeyEnabled === true,
    explorerEnabled: candidate.explorerEnabled === true,
    ocrEnabled: candidate.ocrEnabled === true,
    trayEnabled: candidate.trayEnabled === true,
    notificationsEnabled: candidate.notificationsEnabled === true,
  }
}

export function desktopIntegrationKey(kind: DesktopIntegrationKind): keyof DesktopIntegrationSettings {
  if (kind === 'hotkey') return 'hotkeyEnabled'
  if (kind === 'explorer') return 'explorerEnabled'
  if (kind === 'ocr') return 'ocrEnabled'
  return kind === 'tray' ? 'trayEnabled' : 'notificationsEnabled'
}

export function parseExternalOpenPath(argv: readonly string[]): string | null {
  const index = argv.indexOf('--open')
  const value = index >= 0 ? argv[index + 1] : undefined
  return value && !value.startsWith('-') ? value : null
}

export function isSupportedExternalFile(path: string): boolean {
  return SUPPORTED_EXTERNAL_EXTENSIONS.includes(extname(path).toLowerCase() as typeof SUPPORTED_EXTERNAL_EXTENSIONS[number])
}

export function externalFileMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.epub': return 'application/epub+zip'
    case '.pdf': return 'application/pdf'
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    default: return 'text/plain'
  }
}

export function explorerRegistrySubkeys(): string[] {
  return SUPPORTED_EXTERNAL_EXTENSIONS.map((extension) => `HKCU\\Software\\Classes\\SystemFileAssociations\\${extension}\\shell\\BetterTTS`)
}

export function associationProgId(extension: typeof SUPPORTED_EXTERNAL_EXTENSIONS[number]): string {
  return `BetterTTS.Document${extension.slice(1).toUpperCase()}`
}

export function associationRegistrySubkeys(): string[] {
  const applicationRoot = `HKCU\\Software\\Classes\\Applications\\${DESKTOP_APPLICATION_NAME}`
  const keys = [
    applicationRoot,
    `${applicationRoot}\\DefaultIcon`,
    `${applicationRoot}\\shell\\open`,
    `${applicationRoot}\\shell\\open\\command`,
    `${applicationRoot}\\SupportedTypes`,
  ]
  for (const extension of SUPPORTED_EXTERNAL_EXTENSIONS) {
    const progIdRoot = `HKCU\\Software\\Classes\\${associationProgId(extension)}`
    keys.push(
      progIdRoot,
      `${progIdRoot}\\DefaultIcon`,
      `${progIdRoot}\\shell\\open`,
      `${progIdRoot}\\shell\\open\\command`,
    )
  }
  return keys
}

export function associationRegistryValues(): Array<{ key: string; name: string }> {
  const applicationRoot = `HKCU\\Software\\Classes\\Applications\\${DESKTOP_APPLICATION_NAME}`
  return SUPPORTED_EXTERNAL_EXTENSIONS.flatMap((extension) => [
    { key: `${applicationRoot}\\SupportedTypes`, name: extension },
    { key: `HKCU\\Software\\Classes\\${extension}\\OpenWithProgids`, name: associationProgId(extension) },
  ])
}

function quoteWindowsArg(value: string): string {
  return `"${value.replaceAll('"', '\\\"')}"`
}

export function explorerCommand(executablePath: string, appPath: string, packaged: boolean): string {
  return packaged
    ? `${quoteWindowsArg(executablePath)} --open "%1"`
    : `${quoteWindowsArg(executablePath)} ${quoteWindowsArg(appPath)} --open "%1"`
}
