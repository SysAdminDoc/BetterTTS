import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// public/ files are copied verbatim, so the service-worker cache name is
// stamped after the bundle is written; every deploy invalidates the app shell.
function swBuildId(): Plugin {
  return {
    name: 'sw-build-id',
    closeBundle() {
      const swPath = join(import.meta.dirname, 'dist', 'sw.js')
      try {
        writeFileSync(swPath, readFileSync(swPath, 'utf8').replace('__BUILD_ID__', String(Date.now())))
      } catch {
        /* dist/sw.js absent in non-build contexts */
      }
    },
  }
}

// Build-only: the dev server needs Vite's inline preamble scripts, which a
// strict CSP would block. Production output has no inline scripts.
function cspInjector(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self' blob: 'wasm-unsafe-eval'",
    // https: is broad, but article import fetches arbitrary pages; script-src
    // 'self' still blocks the injection an exfiltration attack would need.
    "connect-src 'self' https: blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ')
  return {
    name: 'csp-inject',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`)
    },
  }
}

function piperPlusBuildPatch(): Plugin {
  return {
    name: 'piper-plus-build-patch',
    apply: 'build',
    transform(code, id) {
      const normalized = id.replace(/\\/g, '/')
      if (normalized.endsWith('/piper-plus/src/phonemizer/rust-wasm-adapter.js')) {
        return code.replace("new URL('../../assets/', import.meta.url).href", "'/BetterTTS/piper-plus-dicts/'")
      }
      if (normalized.endsWith('/piper-plus/src/index.js')) {
        return code.replace(
          'wasmLoader: options.wasmLoader,',
          'wasmLoader: options.wasmLoader,\n              zhDictBaseUrl: options.zhDictBaseUrl,',
        )
      }
      return null
    },
  }
}

// The Electron desktop build loads the renderer from a custom app:// scheme, so
// it needs relative asset paths and sets its COOP/COEP/CSP headers in the main
// process instead of via the service worker / a build-time <meta> tag.
const isElectron = process.env.BETTERTTS_TARGET === 'electron'

export default defineConfig({
  base: isElectron ? './' : '/BetterTTS/',
  plugins: isElectron
    ? [react(), piperPlusBuildPatch()]
    : [react(), swBuildId(), cspInjector(), piperPlusBuildPatch()],
  worker: {
    format: 'es',
  },
})
