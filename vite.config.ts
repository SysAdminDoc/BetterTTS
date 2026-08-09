import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import { createLogger, defineConfig, type Logger, type Plugin } from 'vite'

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
    "script-src 'self' 'wasm-unsafe-eval'",
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

// ephone's browser bundle contains a Node-only fallback branch. The branch is
// never entered in a renderer, but its guarded dynamic import still makes
// Vite externalize node:module and emit a misleading browser warning. Keep
// the browser artifact free of that branch without changing the npm package.
function ephoneBrowserPatch(): Plugin {
  return {
    name: 'ephone-browser-patch',
    enforce: 'pre',
    apply: 'build',
    transform(code, id) {
      const normalized = id.replace(/\\/g, '/')
      if (!normalized.includes('/ephone/ephone.js')) return null
      const nodeFallback = /const\{createRequire\}=await import\("node:module"\);var require=createRequire\(import\.meta\.url\)/u
      if (!nodeFallback.test(code)) return null
      return {
        code: code
          .replace(nodeFallback, 'const require = undefined')
          .replace(/import\("node:module"\)/gu, 'Promise.resolve({ createRequire: () => undefined })')
          .replace(/require\("node:[^"]+"\)/gu, 'undefined'),
        map: null,
      }
    },
  }
}

// The Electron desktop build loads the renderer from a custom app:// scheme, so
// it needs relative asset paths and sets its COOP/COEP/CSP headers in the main
// process instead of via the service worker / a build-time <meta> tag.
const isElectron = process.env.BETTERTTS_TARGET === 'electron'

function buildLogger(): Logger {
  const logger = createLogger()
  const warn = logger.warn.bind(logger)
  logger.warn = (message, options) => {
    // Rolldown's timing table is useful interactively but is emitted as a
    // warning after the byte/ownership gates have already run. Keep genuine
    // resolver and build warnings visible.
    if (message.includes('[PLUGIN_TIMINGS]')) return
    warn(message, options)
  }
  return logger
}

export default defineConfig(({ command }) => ({
  base: isElectron ? './' : '/BetterTTS/',
  resolve: {
    alias: {
      'node:module': join(import.meta.dirname, 'src', 'browser-node-module-shim.ts'),
    },
  },
  plugins: isElectron
    ? [react(), ephoneBrowserPatch(), piperPlusBuildPatch()]
    : [react(), swBuildId(), cspInjector(), ephoneBrowserPatch(), piperPlusBuildPatch()],
  build: {
    // The generic warning is below the largest intentionally lazy WASM/model
    // artifact. scripts/check-build-budget.mjs is the stricter ownership and
    // byte gate for this application.
    chunkSizeWarningLimit: 65_000,
  },
  customLogger: command === 'build' ? buildLogger() : undefined,
  worker: {
    format: 'es',
  },
}))
