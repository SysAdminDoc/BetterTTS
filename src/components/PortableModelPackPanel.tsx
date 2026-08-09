import { Check, Download, Info, Loader2, RefreshCw, Upload, X } from 'lucide-react'
import { useRef, useState, type ChangeEvent } from 'react'
import { formatBytes } from '../lib/text.ts'
import type { ModelCacheSummary } from '../lib/model-cache-types.ts'
import type { PortableOfflinePackManifest, PortableOfflinePackStatus } from '../lib/offline-model-pack.ts'

type PanelToast = {
  tone: 'ok' | 'warn' | 'error'
  message: string
}

export type PortableModelPackPanelProps = {
  selectedVoice: { id: string; name: string }
  modelCache: ModelCacheSummary | null
  isGenerating: boolean
  refreshModelCacheStatus: () => Promise<unknown>
  refreshStorageEstimate: () => void
  showToast: (toast: PanelToast) => void
}

const loadOfflineModelPack = () => import('../lib/offline-model-pack.ts')

export function PortableModelPackPanel({
  selectedVoice,
  modelCache,
  isGenerating,
  refreshModelCacheStatus,
  refreshStorageEstimate,
  showToast,
}: PortableModelPackPanelProps) {
  const [statuses, setStatuses] = useState<PortableOfflinePackStatus[]>([])
  const [action, setAction] = useState<'inspect' | 'import' | 'repair' | 'export' | 'refresh' | null>(null)
  const [licenseConfirmed, setLicenseConfirmed] = useState(false)
  const [preview, setPreview] = useState<{ file: File; manifest: PortableOfflinePackManifest; totalBytes: number } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  async function refreshStatuses() {
    setAction('refresh')
    try {
      const { readPortableOfflinePackStatuses } = await loadOfflineModelPack()
      setStatuses(await readPortableOfflinePackStatuses())
    } finally {
      setAction(null)
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setAction('inspect')
    try {
      const { inspectPortableOfflineModelPack } = await loadOfflineModelPack()
      const archive = await inspectPortableOfflineModelPack(file)
      setPreview({ file, manifest: archive.manifest, totalBytes: archive.totalBytes })
      setLicenseConfirmed(false)
      showToast({ tone: 'ok', message: `Verified ${archive.manifest.engineId} pack metadata and ${archive.assets.length} asset${archive.assets.length === 1 ? '' : 's'}. Confirm the license before import.` })
    } catch (err) {
      setPreview(null)
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'Portable model pack inspection failed.' })
    } finally {
      setAction(null)
    }
  }

  async function handleImport() {
    if (!preview) return
    if (!licenseConfirmed) {
      showToast({ tone: 'warn', message: 'Confirm the model license before importing this pack.' })
      return
    }
    setAction('import')
    try {
      const { importPortableOfflineModelPack } = await loadOfflineModelPack()
      const status = await importPortableOfflineModelPack(preview.file, {
        licenseConfirmed: true,
        licenseConfirmedAt: new Date().toISOString(),
      })
      setStatuses((current) => [status, ...current.filter((candidate) => candidate.packId !== status.packId)])
      setPreview(null)
      setLicenseConfirmed(false)
      await refreshModelCacheStatus()
      refreshStorageEstimate()
      showToast({ tone: 'ok', message: `Imported and verified ${status.packId}. It is ready for offline use.` })
    } catch (err) {
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'Portable model pack import failed.' })
    } finally {
      setAction(null)
    }
  }

  async function handleRepair(packId: string) {
    if (isGenerating) return
    setAction('repair')
    try {
      const { repairPortableOfflineModelPack } = await loadOfflineModelPack()
      const status = await repairPortableOfflineModelPack(packId)
      if (status) setStatuses((current) => current.map((candidate) => candidate.packId === packId ? status : candidate))
      showToast({ tone: status?.ready ? 'ok' : 'warn', message: status?.ready ? `Repaired and verified ${packId}.` : `Pack ${packId} remains staged and needs a verified re-import.` })
    } catch (err) {
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'Portable model pack repair failed.' })
    } finally {
      setAction(null)
    }
  }

  async function handleExport() {
    if (isGenerating) return
    if (!licenseConfirmed) {
      showToast({ tone: 'warn', message: 'Confirm the Kokoro model license before exporting a portable pack.' })
      return
    }
    const selectedPack = modelCache?.packs?.find((pack) => pack.voiceId === selectedVoice.id && pack.state === 'committed' && !pack.repairable)
    if (!selectedPack) {
      showToast({ tone: 'warn', message: `Prefetch and verify the Kokoro pack for ${selectedVoice.name} before exporting.` })
      return
    }
    setAction('export')
    try {
      const { exportVerifiedKokoroPack } = await loadOfflineModelPack()
      const exported = await exportVerifiedKokoroPack(selectedVoice.id, {
        licenseConfirmed: true,
        licenseAcknowledgedAt: new Date().toISOString(),
      })
      const url = URL.createObjectURL(new Blob([exported.bytes.slice().buffer as ArrayBuffer], { type: 'application/zip' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${exported.manifest.packId.replace(/[^a-z0-9._-]+/giu, '-')}.bettertts-modelpack.zip`
      anchor.click()
      URL.revokeObjectURL(url)
      setLicenseConfirmed(false)
      showToast({ tone: 'ok', message: `Exported verified ${exported.manifest.packId} (${formatBytes(exported.bytes.byteLength)}).` })
    } catch (err) {
      showToast({ tone: 'error', message: err instanceof Error ? err.message : 'Portable model pack export failed.' })
    } finally {
      setAction(null)
    }
  }

  const exportReady = modelCache?.packs?.some((pack) => pack.voiceId === selectedVoice.id && pack.state === 'committed' && !pack.repairable) ?? false

  return (
    <div className="diagnostics-panel backup-panel" aria-label="Portable offline model pack">
      <div className="cache-manager-head">
        <span>
          <strong>Portable model packs</strong>
          <small>Versioned ZIP export/import for reviewed browser model assets.</small>
          <small>Verification is on demand; unverified cache bytes are never reported as ready.</small>
        </span>
        <button type="button" onClick={() => void refreshStatuses().catch((err) => showToast({ tone: 'error', message: err instanceof Error ? err.message : 'Could not verify portable model packs.' }))} disabled={action !== null}>
          {action === 'refresh' ? <Loader2 size={13} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          Verify packs
        </button>
      </div>
      <input ref={inputRef} type="file" accept=".bettertts-modelpack,.zip,application/zip" hidden onChange={handleFile} />
      {preview ? (
        <div className="capability-strip warn" role="status">
          <Info size={15} aria-hidden="true" />
          <span>
            {preview.manifest.engineId} · {preview.manifest.modelId} · {preview.manifest.license.spdx} · revision {preview.manifest.revision.slice(0, 12)} · {preview.manifest.assets.length} assets · {formatBytes(preview.totalBytes)}
          </span>
        </div>
      ) : null}
      <label className="portable-pack-license">
        <input type="checkbox" checked={licenseConfirmed} onChange={(event) => setLicenseConfirmed(event.target.checked)} disabled={action !== null || isGenerating} />
        I confirm I have the right to use the selected model under its recorded license.
      </label>
      <div className="diagnostics-actions">
        <button type="button" onClick={() => inputRef.current?.click()} disabled={action !== null || isGenerating}>
          {action === 'inspect' ? <Loader2 size={13} aria-hidden="true" /> : <Upload size={13} aria-hidden="true" />}
          Choose pack
        </button>
        {preview ? (
          <>
            <button type="button" onClick={() => void handleImport()} disabled={action !== null || isGenerating || !licenseConfirmed}>
              {action === 'import' ? <Loader2 size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
              Verify & import
            </button>
            <button type="button" onClick={() => { setPreview(null); setLicenseConfirmed(false) }} disabled={action !== null}>
              <X size={13} aria-hidden="true" />
              Cancel
            </button>
          </>
        ) : null}
        <button type="button" onClick={() => void handleExport()} disabled={action !== null || isGenerating || !licenseConfirmed || !exportReady}>
          {action === 'export' ? <Loader2 size={13} aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
          Export selected Kokoro pack
        </button>
      </div>
      {statuses.length > 0 ? (
        <div className="cache-rows">
          {statuses.map((status) => (
            <div className="cache-row" key={status.packId}>
              <span>
                <strong>{status.packId}</strong>
                <small>{status.ready ? 'Ready · verified' : 'Staged · repair needed'} · {status.verifiedAssetCount}/{status.assetCount} assets · {formatBytes(status.totalBytes)} · {status.licenseSpdx}</small>
                {status.error ? <small className="openai-error">{status.error.slice(0, 180)}</small> : null}
              </span>
              {status.repairable ? (
                <button type="button" onClick={() => void handleRepair(status.packId)} disabled={action !== null || isGenerating}>
                  {action === 'repair' ? <Loader2 size={13} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
                  Repair
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <small className="cache-empty">No portable packs verified in this browser yet.</small>
      )}
    </div>
  )
}
