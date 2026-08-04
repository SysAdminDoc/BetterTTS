import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App, { ErrorBoundary } from './App.tsx'
import { isDesktop } from './platform/index.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

// The desktop shell serves its own already-isolated origin with native storage,
// so the service worker (app-shell cache + COOP/COEP injection + reload dance)
// is web-only.
if (!isDesktop() && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    .then((reg) => {
      reg.addEventListener('updatefound', () => {
        if (!window.crossOriginIsolated) {
          reloadOnceForIsolation()
        } else {
          // Already isolated: a new build is installing. Tell the app instead
          // of yanking the page out from under the user.
          const worker = reg.installing
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              window.dispatchEvent(new CustomEvent('bettertts-update-ready'))
            }
          })
        }
      })
      // A first install can still be waiting when register() resolves. Reload
      // once for either state so the worker can become active and inject the
      // cross-origin isolation headers before the app starts using WASM.
      if ((reg.active || reg.waiting) && !navigator.serviceWorker.controller && !window.crossOriginIsolated) {
        reloadOnceForIsolation()
      }
    })
    .catch(() => {})
}

// The first visit needs one reload so the SW can inject COOP/COEP headers;
// a session flag stops that from ever looping.
function reloadOnceForIsolation() {
  try {
    if (window.sessionStorage.getItem('bettertts-isolation-reload') === '1') return
    window.sessionStorage.setItem('bettertts-isolation-reload', '1')
  } catch {
    /* storage blocked — reload anyway, worst case the old single-reload behavior */
  }
  window.location.reload()
}
