import { useCallback, useEffect, useRef, useState } from 'react'
import { findAll } from '@shared/find-text'

const ALL = 'find'
const CURRENT = 'find-current'

/** A range over the characters `from` to `to` of the joined text of some text nodes. */
function rangeOf(nodes: Text[], from: number, to: number): Range | null {
  const range = document.createRange()
  let offset = 0
  let started = false
  for (const node of nodes) {
    const end = offset + node.data.length
    if (!started && from < end) {
      range.setStart(node, from - offset)
      started = true
    }
    if (started && to <= end) {
      range.setEnd(node, to - offset)
      return range
    }
    offset = end
  }
  return null
}

/** Every match of the query in the code cells of the root. A match can cross the pieces of a coloured line. */
function collect(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = []
  for (const cell of root.querySelectorAll('td.code')) {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
    let text = ''
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      nodes.push(node)
      text += node.data
    }
    for (const start of findAll(text, query)) {
      const range = rangeOf(nodes, start, start + query.length)
      if (range) ranges.push(range)
    }
  }
  return ranges
}

function paint(ranges: Range[], current: number): void {
  if (!('highlights' in CSS)) return
  CSS.highlights.set(ALL, new Highlight(...ranges))
  CSS.highlights.set(CURRENT, new Highlight(...(ranges[current] ? [ranges[current]] : [])))
}

function unpaint(): void {
  if (!('highlights' in CSS)) return
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

/**
 * The find bar of the file panel. It marks every match of the text in the code with the CSS highlight API, so the lines of the
 * diff are not changed. The matches are found again when the code changes, for example when the colours arrive or the layout changes.
 */
export function FindBar(props: { root: () => HTMLElement | null; focusToken: number; onClose: () => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [index, setIndex] = useState(0)
  const { root: getRoot } = props
  const input = useRef<HTMLInputElement>(null)
  const ranges = useRef<Range[]>([])
  // A step by the user scrolls to the match. A change of the code under the bar does not.
  const reveal = useRef(false)
  const indexRef = useRef(0)
  indexRef.current = index

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [props.focusToken])

  const refresh = useCallback(() => {
    const root = getRoot()
    ranges.current = root && query ? collect(root, query) : []
    setCount(ranges.current.length)
    const at = Math.min(indexRef.current, Math.max(0, ranges.current.length - 1))
    setIndex(at)
    paint(ranges.current, at)
    if (reveal.current && ranges.current[at]) {
      reveal.current = false
      ranges.current[at].startContainer.parentElement?.scrollIntoView({ block: 'center' })
    }
  }, [getRoot, query])

  useEffect(() => {
    reveal.current = true
    setIndex(0)
    indexRef.current = 0
  }, [query])

  useEffect(() => {
    refresh()
    const root = getRoot()
    if (!root) return
    let frame = 0
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(refresh)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [refresh, getRoot])

  useEffect(() => unpaint, [])

  const step = (dir: 1 | -1): void => {
    if (ranges.current.length === 0) return
    const next = (indexRef.current + dir + ranges.current.length) % ranges.current.length
    setIndex(next)
    indexRef.current = next
    paint(ranges.current, next)
    ranges.current[next]?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      props.onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    }
  }

  return (
    <div className="findbar" role="search" data-testid="find-bar" onKeyDown={onKey}>
      <input
        ref={input}
        aria-label="Find in the file"
        placeholder="Find in the file"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid="find-input"
      />
      <span className="muted small" data-testid="find-count" aria-live="polite">
        {query === '' ? '' : count === 0 ? 'No matches' : `${index + 1} of ${count}`}
      </span>
      <button aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={count === 0} onClick={() => step(-1)}>
        ↑
      </button>
      <button aria-label="Next match" title="Next match (Enter)" disabled={count === 0} onClick={() => step(1)}>
        ↓
      </button>
      <button aria-label="Close find" title="Close (Escape)" onClick={props.onClose}>
        ×
      </button>
    </div>
  )
}
