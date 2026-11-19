import { adfToText, criteriaOf } from '@shared/adf'
import type { IssueAttachment, IssueComment, IssueData } from '@shared/issues'
import { restApi, type Credential } from './rest-api'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any> // Jira answers are read field by field

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export interface JiraAccess {
  site: string
  cred: Credential
}

export const browseUrl = (site: string, key: string): string => `https://${site}/browse/${key}`

const FIELDS = 'summary,issuetype,status,assignee,description,updated,attachment'

/** Read every comment, page by page. Each body is ADF. */
async function readComments(a: JiraAccess, key: string): Promise<IssueComment[]> {
  const out: IssueComment[] = []
  for (let startAt = 0; ;) {
    const page = (await restApi('jira', a.site, a.cred, `rest/api/3/issue/${key}/comment`, 'GET', { fields: { startAt, maxResults: 100 } })) as J
    const items = (Array.isArray(page.comments) ? page.comments : []) as J[]
    for (const c of items) out.push({ author: str(c.author?.displayName) || 'Someone', created: str(c.created), body: adfToText(c.body) })
    startAt += items.length
    if (items.length === 0 || startAt >= Number(page.total ?? 0)) return out
  }
}

/**
 * Read one issue. An issue that cannot be read becomes a row with the error and the review still opens
 * (file 01 section 3.8). Reading many issues runs in parallel, one call per issue.
 */
export async function readIssue(access: JiraAccess | null, key: string): Promise<IssueData> {
  const empty = (error: string, site?: string): IssueData => ({
    source: 'jira',
    key,
    url: site ? browseUrl(site, key) : null,
    type: null,
    title: key,
    status: null,
    assignee: null,
    description: '',
    criteria: [],
    error,
    updated: null,
    comments: [],
    attachments: []
  })
  if (!access) return empty('No Jira access is set up. Open Prerequisites and add your site and a token.')
  try {
    const issue = (await restApi('jira', access.site, access.cred, `rest/api/3/issue/${key}`, 'GET', { fields: { fields: FIELDS } })) as J
    const f = (issue.fields ?? {}) as J
    const comments = await readComments(access, key)
    const attachments: IssueAttachment[] = ((Array.isArray(f.attachment) ? f.attachment : []) as J[])
      .filter((a) => a.id !== undefined && a.id !== null && String(a.id) !== '') // an attachment with no id is dropped
      .map((a) => ({ id: String(a.id), filename: str(a.filename), mimeType: str(a.mimeType), size: typeof a.size === 'number' ? a.size : 0 }))
    return {
      source: 'jira',
      key,
      url: browseUrl(access.site, key),
      type: strOrNull(f.issuetype?.name),
      title: str(f.summary) || key,
      status: strOrNull(f.status?.name),
      assignee: strOrNull(f.assignee?.displayName),
      description: adfToText(f.description),
      criteria: criteriaOf(f.description),
      error: null,
      updated: strOrNull(f.updated),
      comments,
      attachments
    }
  } catch (e) {
    return empty(e instanceof Error ? e.message : String(e), access.site)
  }
}

/** Download one attachment's bytes (for the summary run). The call carries the same token. */
export async function downloadAttachment(access: JiraAccess, id: string): Promise<Buffer> {
  const bytes = await restApi('jira', access.site, access.cred, `rest/api/3/attachment/content/${id}`, 'GET', {}, 'bytes')
  return bytes as Buffer
}
