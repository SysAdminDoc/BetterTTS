import modelAssets from '../src/lib/model-assets.json' with { type: 'json' }
import { SHERPA_KOKORO_PACK } from '../electron/sherpa-models.ts'

export function releaseEngineFailures(browserReport, packagedReport) {
  const failures = []
  const modelPack = packagedReport?.nativeLoad?.runtime?.modelPack
  const cancellation = packagedReport?.nativeCancellation

  if (browserReport?.ok !== true) failures.push('browser real-engine check did not pass')
  if (browserReport?.model !== modelAssets.kokoro.modelId) failures.push('browser model identity does not match the pinned manifest')
  if (browserReport?.revision !== modelAssets.kokoro.revision) failures.push('browser model revision does not match the pinned manifest')
  if (browserReport?.license !== 'Apache-2.0') failures.push('browser model license is not Apache-2.0')

  if (packagedReport?.ok !== true) failures.push('packaged smoke check did not pass')
  if (packagedReport?.nativeSynthesis?.ok !== true) failures.push('packaged native synthesis did not pass')
  if (cancellation?.ok !== true) failures.push('packaged native cancellation did not pass')
  if (cancellation?.hostRestarted !== true) failures.push('packaged native cancellation did not restart the utility host')
  if (cancellation?.reloadKey !== packagedReport?.nativeLoad?.key) failures.push('packaged native cancellation did not reload the selected model')
  if (cancellation?.modelVerified !== true) failures.push('packaged native cancellation did not recover with a verified model')
  if (modelPack?.id !== SHERPA_KOKORO_PACK.id || modelPack?.modelId !== SHERPA_KOKORO_PACK.modelId) {
    failures.push('native model identity does not match the pinned Sherpa pack')
  }
  if (modelPack?.revision !== SHERPA_KOKORO_PACK.revision) failures.push('native model revision does not match the pinned Sherpa pack')
  if (modelPack?.sourceSha256 !== SHERPA_KOKORO_PACK.archive.sha256) failures.push('native model digest does not match the pinned Sherpa pack')
  if (modelPack?.license?.spdx !== SHERPA_KOKORO_PACK.license.spdx || modelPack?.license?.tier !== 'permissive') {
    failures.push('native model license does not match the permissive Sherpa pack policy')
  }
  if (modelPack?.verified !== true) failures.push('native model pack was not verified')

  return failures
}

export function validateReleaseEngineReports(browserReport, packagedReport) {
  const failures = releaseEngineFailures(browserReport, packagedReport)
  if (failures.length > 0) throw new Error(`Packaged real-engine verification failed:\n- ${failures.join('\n- ')}`)
}
