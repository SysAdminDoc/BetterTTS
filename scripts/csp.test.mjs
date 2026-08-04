import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const viteConfig = readFileSync(resolve(import.meta.dirname, '../vite.config.ts'), 'utf8')

describe('production CSP destinations', () => {
  it('does not allow blob modules in document scripts while keeping worker blob support', () => {
    expect(viteConfig).toContain('"script-src \'self\' \'wasm-unsafe-eval\'"')
    expect(viteConfig).not.toMatch(/script-src[^\n]*blob:/u)
    expect(viteConfig).toContain('"worker-src \'self\' blob:"')
  })
})
