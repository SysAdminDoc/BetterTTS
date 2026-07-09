import { describe, expect, it } from 'vitest'
import { TextSplitterStream } from 'kokoro-js'

// Regression coverage for the patch in patches/kokoro-js+1.2.1.patch.
//
// Upstream hexgrad/kokoro#343 (open, unfixed even on main as of 2026-07-09):
// TextSplitterStream's URL/@-mention protection sets `i = tokenStart +
// token.length`, which makes zero progress when the token ends exactly at the
// terminator — an input like "@handle\n" freezes the event loop synchronously
// inside push(). The app never uses stream()/TextSplitterStream itself, but
// the class is exported from a dependency we ship, so the patch guards it with
// Math.max(i + 1, ...). If the patch is ever lost (dependency bump without
// re-checking the patch), these tests hang and fail on timeout.
describe('kokoro-js TextSplitterStream patch (hexgrad/kokoro#343)', () => {
  it('does not freeze on an @-mention followed by a newline', () => {
    const splitter = new TextSplitterStream()
    splitter.push('@handle\n')
    splitter.close()
    // Reaching this line at all is the assertion that matters.
    expect([...splitter]).toEqual(['@handle'])
  })

  it('does not freeze on URLs ending at a terminator', () => {
    const splitter = new TextSplitterStream()
    splitter.push('See https://example.com/page\nNext sentence follows here.')
    splitter.close()
    const sentences = [...splitter]
    expect(sentences.length).toBeGreaterThan(0)
    expect(sentences.join(' ')).toContain('example.com')
  })

  it('still splits ordinary prose correctly after the patch', () => {
    const splitter = new TextSplitterStream()
    splitter.push('First sentence. Second sentence! Third one?')
    splitter.close()
    expect([...splitter]).toEqual(['First sentence.', 'Second sentence!', 'Third one?'])
  })
})
