import type { WebGpuDiagnostics } from '../lib/diagnostics.ts'

type WebGpuDiagnosticsPanelProps = {
  capability: WebGpuDiagnostics | null
  action: 'report' | 'clear' | null
  disabled?: boolean
  onReport: () => void | Promise<void>
  onClear: () => void | Promise<void>
}

export function WebGpuDiagnosticsPanel({ capability, action, disabled = false, onReport, onClear }: WebGpuDiagnosticsPanelProps) {
  const adapterLabel = capability?.adapterInfo
    ? Object.entries(capability.adapterInfo)
      .filter(([, value]) => value != null && String(value).trim().length > 0)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' · ')
    : 'Adapter identity unavailable'
  const status = capability == null
    ? 'Checking WebGPU…'
    : capability.denylisted
      ? 'Blocked by local adapter report'
      : capability.usable
        ? 'Available for Kokoro'
        : capability.status

  return (
    <div className="diagnostics-panel webgpu-diagnostics-panel" aria-label="WebGPU adapter diagnostics">
      <div className="cache-manager-head">
        <span>
          <strong>WebGPU adapter</strong>
          <small>{status}. Adapter details stay local and are included in diagnostics exports.</small>
        </span>
      </div>
      <dl className="diagnostics-facts">
        <div><dt>Status</dt><dd>{status}</dd></div>
        <div><dt>Adapter</dt><dd title={adapterLabel}>{adapterLabel}</dd></div>
      </dl>
      <div className="diagnostics-actions">
        <button
          type="button"
          onClick={() => void onReport()}
          disabled={disabled || action !== null || capability?.adapterAvailable !== true || capability.denylisted}
        >
          {action === 'report' ? 'Recording…' : 'Report bad audio'}
        </button>
        {capability?.denylisted ? (
          <button type="button" onClick={() => void onClear()} disabled={disabled || action !== null}>
            {action === 'clear' ? 'Clearing…' : 'Allow this adapter again'}
          </button>
        ) : <span />}
      </div>
      <small>
        Report an artifact-free failure or corrupted clip to force Kokoro onto WASM q8 for this adapter. Clear the report to retry WebGPU after a browser or driver update.
      </small>
    </div>
  )
}
