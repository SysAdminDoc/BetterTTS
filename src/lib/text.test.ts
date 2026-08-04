import { describe, expect, it } from 'vitest'
import { DEFAULT_CLEANUP, checkSynthesisCompleteness, cleanupText, formatBytes, normalizeAudiobookNumbers, parseDialogLines, parsePauseTags, slugify, splitInput, splitIntoSentences, splitNarratorText } from './text.ts'

describe('checkSynthesisCompleteness', () => {
  // ~200 speakable chars of ordinary prose.
  const longSentence = 'The quick brown fox jumps over the lazy dog while the narrator keeps reading this deliberately long sentence about audiobooks, chapters, pronunciation, and the many ways engines can silently drop text.'

  it('flags audio implausibly short for its text (truncated fixture)', () => {
    const result = checkSynthesisCompleteness(longSentence, 1.0, 1)
    expect(result.suspect).toBe(true)
    expect(result.speakableChars).toBeGreaterThan(150)
    expect(result.minExpectedSeconds).toBeGreaterThan(1.0)
  })

  it('accepts plausible durations for the same text', () => {
    expect(checkSynthesisCompleteness(longSentence, 12, 1).suspect).toBe(false)
  })

  it('exempts short inputs where variance dominates', () => {
    expect(checkSynthesisCompleteness('Six.', 0.1, 1).suspect).toBe(false)
    expect(checkSynthesisCompleteness('A fairly short line of text.', 0.2, 1).suspect).toBe(false)
  })

  it('scales the floor with the speed setting', () => {
    const chars = checkSynthesisCompleteness(longSentence, 0, 1).speakableChars
    const borderline = chars / 60 // between the 45 c/s floor (speed 1) and 90 c/s (speed 2)
    expect(checkSynthesisCompleteness(longSentence, borderline, 1).suspect).toBe(true)
    expect(checkSynthesisCompleteness(longSentence, borderline, 2).suspect).toBe(false)
  })

  it('counts non-Latin speakable characters', () => {
    const hindi = 'यह एक लंबा वाक्य है जो हिंदी में लिखा गया है और इसमें बहुत सारे अक्षर हैं ताकि पूर्णता की जांच सही ढंग से काम करे और छोटे इनपुट की छूट लागू न हो पाए।'
    const result = checkSynthesisCompleteness(hindi, 0.5, 1)
    expect(result.speakableChars).toBeGreaterThan(80)
    expect(result.suspect).toBe(true)
  })
})

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric chars', () => {
    expect(slugify('Hello World!')).toBe('hello-world')
  })

  it('trims leading/trailing hyphens', () => {
    expect(slugify('---test---')).toBe('test')
  })

  it('truncates to 42 characters', () => {
    const long = 'a'.repeat(100)
    expect(slugify(long).length).toBeLessThanOrEqual(42)
  })

  it('returns fallback for empty/whitespace input', () => {
    expect(slugify('')).toBe('bettertts-audio')
    expect(slugify('   ')).toBe('bettertts-audio')
    expect(slugify('!!!')).toBe('bettertts-audio')
  })
})

describe('splitInput', () => {
  it('returns whole text as single chunk when separateLines is false', () => {
    expect(splitInput('Hello\nWorld', false)).toEqual(['Hello\nWorld'])
  })

  it('splits by line when separateLines is true', () => {
    expect(splitInput('Line 1\nLine 2\n\nLine 3', true)).toEqual(['Line 1', 'Line 2', 'Line 3'])
  })

  it('returns empty array for blank input', () => {
    expect(splitInput('', false)).toEqual([])
    expect(splitInput('   ', true)).toEqual([])
  })

  it('trims each line and filters empties', () => {
    expect(splitInput('  a  \n\n  b  \n', true)).toEqual(['a', 'b'])
  })
})

describe('parsePauseTags', () => {
  it('parses [pause] with default 1s duration', () => {
    const result = parsePauseTags('Hello [pause] world')
    expect(result).toEqual([
      { type: 'text', content: 'Hello' },
      { type: 'pause', duration: 1 },
      { type: 'text', content: 'world' },
    ])
  })

  it('parses [pause 2s] with specified duration', () => {
    const result = parsePauseTags('A [pause 2s] B')
    expect(result).toEqual([
      { type: 'text', content: 'A' },
      { type: 'pause', duration: 2 },
      { type: 'text', content: 'B' },
    ])
  })

  it('parses [pause 0.5] without s suffix', () => {
    const result = parsePauseTags('X [pause 0.5] Y')
    expect(result[1]).toEqual({ type: 'pause', duration: 0.5 })
  })

  it('is case insensitive', () => {
    const result = parsePauseTags('[Pause 3s]')
    expect(result[0]).toEqual({ type: 'pause', duration: 3 })
  })

  it('clamps duration to 30s max', () => {
    const result = parsePauseTags('[pause 50s]')
    expect(result).toEqual([{ type: 'text', content: '[pause 50s]' }])
  })

  it('returns text segment for input without pause tags', () => {
    const result = parsePauseTags('Just text')
    expect(result).toEqual([{ type: 'text', content: 'Just text' }])
  })

  it('handles multiple consecutive pauses', () => {
    const result = parsePauseTags('[pause 1s][pause 2s]')
    expect(result).toEqual([
      { type: 'pause', duration: 1 },
      { type: 'pause', duration: 2 },
    ])
  })
})

describe('splitIntoSentences', () => {
  it('splits at sentence boundaries', () => {
    const result = splitIntoSentences('Hello world. How are you? Fine!')
    expect(result).toEqual(['Hello world. How are you? Fine!'])
  })

  it('groups short sentences together', () => {
    const result = splitIntoSentences('A. B. C.')
    expect(result.length).toBe(1)
    expect(result[0]).toBe('A. B. C.')
  })

  it('splits when combined length exceeds 300', () => {
    const long = 'X'.repeat(200) + '. ' + 'Y'.repeat(200) + '.'
    const result = splitIntoSentences(long)
    expect(result.length).toBe(2)
  })

  it('returns input for text without sentence boundaries', () => {
    const result = splitIntoSentences('Just a phrase')
    expect(result).toEqual(['Just a phrase'])
  })

  it('handles empty input', () => {
    expect(splitIntoSentences('')).toEqual([])
    expect(splitIntoSentences('   ')).toEqual([])
  })

  it('hard-splits an unpunctuated run so no chunk exceeds 300 chars', () => {
    const words = Array.from({ length: 250 }, (_, i) => `word${i}`).join(' ')
    const result = splitIntoSentences(words)
    expect(result.length).toBeGreaterThan(1)
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(300)
    }
    expect(result.join(' ')).toBe(words)
  })

  it('prefers comma boundaries when hard-splitting', () => {
    const clause = 'alpha beta gamma delta, '.repeat(20).trim().replace(/,$/, '')
    const result = splitIntoSentences(clause)
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(300)
    }
    expect(result.some((c) => c.endsWith(','))).toBe(true)
  })

  it('hard-splits a single giant token without whitespace', () => {
    const giant = 'a'.repeat(950)
    const result = splitIntoSentences(giant)
    expect(result.length).toBe(4)
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(300)
    }
    expect(result.join('')).toBe(giant)
  })

  it('leaves punctuated text under the limit untouched', () => {
    expect(splitIntoSentences('Hello world. How are you?')).toEqual(['Hello world. How are you?'])
  })
})

describe('parseDialogLines', () => {
  it('parses [speaker:Name] prefixes', () => {
    const result = parseDialogLines('[speaker:Alice] Hello.\n[speaker:Bob] Hi there.')
    expect(result).toEqual([
      { speaker: 'Alice', text: 'Hello.' },
      { speaker: 'Bob', text: 'Hi there.' },
    ])
  })

  it('handles lines without speaker prefix', () => {
    const result = parseDialogLines('No prefix here.\n[speaker:Bob] With prefix.')
    expect(result).toEqual([
      { speaker: null, text: 'No prefix here.' },
      { speaker: 'Bob', text: 'With prefix.' },
    ])
  })

  it('skips empty lines', () => {
    const result = parseDialogLines('[speaker:A] Line 1\n\n[speaker:B] Line 2')
    expect(result.length).toBe(2)
  })

  it('is case insensitive on the speaker tag', () => {
    const result = parseDialogLines('[Speaker:Eve] Test')
    expect(result[0].speaker).toBe('Eve')
  })
})

describe('splitNarratorText', () => {
  it('auto-splits straight and curly quoted dialogue from narration', () => {
    expect(splitNarratorText('The door opened. "We should go," Alice said. “Now.”')).toEqual([
      { role: 'narration', text: 'The door opened.' },
      { role: 'dialogue', text: 'We should go,', speaker: undefined },
      { role: 'narration', text: 'Alice said.' },
      { role: 'dialogue', text: 'Now.' },
    ])
  })

  it('keeps explicit speaker prefixes and merges adjacent narration', () => {
    expect(splitNarratorText('Narration line.\n[speaker: Eve] Hello there.\nNext paragraph.')).toEqual([
      { role: 'narration', text: 'Narration line.' },
      { role: 'dialogue', text: 'Hello there.', speaker: 'Eve' },
      { role: 'narration', text: 'Next paragraph.' },
    ])
  })

  it('records a simple leading speaker attribution on quoted dialogue', () => {
    expect(splitNarratorText('Alice said, "Stay here."')).toEqual([
      { role: 'narration', text: 'Alice said,' },
      { role: 'dialogue', text: 'Stay here.', speaker: 'Alice' },
    ])
  })

  it('records a simple trailing speaker attribution on quoted dialogue', () => {
    expect(splitNarratorText('"Stay here," Alice said.')).toEqual([
      { role: 'dialogue', text: 'Stay here.', speaker: 'Alice' },
      { role: 'narration', text: 'Alice said.' },
    ])
  })

  it('does not treat apostrophes or unmatched quotes as dialogue', () => {
    expect(splitNarratorText("It's a 6\" sample.")).toEqual([{ role: 'narration', text: `It's a 6" sample.` }])
    expect(splitNarratorText('He said "unfinished line.')).toEqual([{ role: 'narration', text: 'He said "unfinished line.' }])
  })

  it('falls back to one narration segment for plain long-form text', () => {
    expect(splitNarratorText('First paragraph.\nSecond paragraph.')).toEqual([
      { role: 'narration', text: 'First paragraph. Second paragraph.' },
    ])
  })
})

describe('cleanupText', () => {
  const off = {
    citations: false,
    urls: false,
    acronyms: false,
    markdown: false,
    footnotes: false,
    pageArtifacts: false,
    numbers: false,
    metadata: false,
  }

  it('strips numeric citation markers', () => {
    expect(cleanupText('Speed matters [12] a lot [1, 2] indeed [3-5].', { ...off, citations: true })).toBe(
      'Speed matters a lot indeed .',
    )
  })

  it('does not treat pause or speaker tags as citations', () => {
    const text = '[speaker:Ann] Hello [pause 2s] world [7]'
    const result = cleanupText(text, { ...off, citations: true })
    expect(result).toContain('[speaker:Ann]')
    expect(result).toContain('[pause 2s]')
    expect(result).not.toContain('[7]')
  })

  it('replaces bare URLs with "link"', () => {
    expect(cleanupText('See https://example.com/a?b=1 and www.foo.org today', { ...off, urls: true })).toBe(
      'See link and link today',
    )
  })

  it('letter-spaces vowel-less acronyms but leaves pronounceable ones', () => {
    const result = cleanupText('SQL and HTML beat NASA and REST', { ...off, acronyms: true })
    expect(result).toContain('S Q L')
    expect(result).toContain('H T M L')
    expect(result).toContain('NASA')
    expect(result).toContain('REST')
  })

  it('strips markdown syntax and keeps link text', () => {
    const md = '# Title\n\nSome **bold** and `code` plus [a link](https://x.dev) here\n- bullet one'
    const result = cleanupText(md, { ...off, markdown: true })
    expect(result).not.toContain('#')
    expect(result).not.toContain('**')
    expect(result).not.toContain('`')
    expect(result).toContain('bold')
    expect(result).toContain('a link')
    expect(result).not.toContain('https://x.dev')
    expect(result).toContain('bullet one')
  })

  it('markdown links resolve before URL shortening under defaults', () => {
    const result = cleanupText('Read [the docs](https://docs.dev) or https://raw.dev', DEFAULT_CLEANUP)
    expect(result).toContain('the docs')
    expect(result).toContain('link')
    expect(result).not.toContain('docs.dev')
  })

  it('is a no-op when every rule is off', () => {
    const text = 'Keep [12] https://x.dev SQL **bold**'
    expect(cleanupText(text, off)).toBe(text)
  })

  it('normalizes currency, decimals, units, and percentages', () => {
    const result = cleanupText('The price is $12.50, pi is 3.14, mass is 2.5 kg, and progress is 50%.', { ...off, numbers: true })
    expect(result).toContain('12 dollars and 50 cents')
    expect(result).toContain('3 point 1 4')
    expect(result).toContain('2 point 5 kilograms')
    expect(result).toContain('50 percent')
  })

  it('removes ISBN-like metadata without deleting story text', () => {
    const result = cleanupText('ISBN 978-1-4028-9462-6\nChapter One\nThe room was quiet.', { ...off, metadata: true })
    expect(result).not.toContain('978-1-4028-9462-6')
    expect(result).toContain('Chapter One')
    expect(result).toContain('The room was quiet.')
  })

  it('removes repeated page headers, footers, and page numbers', () => {
    const result = cleanupText('Book Title\n1\nThe first page.\nBook Title\nPage 2 of 300\nThe second page.', { ...off, pageArtifacts: true })
    expect(result).not.toContain('Book Title')
    expect(result).not.toContain('Page 2 of 300')
    expect(result).toContain('The first page.')
    expect(result).toContain('The second page.')
  })

  it('removes footnote markers, note lines, and references sections', () => {
    const result = cleanupText('The claim¹ stays readable.\n[1] This is a footnote line.\nReferences\nSmith, Example Book.', { ...off, footnotes: true })
    expect(result).toContain('The claim stays readable.')
    expect(result).not.toContain('footnote line')
    expect(result).not.toContain('References')
    expect(result).not.toContain('Smith')
  })
})

describe('normalizeAudiobookNumbers', () => {
  it('keeps integer-looking tokens unchanged when no unit or currency is present', () => {
    expect(normalizeAudiobookNumbers('Chapter 12 starts now')).toBe('Chapter 12 starts now')
  })

  it('never treats the preposition "in" after a number as inches', () => {
    expect(normalizeAudiobookNumbers('About 1 in 10 people agree.')).toBe('About 1 in 10 people agree.')
    expect(normalizeAudiobookNumbers('She arrived at 3 in the morning.')).toBe('She arrived at 3 in the morning.')
    expect(normalizeAudiobookNumbers('He was born in 1922 in Ohio.')).toBe('He was born in 1922 in Ohio.')
  })

  it('still expands ambiguous units before punctuation or end of line', () => {
    expect(normalizeAudiobookNumbers('The board is 5 in.')).toBe('The board is 5 inches.')
    expect(normalizeAudiobookNumbers('He ran 400 m, then rested.')).toBe('He ran 400 meters, then rested.')
    expect(normalizeAudiobookNumbers('Add 30 g')).toBe('Add 30 grams')
  })
})

describe('splitIntoSentences unicode boundaries', () => {
  it('splits Hindi sentences at the danda', () => {
    const first = 'यह पहला वाक्य है और इसे लंबा बनाया गया है ताकि यह अपने ही खंड में रहे। '.repeat(8)
    const chunks = splitIntoSentences(first)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.endsWith('।')).toBe(true)
    }
  })

  it('splits fullwidth CJK stops that have no trailing space', () => {
    const text = `${'こ'.repeat(200)}。${'ん'.repeat(200)}。`
    const chunks = splitIntoSentences(text)
    expect(chunks.length).toBe(2)
    expect(chunks[0].endsWith('。')).toBe(true)
  })

  it('never splits a surrogate pair at the hard-cut boundary', () => {
    const text = `a${'🎉'.repeat(400)}`
    const chunks = splitIntoSentences(text)
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/)
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/)
    }
  })
})

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B')
  })

  it('formats kilobytes', () => {
    expect(formatBytes(2048)).toBe('2 kB')
  })

  it('formats megabytes', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
