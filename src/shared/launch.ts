// A request from outside the app to start a new review: command line flags or a `codediff://new` link.
//
// Use the `--flag=value` form: Chromium moves switches in front of the other arguments when it hands a second start to a
// running app, which separates a `--mr` from the value after it.
//   "Code Diff Tool.exe" --mr=<url> --mr=<url> --issue=LX-1 --title=Card
//   codediff://new?mr=<url>&mr=<url>&issue=LX-1&title=Card
//
// With `--review=<slug>` (or `review=<slug>` in the link) the changes and issues are added to that review when it exists,
// and start a new review with that name when it does not.
//
// The request only fills in the New review form and runs the check. The reviewer presses Create, so a link from
// another program never makes a review or posts anything by itself.

export interface LaunchRequest {
  mrs: string[]
  issues: string[]
  title: string
  /** The slug of an existing review to add the changes and issues to. Empty to start a new review. */
  review: string
}

export const PROTOCOL = 'codediff'
const MAX_ITEMS = 50
const MAX_LEN = 2000

const clean = (v: string): string => v.trim().slice(0, MAX_LEN)

function fromLink(link: string): LaunchRequest | null {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  if (url.protocol !== `${PROTOCOL}:` || url.hostname !== 'new') return null
  return build(url.searchParams.getAll('mr'), url.searchParams.getAll('issue'), url.searchParams.get('title') ?? '', url.searchParams.get('review') ?? '')
}

function build(mrs: string[], issues: string[], title: string, review: string): LaunchRequest | null {
  const m = mrs.map(clean).filter(Boolean).slice(0, MAX_ITEMS)
  const i = issues.map(clean).filter(Boolean).slice(0, MAX_ITEMS)
  if (m.length === 0 && i.length === 0) return null
  return { mrs: m, issues: i, title: clean(title), review: clean(review) }
}

/** Read a launch request from the arguments of a process start. Returns null when the arguments hold none. */
export function parseLaunchRequest(argv: string[]): LaunchRequest | null {
  const mrs: string[] = []
  const issues: string[] = []
  let title = ''
  let review = ''
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n]
    if (a.startsWith(`${PROTOCOL}:`)) {
      const r = fromLink(a)
      if (r) return r
    } else if (a === '--mr' && argv[n + 1] !== undefined) mrs.push(argv[++n])
    else if (a === '--issue' && argv[n + 1] !== undefined) issues.push(argv[++n])
    else if (a === '--title' && argv[n + 1] !== undefined) title = argv[++n]
    else if (a.startsWith('--mr=')) mrs.push(a.slice(5))
    else if (a.startsWith('--issue=')) issues.push(a.slice(8))
    else if (a.startsWith('--title=')) title = a.slice(8)
    else if (a === '--review' && argv[n + 1] !== undefined) review = argv[++n]
    else if (a.startsWith('--review=')) review = a.slice(9)
  }
  return build(mrs, issues, title, review)
}
