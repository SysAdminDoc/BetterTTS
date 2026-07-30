import { extname, join, normalize, sep } from 'node:path'

export type RendererRequestResolution = {
  filePath: string
  allowSpaFallback: boolean
}

export function resolveRendererRequest(
  rootDirectory: string,
  requestUrl: string,
  acceptHeader = '',
): RendererRequestResolution | null {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname)
  } catch {
    return null
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html'
  const root = normalize(rootDirectory)
  const filePath = normalize(join(root, `.${pathname}`))
  if (filePath !== root && !filePath.startsWith(root + sep)) return null
  const extension = extname(filePath).toLowerCase()
  return {
    filePath,
    allowSpaFallback: acceptHeader.toLowerCase().includes('text/html') && (extension === '' || extension === '.html'),
  }
}
