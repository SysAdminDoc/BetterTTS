import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveRendererRequest } from './app-protocol.ts'

describe('desktop app protocol routing', () => {
  const root = join('C:', 'app', 'dist')

  it('contains decoded paths inside the renderer root', () => {
    expect(resolveRendererRequest(root, 'app://bettertts/assets/app.js', 'text/javascript')?.filePath)
      .toBe(join(root, 'assets', 'app.js'))
    expect(resolveRendererRequest(root, 'app://bettertts/%2e%2e%2fsecret.txt', 'text/plain')).toBeNull()
    expect(resolveRendererRequest(root, 'app://bettertts/%E0%A4%A', 'text/html')).toBeNull()
  })

  it('allows SPA fallback only for HTML navigation requests', () => {
    expect(resolveRendererRequest(root, 'app://bettertts/library', 'text/html')?.allowSpaFallback).toBe(true)
    expect(resolveRendererRequest(root, 'app://bettertts/assets/missing.js', 'text/html')?.allowSpaFallback).toBe(false)
    expect(resolveRendererRequest(root, 'app://bettertts/models/missing.bin', '*/*')?.allowSpaFallback).toBe(false)
  })
})
