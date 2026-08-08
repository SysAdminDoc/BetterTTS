export const MAX_ARTICLE_IMPORT_BYTES = 2 * 1024 * 1024
export const ARTICLE_IMPORT_TIMEOUT_MS = 15_000
export const ARTICLE_IMPORT_HOP_TIMEOUT_MS = 5_000
export const ARTICLE_IMPORT_MAX_REDIRECTS = 5

export type ArticleImportPolicyCode =
  | 'invalid-url'
  | 'https-required'
  | 'credentials'
  | 'private-destination'
  | 'redirect-uninspectable'
  | 'redirect-limit'

export class ArticleImportPolicyError extends Error {
  readonly code: ArticleImportPolicyCode

  constructor(code: ArticleImportPolicyCode, message: string) {
    super(message)
    this.code = code
    this.name = 'ArticleImportPolicyError'
  }
}

export function formatArticleImportPolicyMessage(error: unknown): string {
  const code = error instanceof ArticleImportPolicyError ? error.code : 'invalid-url'
  return code === 'credentials'
    ? 'Article URLs cannot contain a username or password.'
    : code === 'private-destination'
      ? 'That URL points to a local or private destination. Use a public HTTPS article URL.'
      : code === 'redirect-uninspectable'
        ? 'That page redirected to a destination the browser could not verify. Paste the final HTTPS URL instead.'
        : code === 'redirect-limit'
          ? 'That page redirected too many times. Paste the final HTTPS URL instead.'
          : code === 'https-required'
            ? 'Article imports require a public HTTPS URL.'
            : 'That does not look like a valid HTTPS URL.'
}

const ARTICLE_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/xml',
  'text/xml',
]

const NON_PUBLIC_IPV4_RANGES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 8, 0],
  [10, 8, 0],
  [100, 10, 64],
  [127, 8, 0],
  [169, 16, 254],
  [172, 12, 16],
  [192, 24, 0],
  [192, 24, 2],
  [192, 24, 168],
  [198, 15, 18],
  [198, 24, 51],
  [203, 24, 113],
  [224, 4, 0],
  [240, 4, 0],
]

const NON_PUBLIC_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.home.arpa',
  '.lan',
]

function policyError(code: ArticleImportPolicyCode, message: string): ArticleImportPolicyError {
  return new ArticleImportPolicyError(code, message)
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/u.test(part))) return null
  const numbers = parts.map(Number)
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers as [number, number, number, number] : null
}

function isNonPublicIpv4(hostname: string): boolean {
  const address = parseIpv4(hostname)
  if (!address) return false
  const [first, second, third] = address
  return NON_PUBLIC_IPV4_RANGES.some(([rangeFirst, prefix, rangeThird]) => {
    if (prefix === 4) return first >= rangeFirst && first <= rangeFirst + 15
    if (prefix === 8) return first === rangeFirst
    if (prefix === 10) return first === rangeFirst && second >= rangeThird && second <= rangeThird + 63
    if (prefix === 12) return first === rangeFirst && second >= rangeThird && second <= rangeThird + 15
    if (prefix === 15) return first === rangeFirst && second >= rangeThird && second <= rangeThird + 1
    return first === rangeFirst && second === rangeThird && third !== undefined
  })
}

function parseIpv6(hostname: string): number[] | null {
  let value = hostname
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  const embeddedIpv4 = value.includes('.')
  if (embeddedIpv4) {
    const separator = value.lastIndexOf(':')
    const ipv4 = parseIpv4(value.slice(separator + 1))
    if (separator < 0 || !ipv4) return null
    const [first, second, third, fourth] = ipv4
    value = `${value.slice(0, separator)}:${((first << 8) | second).toString(16)}:${((third << 8) | fourth).toString(16)}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const parseGroup = (group: string) => /^[0-9a-f]{1,4}$/iu.test(group) ? Number.parseInt(group, 16) : null
  const groups = [...left, ...right].map(parseGroup)
  if (groups.some((group) => group === null)) return null
  const missing = 8 - groups.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  return [
    ...left.map((group) => Number.parseInt(group, 16)),
    ...(halves.length === 2 ? Array.from({ length: missing }, () => 0) : []),
    ...right.map((group) => Number.parseInt(group, 16)),
  ]
}

function isNonPublicIpv6(hostname: string): boolean {
  const groups = parseIpv6(hostname)
  if (!groups) return false
  const first = groups[0]
  const allAfterFirstZero = groups.slice(1).every((group) => group === 0)
  if (first === 0 && (allAfterFirstZero || groups[7] === 1)) return true
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true

  const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0 || groups[5] === 0xffff)
  if (ipv4Mapped) {
    const ipv4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`
    return isNonPublicIpv4(ipv4)
  }
  return false
}

function isNonPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/u, '')
  if (!normalized || normalized === 'localhost' || !normalized.includes('.') || NON_PUBLIC_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true
  return isNonPublicIpv4(normalized) || isNonPublicIpv6(normalized)
}

export function normalizeArticleImportUrl(rawUrl: string | URL): URL {
  const raw = String(rawUrl).trim()
  if (!raw || raw.length > 2048) throw policyError('invalid-url', 'Article URL is invalid or too long.')
  const explicitScheme = raw.match(/^([a-z][a-z\d+.-]*):/iu)?.[1]?.toLowerCase()
  if (explicitScheme && explicitScheme !== 'https') throw policyError('https-required', 'Article imports require an HTTPS URL.')

  let target: URL
  try {
    target = new URL(explicitScheme ? raw : `https://${raw}`)
  } catch {
    throw policyError('invalid-url', 'Article URL is invalid.')
  }
  if (target.protocol !== 'https:') throw policyError('https-required', 'Article imports require an HTTPS URL.')
  if (target.username || target.password) throw policyError('credentials', 'Article URLs cannot contain embedded credentials.')
  if (isNonPublicHostname(target.hostname)) throw policyError('private-destination', 'Article destination is local, private, or otherwise not a public hostname.')
  target.hash = ''
  return target
}

export function formatArticleImportDestination(url: URL): string {
  const safe = new URL(url.toString())
  safe.username = ''
  safe.password = ''
  safe.search = ''
  safe.hash = ''
  return safe.toString()
}

export type ArticleFetchResult = {
  response: Response
  finalUrl: URL
  redirectCount: number
}

export async function fetchArticleResponse(
  initialUrl: URL,
  options: {
    fetchImpl?: typeof fetch
    signal?: AbortSignal
    hopTimeoutMs?: number
    maxRedirects?: number
  } = {},
): Promise<ArticleFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const hopTimeoutMs = Math.max(1, options.hopTimeoutMs ?? ARTICLE_IMPORT_HOP_TIMEOUT_MS)
  const maxRedirects = Math.max(0, options.maxRedirects ?? ARTICLE_IMPORT_MAX_REDIRECTS)
  let current = normalizeArticleImportUrl(initialUrl)
  let redirectCount = 0

  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Article import cancelled.', 'AbortError')
    const hopController = new AbortController()
    const abortHop = () => hopController.abort(options.signal?.reason ?? new DOMException('Article import cancelled.', 'AbortError'))
    options.signal?.addEventListener('abort', abortHop, { once: true })
    const timeout = globalThis.setTimeout(() => hopController.abort(new DOMException('Article import timed out.', 'TimeoutError')), hopTimeoutMs)
    let response: Response
    try {
      response = await fetchImpl(current.toString(), {
        credentials: 'omit',
        mode: 'cors',
        redirect: 'manual',
        referrerPolicy: 'no-referrer',
        signal: hopController.signal,
      })
    } finally {
      globalThis.clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abortHop)
    }

    const isRedirect = response.status >= 300 && response.status <= 399
    if (response.type === 'opaqueredirect' || (isRedirect && !response.headers.get('location'))) {
      await response.body?.cancel()
      throw policyError('redirect-uninspectable', 'Article redirect destination could not be inspected safely.')
    }
    if (isRedirect) {
      const location = response.headers.get('location')
      if (!location) throw policyError('redirect-uninspectable', 'Article redirect destination could not be inspected safely.')
      if (redirectCount >= maxRedirects) throw policyError('redirect-limit', 'Article import followed too many redirects.')
      await response.body?.cancel()
      let next: URL
      try {
        next = normalizeArticleImportUrl(new URL(location, current))
      } catch (error) {
        if (error instanceof ArticleImportPolicyError) throw error
        throw policyError('redirect-uninspectable', 'Article redirect destination could not be inspected safely.')
      }
      current = next
      redirectCount += 1
      continue
    }

    let finalUrl: URL
    try {
      finalUrl = normalizeArticleImportUrl(response.url || current)
    } catch {
      throw policyError('redirect-uninspectable', 'Article final destination could not be inspected safely.')
    }
    return { response, finalUrl, redirectCount }
  }
}

export async function readArticleResponseText(response: Response, maxBytes = MAX_ARTICLE_IMPORT_BYTES): Promise<string> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType && !ARTICLE_CONTENT_TYPES.some((allowed) => contentType.includes(allowed))) {
    throw new Error('Unsupported article content type.')
  }

  const contentLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('Article response is too large.')
  }

  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('Article response is too large.')
    return text
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        await reader.cancel()
        throw new Error('Article response is too large.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}
