import { getKokoroWebGpuDtype, resetKokoroSession, setKokoroWebGpuDtype } from '../lib/kokoro.ts'
import { resetWorker } from '../lib/kokoro-worker.ts'

type KokoroWebGpuDtypeControlProps = {
  disabled: boolean
}

export function KokoroWebGpuDtypeControl({ disabled }: KokoroWebGpuDtypeControlProps) {
  return (
    <label className="toggle-row">
      <input
        type="checkbox"
        defaultChecked={getKokoroWebGpuDtype() === 'fp16'}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.checked ? 'fp16' : 'fp32'
          setKokoroWebGpuDtype(next)
          resetKokoroSession()
          resetWorker()
        }}
      />
      <span>
        WebGPU fp16 (experimental)
        <small>Opt in after benchmarking; fp32 remains the default and CPU fallback stays available.</small>
      </span>
    </label>
  )
}
