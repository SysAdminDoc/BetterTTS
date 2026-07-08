const CACHE_NAME = 'bettertts-shell-__BUILD_ID__'

// credentialless keeps SharedArrayBuffer available even if a model CDN stops
// sending CORP/CORS headers; engines without it (Safari, older Firefox) keep
// require-corp, which HuggingFace's CORS headers satisfy today.
const COEP_VALUE = /Chrome\//.test(self.navigator.userAgent) ? 'credentialless' : 'require-corp'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('bettertts-shell-') && k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  if (event.request.method !== 'GET') return
  if (url.pathname.includes('/api/')) return

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (!response.ok || response.type === 'opaque') return response

        const headers = new Headers(response.headers)
        headers.set('Cross-Origin-Embedder-Policy', COEP_VALUE)
        headers.set('Cross-Origin-Opener-Policy', 'same-origin')
        headers.set('Cross-Origin-Resource-Policy', 'cross-origin')

        const enhanced = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })

        if (url.origin === self.location.origin && response.type === 'basic') {
          const copy = enhanced.clone()
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy))
            .catch(() => {})
        }

        return enhanced
      })
      .catch(() => caches.match(event.request))
  )
})
