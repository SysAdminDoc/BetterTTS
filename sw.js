const CACHE_NAME = 'bettertts-shell-1788721656012'
const SHARE_TARGET_CACHE_NAME = 'bettertts-share-target-v1'
const SHARE_TARGET_SCHEMA_VERSION = 1
const SHARE_TARGET_TTL_MS = 10 * 60 * 1000
const MAX_SHARE_TARGET_FILE_BYTES = 25 * 1024 * 1024
const MAX_SHARE_TARGET_TEXT_CHARS = 100000
const MAX_SHARE_TARGET_URL_CHARS = 2048
const MAX_SHARE_TARGET_TITLE_CHARS = 200
const SHARE_TARGET_FILE_EXTENSIONS = new Set(['.txt', '.epub', '.pdf', '.docx'])
const SHARE_TARGET_FILE_TYPES = new Set([
  'text/plain',
  'application/epub+zip',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])
const SHARE_TARGET_CACHE_PREFIX = 'https://bettertts.invalid/__bettertts_share_target__/'

// credentialless keeps SharedArrayBuffer available even if a model CDN stops
// sending CORP/CORS headers; engines without it (Safari, older Firefox) keep
// require-corp, which HuggingFace's CORS headers satisfy today.
const COEP_VALUE = /Chrome\//.test(self.navigator.userAgent) ? 'credentialless' : 'require-corp'

function shareTargetRequest(token, part) {
  return new Request(`${SHARE_TARGET_CACHE_PREFIX}${encodeURIComponent(token)}/${part}`)
}

function shareTargetFileExtension(name) {
  const normalized = String(name ?? '').trim().toLowerCase()
  const index = normalized.lastIndexOf('.')
  return index >= 0 ? normalized.slice(index) : ''
}

function isSupportedShareTargetFile(name, type) {
  const normalizedType = String(type ?? '').split(';', 1)[0].trim().toLowerCase()
  return SHARE_TARGET_FILE_EXTENSIONS.has(shareTargetFileExtension(name)) || SHARE_TARGET_FILE_TYPES.has(normalizedType)
}

function shareTargetToken() {
  if (self.crypto?.randomUUID) return self.crypto.randomUUID()
  const values = new Uint32Array(4)
  self.crypto?.getRandomValues?.(values)
  const entropy = Array.from(values, (value) => value.toString(36)).join('-')
  return `${Date.now().toString(36)}-${entropy}-${Math.random().toString(36).slice(2)}`.slice(0, 64)
}

function shareTargetActionUrl(requestUrl) {
  const target = new URL('./', requestUrl)
  target.search = ''
  target.hash = ''
  return target
}

function shareTargetErrorResponse(requestUrl, code) {
  const target = shareTargetActionUrl(requestUrl)
  target.searchParams.set('share-error', code)
  return new Response(null, {
    status: 303,
    headers: {
      Location: target.toString(),
      'Cache-Control': 'no-store',
    },
  })
}

function shareTargetMetadataResponse(metadata) {
  return new Response(JSON.stringify(metadata), {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    },
  })
}

function isShareTargetFile(value) {
  return Boolean(value && typeof value === 'object' && typeof value.name === 'string' && typeof value.type === 'string' && typeof value.size === 'number' && typeof value.arrayBuffer === 'function')
}

async function handleShareTargetPost(request) {
  let form
  try {
    form = await request.formData()
  } catch {
    return shareTargetErrorResponse(request.url, 'unsupported')
  }

  const titleValue = form.get('title')
  const textValue = form.get('text')
  const urlValue = form.get('url')
  const files = form.getAll('files').filter(isShareTargetFile)
  const title = typeof titleValue === 'string' ? titleValue.slice(0, MAX_SHARE_TARGET_TITLE_CHARS) : ''
  const text = typeof textValue === 'string' ? textValue : ''
  const sharedUrl = typeof urlValue === 'string' ? urlValue : ''
  if (files.length > 1 || text.length > MAX_SHARE_TARGET_TEXT_CHARS || sharedUrl.length > MAX_SHARE_TARGET_URL_CHARS) {
    return shareTargetErrorResponse(request.url, 'invalid')
  }
  const file = files[0]
  if (!title && !text.trim() && !sharedUrl.trim() && !file) return shareTargetErrorResponse(request.url, 'empty')
  if (file && (!file.name || file.name.length > 255 || !isSupportedShareTargetFile(file.name, file.type) || file.size <= 0 || file.size > MAX_SHARE_TARGET_FILE_BYTES)) {
    return shareTargetErrorResponse(request.url, 'invalid')
  }

  const token = shareTargetToken()
  const createdAt = Date.now()
  const metadata = {
    schemaVersion: SHARE_TARGET_SCHEMA_VERSION,
    token,
    createdAt,
    ...(title ? { title } : {}),
    ...(text ? { text } : {}),
    ...(sharedUrl ? { url: sharedUrl } : {}),
    ...(file ? { file: { name: file.name, type: file.type, size: file.size } } : {}),
  }
  try {
    const cache = await caches.open(SHARE_TARGET_CACHE_NAME)
    if (file) {
      await cache.put(
        shareTargetRequest(token, 'file'),
        new Response(await file.arrayBuffer(), {
          headers: {
            'Cache-Control': 'no-store',
            'Content-Type': file.type || 'application/octet-stream',
          },
        }),
      )
    }
    await cache.put(shareTargetRequest(token, 'metadata'), shareTargetMetadataResponse(metadata))
  } catch {
    return shareTargetErrorResponse(request.url, 'storage')
  }

  const target = shareTargetActionUrl(request.url)
  target.searchParams.set('share', token)
  return new Response(null, {
    status: 303,
    headers: {
      Location: target.toString(),
      'Cache-Control': 'no-store',
    },
  })
}

async function cleanupExpiredShareTargets() {
  try {
    const cache = await caches.open(SHARE_TARGET_CACHE_NAME)
    const requests = await cache.keys()
    await Promise.all(requests.filter((request) => request.url.endsWith('/metadata')).map(async (request) => {
      const response = await cache.match(request)
      const metadata = response ? await response.json().catch(() => null) : null
      if (!metadata || !Number.isSafeInteger(metadata.createdAt) || Date.now() - metadata.createdAt > SHARE_TARGET_TTL_MS) {
        await cache.delete(request)
        const token = request.url.split('/').slice(-2, -1)[0]
        if (token) await cache.delete(shareTargetRequest(decodeURIComponent(token), 'file'))
      }
    }))
  } catch {
    // Share handoff is optional; a storage failure must not block shell startup.
  }
}

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
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('bettertts-shell-') && k !== CACHE_NAME).map((k) => caches.delete(k)))
      ),
      cleanupExpiredShareTargets(),
    ])
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  if (event.request.method === 'POST') {
    if (url.origin !== self.location.origin || url.pathname !== shareTargetActionUrl(url).pathname) return
    event.respondWith(handleShareTargetPost(event.request))
    return
  }
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
