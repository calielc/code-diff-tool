import { describe, expect, it } from 'vitest'
import type { Seg } from '../src/shared/intraline'
import {
  MAX_CHARS,
  MAX_LINE_LENGTH,
  MAX_LINES,
  kindOfClasses,
  limitReason,
  linesFromTree,
  piecesOf,
  textOfTokens,
  type TreeNode
} from '../src/shared/syntax-tokens'

const text = (value: string): TreeNode => ({ type: 'text', value })
const span = (names: string[], ...children: TreeNode[]): TreeNode => ({ type: 'element', properties: { className: names }, children })
const root = (...children: TreeNode[]): TreeNode => ({ type: 'root', children })

describe('kindOfClasses', () => {
  it('groups the scopes of highlight.js', () => {
    expect(kindOfClasses(['hljs-keyword'])).toBe('kw')
    expect(kindOfClasses(['hljs-string'])).toBe('str')
    expect(kindOfClasses(['hljs-comment'])).toBe('cm')
    expect(kindOfClasses(['hljs-number'])).toBe('num')
    expect(kindOfClasses(['hljs-title', 'class_'])).toBe('ty')
    expect(kindOfClasses(['hljs-title', 'function_'])).toBe('fn')
    expect(kindOfClasses(['hljs-variable', 'language_'])).toBe('kw')
    expect(kindOfClasses(['hljs-attr'])).toBe('at')
    expect(kindOfClasses(['hljs-name'])).toBe('tg')
  })
  it('lets a scope reset to plain text, and gives special code to a scope it does not list', () => {
    expect(kindOfClasses(['hljs-subst'])).toBe('none')
    expect(kindOfClasses(['hljs-punctuation'])).toBe('none')
    expect(kindOfClasses(['hljs-made-up'])).toBe('mt')
    expect(kindOfClasses([])).toBeUndefined()
  })
})

describe('linesFromTree', () => {
  it('cuts text into lines and joins neighbours of one kind', () => {
    const lines = linesFromTree(root(text('a'), text('b\nc')))
    expect(lines).toEqual([[{ text: 'ab', kind: null }], [{ text: 'c', kind: null }]])
  })

  it('gives each line of a multi-line comment its own comment token', () => {
    const lines = linesFromTree(root(text('x = 1 '), span(['hljs-comment'], text('/* one\ntwo\nthree */')), text(' y')))
    expect(lines).toEqual([
      [
        { text: 'x = 1 ', kind: null },
        { text: '/* one', kind: 'cm' }
      ],
      [{ text: 'two', kind: 'cm' }],
      [
        { text: 'three */', kind: 'cm' },
        { text: ' y', kind: null }
      ]
    ])
  })

  it('lets the inner scope win and returns to the outer one after it', () => {
    const lines = linesFromTree(root(span(['hljs-string'], text('"a '), span(['hljs-subst'], text('${b}')), text(' c"'))))
    expect(lines[0].map((t) => [t.text, t.kind])).toEqual([
      ['"a ', 'str'],
      ['${b}', null],
      [' c"', 'str']
    ])
  })

  it('keeps empty lines, and the tokens of a line join to the text of the line', () => {
    const lines = linesFromTree(root(text('a\n\nb\n')))
    expect(lines.map(textOfTokens)).toEqual(['a', '', 'b', ''])
  })

  it('keeps markup in the text as text', () => {
    const lines = linesFromTree(root(span(['hljs-string'], text('"<img src=x onerror=alert(1)>"'))))
    expect(lines[0]).toEqual([{ text: '"<img src=x onerror=alert(1)>"', kind: 'str' }])
  })
})

describe('piecesOf: the marks of changed characters over the tokens', () => {
  const tokens = [
    { text: 'const', kind: 'kw' as const },
    { text: ' total = ', kind: null },
    { text: '"abc"', kind: 'str' as const },
    { text: ';', kind: null }
  ]
  const line = 'const total = "abc";'

  it('keeps the colour and the mark of every character when the two split the line in different places', () => {
    // The mark covers "al = " plus the first quote and "a" of the string
    const segs: Seg[] = [
      { text: 'const to', changed: false },
      { text: 'tal = "a', changed: true },
      { text: 'bc";', changed: false }
    ]
    const pieces = piecesOf(line, tokens, segs)
    expect(pieces.map((p) => p.text).join('')).toBe(line)
    // every character has the kind of its token and the mark of its segment
    let at = 0
    for (const p of pieces) {
      for (let i = 0; i < p.text.length; i++, at++) {
        const inTok = at < 5 ? 'kw' : at < 14 ? null : at < 19 ? 'str' : null
        expect(p.kind, `kind of character ${at}`).toBe(inTok)
        expect(p.changed, `mark of character ${at}`).toBe(at >= 8 && at < 16)
      }
    }
    expect(pieces.some((p) => p.changed && p.kind === 'str')).toBe(true)
    expect(pieces.some((p) => p.changed && p.kind === null)).toBe(true)
  })

  it('has one piece for each run when the marks are only inside one token', () => {
    const pieces = piecesOf(line, tokens, [
      { text: 'const total = "a', changed: false },
      { text: 'b', changed: true },
      { text: 'c";', changed: false }
    ])
    expect(pieces.map((p) => [p.text, p.kind, p.changed])).toEqual([
      ['const', 'kw', false],
      [' total = ', null, false],
      ['"a', 'str', false],
      ['b', 'str', true],
      ['c"', 'str', false],
      [';', null, false]
    ])
  })

  it('draws the marks alone when there are no tokens, and the tokens alone when there are no marks', () => {
    expect(
      piecesOf('ab', null, [
        { text: 'a', changed: true },
        { text: 'b', changed: false }
      ]).map((p) => [p.text, p.kind, p.changed])
    ).toEqual([
      ['a', null, true],
      ['b', null, false]
    ])
    expect(piecesOf(line, tokens, undefined)).toHaveLength(4)
  })

  it('ignores tokens or marks that do not belong to the text, and the text stays right', () => {
    expect(piecesOf('hello', [{ text: 'other', kind: 'kw' }], null)).toEqual([{ text: 'hello', kind: null, changed: false }])
    expect(piecesOf('hello', null, [{ text: 'other', changed: true }])).toEqual([{ text: 'hello', kind: null, changed: false }])
  })

  it('gives no piece for an empty line', () => {
    expect(piecesOf('', [], null)).toEqual([])
  })
})

describe('limitReason', () => {
  it('lets a normal text through', () => {
    expect(limitReason(['const a = 1', 'const b = 2'])).toBeNull()
    expect(limitReason(new Array<string>(MAX_LINES).fill('x'))).toBeNull()
  })
  it('stops a text with too many lines', () => {
    expect(limitReason(new Array<string>(MAX_LINES + 1).fill('x'))).toBe('it has more than 8,000 lines')
  })
  it('stops a text with a very long line, such as minified code', () => {
    expect(limitReason(['a', 'x'.repeat(MAX_LINE_LENGTH + 1)])).toBe('it has a line longer than 1,500 characters')
    expect(limitReason(['x'.repeat(MAX_LINE_LENGTH)])).toBeNull()
  })
  it('stops a text with too many characters', () => {
    const lines = new Array<string>(MAX_LINES).fill('x'.repeat(Math.ceil(MAX_CHARS / MAX_LINES) + 5))
    expect(limitReason(lines)).toBe('it has more than 600,000 characters')
  })
})
