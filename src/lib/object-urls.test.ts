import { describe, expect, it } from 'vitest'
import { createObjectUrlRegistry } from './object-urls.ts'

describe('object URL registry', () => {
  it('revokes output and caption URLs independently and on disposal', () => {
    const revoked: string[] = []
    const registry = createObjectUrlRegistry((url) => revoked.push(url))
    registry.addOutput('blob:output')
    registry.addCaption('blob:caption')
    registry.clearOutputs()
    expect(revoked).toEqual(['blob:output'])
    registry.dispose()
    expect(revoked).toEqual(['blob:output', 'blob:caption'])
  })

  it('does not revoke a URL twice when a caller registers it repeatedly', () => {
    const revoked: string[] = []
    const registry = createObjectUrlRegistry((url) => revoked.push(url))
    registry.addOutput('blob:duplicate')
    registry.addOutput('blob:duplicate')
    registry.clearOutputs()
    expect(revoked).toEqual(['blob:duplicate'])
  })
})
