import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DESKTOP_INTEGRATIONS,
  desktopIntegrationKey,
  explorerCommand,
  explorerRegistrySubkeys,
  externalFileMime,
  isSupportedExternalFile,
  parseExternalOpenPath,
  sanitizeDesktopIntegrationSettings,
} from './desktop-integrations.ts'

describe('desktop integration contracts', () => {
  it('defaults every OS integration to disabled and sanitizes persisted values', () => {
    expect(sanitizeDesktopIntegrationSettings(null)).toEqual(DEFAULT_DESKTOP_INTEGRATIONS)
    expect(sanitizeDesktopIntegrationSettings({ hotkeyEnabled: true, explorerEnabled: 'yes', ocrEnabled: 1 })).toEqual({
      hotkeyEnabled: true,
      explorerEnabled: false,
      ocrEnabled: false,
    })
    expect(desktopIntegrationKey('hotkey')).toBe('hotkeyEnabled')
    expect(desktopIntegrationKey('explorer')).toBe('explorerEnabled')
    expect(desktopIntegrationKey('ocr')).toBe('ocrEnabled')
  })

  it('accepts only supported external document paths and maps their MIME types', () => {
    expect(isSupportedExternalFile('book.TXT')).toBe(true)
    expect(isSupportedExternalFile('book.epub')).toBe(true)
    expect(isSupportedExternalFile('book.pdf')).toBe(true)
    expect(isSupportedExternalFile('book.docx')).toBe(true)
    expect(isSupportedExternalFile('book.png')).toBe(false)
    expect(externalFileMime('book.epub')).toBe('application/epub+zip')
    expect(externalFileMime('book.pdf')).toBe('application/pdf')
    expect(externalFileMime('book.docx')).toContain('wordprocessingml')
  })

  it('parses Explorer launch arguments without treating switches as paths', () => {
    expect(parseExternalOpenPath(['electron.exe', 'app.asar', '--open', 'C:\\Books\\book.epub'])).toBe('C:\\Books\\book.epub')
    expect(parseExternalOpenPath(['BetterTTS.exe', '--smoke'])).toBeNull()
    expect(parseExternalOpenPath(['BetterTTS.exe', '--open', '--smoke'])).toBeNull()
  })

  it('generates per-user registry commands for packaged and development launches', () => {
    expect(explorerRegistrySubkeys()).toHaveLength(4)
    expect(explorerCommand('C:\\Apps\\BetterTTS.exe', 'C:\\Apps\\resources\\app.asar', true)).toBe('"C:\\Apps\\BetterTTS.exe" --open "%1"')
    expect(explorerCommand('C:\\Node\\electron.exe', 'C:\\Repo\\BetterTTS', false)).toBe('"C:\\Node\\electron.exe" "C:\\Repo\\BetterTTS" --open "%1"')
  })
})
