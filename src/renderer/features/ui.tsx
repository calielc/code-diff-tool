import { useEffect, useState, useSyncExternalStore } from 'react'
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

// The main process downloads the pictures and gives data URLs, because the content policy allows no remote images.
const pictures = new Map<string, string | null>()
const asked = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

/** Asks the main process once for each picture that was not asked for yet. The avatars re-render when the pictures arrive. */
export function useAvatars(people: Record<string, Person>): void {
  useEffect(() => {
    const urls = [...new Set(Object.values(people).flatMap((p) => (p.avatarUrl && !asked.has(p.avatarUrl) ? [p.avatarUrl] : [])))]
    if (urls.length === 0) return
    urls.forEach((u) => asked.add(u))
    void api.people.avatars(urls).then((found) => {
      Object.entries(found).forEach(([url, data]) => pictures.set(url, data))
      version++
      listeners.forEach((l) => l())
    })
  }, [people])
}

/** A round 22 px avatar with the picture when the main process has one, and the initials when not. */
export function Avatar(props: { user: string; people: Record<string, Person>; viewer: string }): React.JSX.Element {
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => version
  )
  const [failed, setFailed] = useState(false)
  const p = props.people[props.user]
  const name = p?.name || props.user
  const tip = `${name} (@${props.user})${props.user === props.viewer ? ', you' : ''}`
  const picture = p?.avatarUrl ? pictures.get(p.avatarUrl) : null
  return (
    <span className="avatar" data-user={props.user} title={tip} role="img" aria-label={tip}>
      {picture && !failed ? <img src={picture} alt="" draggable={false} onError={() => setFailed(true)} /> : initials(name)}
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
