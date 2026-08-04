import { FilePlus2, FileText, Loader2 } from 'lucide-react'
import type { DesktopIntegrationKind, DesktopIntegrationStatus } from './platform/index.ts'

export type DesktopIntegrationPanelAction = DesktopIntegrationKind | 'folder' | null

type Props = {
  status: DesktopIntegrationStatus
  action: DesktopIntegrationPanelAction
  onToggle: (kind: DesktopIntegrationKind, enabled: boolean) => void
  onFolder: () => void
  onOcr: () => void
  labelError: (message: string, max: number) => string
}

export default function DesktopIntegrationsPanel({ status, action, onToggle, onFolder, onOcr, labelError }: Props) {
  return (
    <div className="diagnostics-panel desktop-integrations-panel" aria-label="Desktop workflow integrations">
      <div className="cache-manager-head">
        <span>
          <strong>Desktop workflow integrations</strong>
          <small>Windows-only helpers; each is opt-in.</small>
        </span>
        <span className={`openai-status ${status.renderState === 'running' ? 'running' : ''}`} role="status">
          <span className="status-dot" aria-hidden="true" />
          {status.renderState === 'running' ? 'Rendering' : 'Ready'}
        </span>
      </div>
      <label className="toggle-row" htmlFor="desktop-read-selection-hotkey" aria-label="Read copied selection with a global hotkey">
        <input id="desktop-read-selection-hotkey" type="checkbox" checked={status.hotkeyEnabled} disabled={action !== null} onChange={(event) => onToggle('hotkey', event.target.checked)} />
        <span>
          <strong>Read copied selection with a global hotkey</strong>
          <small>{status.hotkey} · {status.hotkeyRegistered ? 'Registered' : status.hotkeyEnabled ? 'Not registered' : 'Disabled'}. Copy first; no input is injected.</small>
        </span>
      </label>
      <label className="toggle-row" htmlFor="desktop-explorer-menu" aria-label="Explorer Convert to audiobook menu">
        <input id="desktop-explorer-menu" type="checkbox" checked={status.explorerEnabled} disabled={action !== null} onChange={(event) => onToggle('explorer', event.target.checked)} />
        <span>
          <strong>Explorer menu + file associations</strong>
          <small>TXT, EPUB, PDF, DOCX · {status.explorerRegistered ? 'Registered' : status.explorerEnabled ? 'Not registered' : 'Disabled'}{status.associationRegistered ? ' · Open with ready' : ''}.</small>
        </span>
      </label>
      <label className="toggle-row" htmlFor="desktop-screen-ocr" aria-label="Screen OCR with Tesseract">
        <input id="desktop-screen-ocr" type="checkbox" checked={status.ocrEnabled} disabled={action !== null} onChange={(event) => onToggle('ocr', event.target.checked)} />
        <span>
          <strong>Screen OCR with Tesseract</strong>
          <small>{status.ocrAvailable ? 'Tesseract is available; capture runs only when requested.' : 'Install Tesseract OCR or set BETTERTTS_TESSERACT_PATH.'}</small>
        </span>
      </label>
      <label className="toggle-row" htmlFor="desktop-tray-status" aria-label="Show render status in the tray">
        <input id="desktop-tray-status" type="checkbox" checked={status.trayEnabled} disabled={action !== null} onChange={(event) => onToggle('tray', event.target.checked)} />
        <span>
          <strong>Render status in tray</strong>
          <small>{status.trayReady ? 'Tray is active.' : 'Keep the app available from the Windows tray.'}</small>
        </span>
      </label>
      <label className="toggle-row" htmlFor="desktop-render-notifications" aria-label="Notify when renders finish">
        <input id="desktop-render-notifications" type="checkbox" checked={status.notificationsEnabled} disabled={action !== null || !status.notificationsAvailable} onChange={(event) => onToggle('notifications', event.target.checked)} />
        <span>
          <strong>Render completion notifications</strong>
          <small>{status.notificationsAvailable ? 'Notify after an active render completes or fails.' : 'Notifications are unavailable in this session.'}</small>
        </span>
      </label>
      <div className="diagnostics-actions">
        <button type="button" onClick={onFolder} disabled={action !== null}>
          <FilePlus2 size={13} aria-hidden="true" />
          {action === 'folder' ? 'Importing folder…' : 'Import folder'}
        </button>
        <button type="button" onClick={onOcr} disabled={!status.ocrEnabled || !status.ocrAvailable || action !== null}>
          {action === 'ocr' ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}
          {action === 'ocr' ? 'Reading screen…' : 'OCR screen to script'}
        </button>
      </div>
      {status.lastError ? <small className="openai-error">{labelError(status.lastError, 220)}</small> : null}
    </div>
  )
}
