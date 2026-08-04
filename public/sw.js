const CACHE_NAME = 'bettertts-shell-__BUILD_ID__'

// credentialless keeps SharedArrayBuffer available even if a model CDN stops
// sending CORP/CORS headers; engines without it (Safari, older Firefox) keep
// require-corp, which HuggingFace's CORS headers satisfy today.
const COEP_VALUE = /Chrome\//.test(self.navigator.userAgent) ? 'credentialless' : 'require-corp'

function createShellCacheRequest(request) {
  const url = new URL(request.url)
  if (request.method !== 'GET') return null
  if (url.origin !== self.location.origin) return null
  if (url.pathname.includes('/api/') || url.pathname.includes('/models/')) return null

  url.search = ''
  url.hash = ''
  return new Request(url.toString(), {
    method: 'GET',
    headers: request.headers,
    credentials: request.credentials,
    cache: request.cache,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    integrity: request.integrity,
  })
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // Replacement workers stay waiting until the current page reloads. At
    // activation there are no clients using the previous worker, so stale
    // generations can be removed without breaking old hashed lazy chunks.
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('bettertts-shell-') && k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  if (event.request.method !== 'GET') return
  if (url.pathname.includes('/api/')) return
  const cacheRequest = createShellCacheRequest(event.request)

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // After a deploy, old hashed assets 404 on Pages — serve the cached
        // copy (if any survives) instead of breaking an already-open tab.
        if (cacheRequest && (response.status === 404 || response.status === 410)) {
          return caches.match(cacheRequest).then((hit) => hit ?? response)
        }
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

        if (cacheRequest && response.type === 'basic') {
          const copy = enhanced.clone()
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(cacheRequest, copy))
            .catch(() => {})
        }

        return enhanced
      })
      .catch(() => caches.match(cacheRequest ?? event.request))
  )
})
