import { extname } from 'node:path'

export type DesktopIntegrationKind = 'hotkey' | 'explorer' | 'ocr'

export type DesktopIntegrationSettings = {
  hotkeyEnabled: boolean
  explorerEnabled: boolean
  ocrEnabled: boolean
}

export type DesktopIntegrationStatus = DesktopIntegrationSettings & {
  hotkey: string
  hotkeyRegistered: boolean
  explorerRegistered: boolean
  ocrAvailable: boolean
  tesseractPath?: string
  lastError?: string
}

export const DESKTOP_INTEGRATION_HOTKEY = 'CommandOrControl+Alt+B'
export const SUPPORTED_EXTERNAL_EXTENSIONS = ['.txt', '.epub', '.pdf', '.docx'] as const

export const DEFAULT_DESKTOP_INTEGRATIONS: DesktopIntegrationSettings = {
  hotkeyEnabled: false,
  explorerEnabled: false,
  ocrEnabled: false,
}

export function sanitizeDesktopIntegrationSettings(raw: unknown): DesktopIntegrationSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DESKTOP_INTEGRATIONS }
  const candidate = raw as Partial<DesktopIntegrationSettings>
  return {
    hotkeyEnabled: candidate.hotkeyEnabled === true,
    explorerEnabled: candidate.explorerEnabled === true,
    ocrEnabled: candidate.ocrEnabled === true,
  }
}

export function desktopIntegrationKey(kind: DesktopIntegrationKind): keyof DesktopIntegrationSettings {
  return kind === 'hotkey' ? 'hotkeyEnabled' : kind === 'explorer' ? 'explorerEnabled' : 'ocrEnabled'
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

function quoteWindowsArg(value: string): string {
  return `"${value.replaceAll('"', '\\\"')}"`
}

export function explorerCommand(executablePath: string, appPath: string, packaged: boolean): string {
  return packaged
    ? `${quoteWindowsArg(executablePath)} --open "%1"`
    : `${quoteWindowsArg(executablePath)} ${quoteWindowsArg(appPath)} --open "%1"`
}
