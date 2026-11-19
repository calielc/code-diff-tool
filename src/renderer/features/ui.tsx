import type { Block, Inline } from '@shared/comments'
import { parseMarkdown } from '@shared/comments'
import type { Person } from '@shared/provider'
import { api } from '../api'

/** The system locale, medium date and short time, for example `Nov 5, 2026, 12:16 PM` (file 02 section 8.2). */
export const formatDate = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** The first letters of the first two words of the name, upper case. */
export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?'

/**
 * A round 22 px avatar. Pictures are not loaded: the content policy allows no remote images, and the initials are
 * the fallback the spec asks for anyway.
 */
export function Avatar(props: { user: string; people: Record<string, Person>; viewer: string }): React.JSX.Element {
  const p = props.people[props.user]
  const name = p?.name || props.user
  return (
    <span className="avatar" title={`${name} (@${props.user})${props.user === props.viewer ? ', you' : ''}`}>
      {initials(name)}
    </span>
  )
}

function Inlines({ items }: { items: Inline[] }): React.JSX.Element {
  return (
    <>
      {items.map((it, i) => {
        if (it.kind === 'code') return <code key={i}>{it.text}</code>
        if (it.kind === 'bold') return <strong key={i}>{it.text}</strong>
        if (it.kind === 'link') {
          return (
            <a key={i} href={it.href} onClick={(e) => (e.preventDefault(), void api.system.openExternal(it.href))}>
              {it.text}
            </a>
          )
        }
        return <span key={i}>{it.text}</span>
      })}
    </>
  )
}

/** The small Markdown subset. All text is escaped by React. Only http and https links are links. */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks: Block[] = parseMarkdown(text)
  return (
    <div className="md">
      {blocks.map((b, i) => {
        if (b.kind === 'heading') {
          const Tag = `h${Math.min(6, b.level)}` as 'h3'
          return (
            <Tag key={i}>
              <Inlines items={b.inline} />
            </Tag>
          )
        }
        if (b.kind === 'list') {
          return (
            <ul key={i}>
              {b.items.map((it, j) => (
                <li key={j}>
                  <Inlines items={it} />
                </li>
              ))}
            </ul>
          )
        }
        return (
          <p key={i}>
            {b.lines.map((l, j) => (
              <span key={j}>
                {j > 0 && <br />}
                <Inlines items={l} />
              </span>
            ))}
          </p>
        )
      })}
    </div>
  )
}
