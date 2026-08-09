import type { ChangeEvent } from 'react'

export type LongFormQualityControlProps = {
  enabled: boolean
  disabled: boolean
  onChange: (enabled: boolean) => void
}

export function LongFormQualityControl({ enabled, disabled, onChange }: LongFormQualityControlProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)
  return (
    <label className="toggle-row">
      <input id="quality-checks" type="checkbox" checked={enabled} disabled={disabled} onChange={handleChange} />
      <span>
        Long-form quality checks
        <small>Run local waveform, duration, cue, clipping, and repeated-tail checks with one bounded retry. Desktop Whisper alignment is used when available.</small>
      </span>
    </label>
  )
}
