import { beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_SPEC_BYTES, htmlToText, isJiraKey, isSpecFileName, specCriteria, specKey, specTitle, specToText } from '../src/shared/spec-files'
import { addSpecFiles, getIssueFile, readIssues, readSpecIssue, specsDir } from '../src/main/services/issues'
import { reviewDir } from '../src/main/services/reviews'

describe('spec file names and keys', () => {
  it('accepts .md, .txt and .html in any case, and refuses the rest', () => {
    expect(['a.md', 'A.TXT', 'b.html', 'c.htm'].map(isSpecFileName)).toEqual([true, true, true, true])
    expect(['a.pdf', 'a', 'a.md.exe', '.md'].map(isSpecFileName)).toEqual([false, false, false, true])
  })
  it('makes the key from the file name only, with unsafe characters replaced', () => {
    expect(specKey('C:\\docs\\Checkout spec (v2).md')).toBe('Checkout spec _v2_.md')
    expect(specKey('/home/a/../b/a:b.txt')).toBe('a_b.txt')
  })
  it('tells a Jira key from a file key', () => {
    expect(isJiraKey('LX-2813')).toBe(true)
    expect(isJiraKey('spec.md')).toBe(false)
    expect(isJiraKey('LX-1.md')).toBe(false)
  })
})

describe('HTML to text', () => {
  it('keeps headings, lists and paragraphs, drops scripts and styles, and decodes entities', () => {
    const html =
      '<html><head><title>x</title><style>p{}</style></head><body><script>alert(1)</script><h1>Checkout &amp; pay</h1><p>Users can <b>pay</b> by card.</p><h2>Acceptance criteria</h2><ul><li>Card is charged</li><li>Receipt is shown &mdash; at once</li></ul></body></html>'
    expect(htmlToText(html)).toBe('# Checkout & pay\n\nUsers can pay by card.\n\n## Acceptance criteria\n\n- Card is charged\n- Receipt is shown — at once')
  })
  it('never keeps a tag or a script body in the text', () => {
    const t = htmlToText('<div onclick="x()">hi<script>steal()</script><img src="x" onerror="y()"></div>')
    expect(t).toBe('hi')
    expect(t).not.toMatch(/steal|onerror|<|>/)
  })
  it('turns numeric entities and table rows into text', () => {
    expect(htmlToText('<p>&#65;&#x42;</p><table><tr><td>a</td><td>b</td></tr></table>')).toBe('AB\n\na | b |')
  })
})

describe('title and text', () => {
  it('reads the first heading, else the first line, else the name', () => {
    expect(specTitle('s.md', '# Checkout flow\n\ntext')).toBe('Checkout flow')
    expect(specTitle('s.txt', '\n\nFirst line here\nsecond')).toBe('First line here')
    expect(specTitle('s.txt', '')).toBe('s.txt')
  })
  it('removes a byte order mark and normalizes line breaks', () => {
    expect(specToText('a.md', '\uFEFFone\r\ntwo\r')).toBe('one\ntwo')
    expect(specToText('a.html', '<p>x</p>')).toBe('x')
  })
})

describe('acceptance criteria of a spec text', () => {
  it('reads the list under an Acceptance criteria heading and stops at the next heading of the same level', () => {
    const md = '# Spec\n\n## Acceptance criteria\n\n- Learner sees the card\n1. [x] Card links to the course\n\n## Notes\n\n- not a criterion'
    expect(specCriteria(md)).toEqual(['Learner sees the card', 'Card links to the course'])
  })
  it('does not stop at a deeper heading, and stops at a higher one', () => {
    expect(specCriteria('## AC\n- a\n### detail\n- b\n# Next\n- c')).toEqual(['a', 'b'])
  })
  it('reads a plain text label with a list, and stops at the next label', () => {
    const txt = 'Overview\nsome text\n\nAcceptance criteria:\n- one\n- two\n\nOut of scope:\n- three'
    expect(specCriteria(txt)).toEqual(['one', 'two'])
  })
  it('uses paragraphs when there is no list', () => {
    expect(specCriteria('## Done when\n\nIt works.\n\nIt is fast.\n\n## Other\n\nx')).toEqual(['It works.', 'It is fast.'])
  })
  it('gives none when there is no start, and AC1 alone does not start a section', () => {
    expect(specCriteria('# Spec\n\n- a\n- b')).toEqual([])
    expect(specCriteria('AC1\n- x')).toEqual([])
  })
  it('reads criteria from converted HTML', () => {
    expect(specCriteria(specToText('a.html', '<h2>Acceptance criteria</h2><ol><li>First</li><li>Second</li></ol><h2>Notes</h2><p>x</p>'))).toEqual([
      'First',
      'Second'
    ])
  })
})

describe('adding spec files to a review', () => {
  let root: string
  let src: string
  const seed = (issues: string[] = []): void => {
    mkdirSync(reviewDir(root, 'R-1'), { recursive: true })
    writeFileSync(join(reviewDir(root, 'R-1'), 'review.json'), JSON.stringify({ title: 'R', mrs: [], skipped: [], issues }))
  }
  const saved = (): string[] => JSON.parse(readFileSync(join(reviewDir(root, 'R-1'), 'review.json'), 'utf8')).issues
  const file = (name: string, content: string | Buffer): string => {
    const p = join(src, name)
    writeFileSync(p, content)
    return p
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codediff-spec-'))
    src = mkdtempSync(join(tmpdir(), 'codediff-specsrc-'))
    seed()
  })

  it('copies good files into the review, adds their keys and reads them as issues', async () => {
    const md = file('Checkout.md', '# Checkout\n\n## Acceptance criteria\n\n- Pays by card\n- Shows a receipt\n')
    const html = file('flow.html', '<h1>Flow</h1><p>text</p>')
    const r = await addSpecFiles(root, 'R-1', [md, html])
    expect(r).toEqual({ ok: true, value: { added: ['Checkout.md', 'flow.html'], problems: {} } })
    expect(saved()).toEqual(['Checkout.md', 'flow.html'])
    expect(readFileSync(join(specsDir(root, 'R-1'), 'Checkout.md'), 'utf8')).toContain('Pays by card')
    const [a, b] = await readIssues(root, 'R-1', ['Checkout.md', 'flow.html'])
    expect(a).toMatchObject({
      source: 'file',
      key: 'Checkout.md',
      title: 'Checkout',
      type: 'Spec',
      url: null,
      criteria: ['Pays by card', 'Shows a receipt'],
      error: null
    })
    expect(b).toMatchObject({ title: 'Flow', description: '# Flow\n\ntext' })
  })
  it('refuses a wrong type, a large file, a binary file and a duplicate, each with its reason', async () => {
    const big = file('big.txt', 'x'.repeat(MAX_SPEC_BYTES + 1))
    const bin = file('bin.md', Buffer.from([65, 0, 66]))
    const pdf = file('doc.pdf', 'x')
    const ok = file('ok.md', '# ok')
    expect((await addSpecFiles(root, 'R-1', [ok])).ok).toBe(true)
    const r = await addSpecFiles(root, 'R-1', [big, bin, pdf, ok])
    expect(r).toEqual({
      ok: true,
      value: {
        added: [],
        problems: {
          'big.txt': 'The file is larger than 1 MB.',
          'bin.md': 'This is not a text file.',
          'doc.pdf': 'Only .md, .txt and .html files can be added.',
          'ok.md': 'Already in this review.'
        }
      }
    })
    expect(saved()).toEqual(['ok.md']) // nothing else was added
  })
  it('gives a failed row when the copy is missing, and a file for the detail panel', async () => {
    seed(['gone.md', 'there.md'])
    mkdirSync(specsDir(root, 'R-1'), { recursive: true })
    writeFileSync(join(specsDir(root, 'R-1'), 'there.md'), '# There\n\n- Acceptance criteria:\n')
    expect(await readSpecIssue(root, 'R-1', 'gone.md')).toMatchObject({ source: 'file', error: 'The file is missing from the review folder.' })
    const f = await getIssueFile(root, 'R-1', 'there.md')
    expect(f.ok && f.value).toContain('# there.md: There')
    expect(f.ok && f.value).toContain('**Source:** spec file `there.md`')
    const bad = await getIssueFile(root, 'R-1', 'gone.md')
    expect(bad.ok && bad.value).toContain('This spec file cannot be read: The file is missing from the review folder.')
  })
  it('refuses nothing to add and too many', async () => {
    expect(await addSpecFiles(root, 'R-1', [])).toEqual({ ok: false, error: 'Send 1 to 20 spec files.' })
  })
})
