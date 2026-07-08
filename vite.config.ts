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
    "connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co",
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

export default defineConfig({
  base: '/BetterTTS/',
  plugins: [react(), swBuildId(), cspInjector()],
})
