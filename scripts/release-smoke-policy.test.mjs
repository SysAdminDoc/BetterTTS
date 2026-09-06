import { describe, expect, it } from 'vitest'
import modelAssets from '../src/lib/model-assets.json' with { type: 'json' }
import { SHERPA_KOKORO_PACK } from '../electron/sherpa-models.ts'
import { releaseEngineFailures, validateReleaseEngineReports } from './release-smoke-policy.mjs'

function passingReports() {
  return {
    browser: {
      ok: true,
      model: modelAssets.kokoro.modelId,
      revision: modelAssets.kokoro.revision,
      license: 'Apache-2.0',
    },
    packaged: {
      ok: true,
      nativeSynthesis: { ok: true },
      nativeCancellation: {
        ok: true,
        hostRestarted: true,
        reloadKey: 'cpu:q8',
        modelVerified: true,
      },
      nativeLoad: {
        key: 'cpu:q8',
        runtime: {
          modelPack: {
            id: SHERPA_KOKORO_PACK.id,
            modelId: SHERPA_KOKORO_PACK.modelId,
            revision: SHERPA_KOKORO_PACK.revision,
            sourceSha256: SHERPA_KOKORO_PACK.archive.sha256,
            license: SHERPA_KOKORO_PACK.license,
            verified: true,
          },
        },
      },
    },
  }
}

describe('release real-engine policy', () => {
  it('accepts independently pinned browser and native models', () => {
    const { browser, packaged } = passingReports()
    expect(() => validateReleaseEngineReports(browser, packaged)).not.toThrow()
  })

  it('rejects a browser revision copied from the different native model', () => {
    const { browser, packaged } = passingReports()
    browser.revision = SHERPA_KOKORO_PACK.revision
    expect(releaseEngineFailures(browser, packaged)).toContain('browser model revision does not match the pinned manifest')
  })

  it('rejects an unverified or drifted native model pack', () => {
    const { browser, packaged } = passingReports()
    packaged.nativeLoad.runtime.modelPack.revision = modelAssets.kokoro.revision
    packaged.nativeLoad.runtime.modelPack.verified = false
    expect(releaseEngineFailures(browser, packaged)).toEqual(expect.arrayContaining([
      'native model revision does not match the pinned Sherpa pack',
      'native model pack was not verified',
    ]))
  })

  it('rejects cancellation that did not restart and verify the recovered host', () => {
    const { browser, packaged } = passingReports()
    packaged.nativeCancellation.hostRestarted = false
    packaged.nativeCancellation.modelVerified = false
    expect(releaseEngineFailures(browser, packaged)).toEqual(expect.arrayContaining([
      'packaged native cancellation did not restart the utility host',
      'packaged native cancellation did not recover with a verified model',
    ]))
  })
})
