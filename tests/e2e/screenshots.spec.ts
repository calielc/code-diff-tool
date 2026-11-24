import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SECTIONS_PROMPT_VERSION } from '../../src/shared/sections'
import { forgeEnv, startFakeForge, type FakeForge, type Fixture } from '../fakes/fake-forge'

// Takes screenshots of the main screens, to compare them with the design. Runs only with SHOTS=<folder>.
const out = process.env['SHOTS']
const main = join(__dirname, '../../out/main/index.js')
let forge: FakeForge | undefined
test.afterEach(async () => {
  await forge?.close()
  forge = undefined
})

const FILES: Record<string, [string | null, string | null]> = {
  '.config/tools.json': [
    '{\n  "tools": {\n    "ef": {\n      "version": "8.0.1",\n      "rollForward": false\n    }\n  }\n}\n',
    '{\n  "tools": {\n    "ef": {\n      "version": "8.0.1",\n      "rollForward": false\n    },\n    "kiota": {\n      "version": "1.34.1",\n      "commands": [\n        "kiota"\n      ],\n      "rollForward": false\n    }\n  }\n}\n'
  ],
  'docs/api-clients.md': [
    null,
    '# API clients\n\nThis service generates an API client for C# and for TypeScript.\n\n## Why a generated client\n\nA hand-written client drifts from the contract.\n'
  ],
  'ci/build-client.sh': [null, '#!/bin/sh\nset -e\nkiota generate\n'],
  'src/Api/Program.cs': [
    'using System;\n\nnamespace Api;\n\npublic class Program\n{\n    public static void Main() => Console.WriteLine("old");\n\n    /// <summary>The port that the service listens on.</summary>\n    public static int Port(string[] args) => args.Length > 0 ? int.Parse(args[0]) : 8080;\n}\n',
    'using System;\n\nnamespace Api;\n\npublic class Program\n{\n    public static void Main() => Console.WriteLine("new");\n\n    /// <summary>The port that the service listens on.</summary>\n    public static int Port(string[] args) => args.Length > 0 ? int.Parse(args[0]) : 8443;\n}\n'
  ],
  'src/Api/Old.cs': ['class Old {}\n', null],
  'test/Api.Tests/ProgramTests.cs': ['class T { }\n', 'class T\n{\n    void A() { }\n}\n'],
  'README.md': ['# Service\n', '# Service\n\nGenerated clients are published from CI.\n']
}

test('screenshots of the main screens', async () => {
  test.skip(!out, 'set SHOTS=<folder>')
  const base = mkdtempSync(join(tmpdir(), 'codediff-shots-'))
  const root = join(base, 'ws')
  const dir = join(root, 'backend', 'api-service')
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  const put = (p: string, text: string | null): void => {
    const full = join(dir, p)
    mkdirSync(dirname(full), { recursive: true })
    if (text === null) execFileSync('git', ['rm', '-q', '-f', p], { cwd: dir })
    else writeFileSync(full, text)
  }
  git('init', '-q')
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
  git('config', 'core.autocrlf', 'false')
  git('remote', 'add', 'origin', 'git@gitlab.com:team/backend/api-service.git')
  for (const [p, [before]] of Object.entries(FILES)) if (before !== null) put(p, before)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  for (const [p, [, after]] of Object.entries(FILES)) put(p, after)
  git('add', '-A')
  git('commit', '-q', '-m', 'head')
  const head = git('rev-parse', 'HEAD')

  const ud = join(base, 'ud')
  mkdirSync(ud)
  writeFileSync(join(ud, 'app-state.json'), JSON.stringify({ schemaVersion: 1, workspaceRoot: root, firstRunDone: true }))
  const P = encodeURIComponent('team/backend/api-service')
  const fixture: Fixture = {
    'GET user': { json: { username: 'sam' } },
    [`GET projects/${P}/merge_requests/104`]: {
      json: {
        web_url: 'https://gitlab.com/team/backend/api-service/-/merge_requests/104',
        state: 'merged',
        title: 'APP-101: Publish the generated API clients',
        description: 'Publishes both clients.',
        author: { username: 'sam' },
        source_branch: 'feat/APP-101-publish',
        target_branch: 'main',
        diff_refs: { base_sha: baseSha, start_sha: baseSha, head_sha: head }
      }
    },
    [`GET projects/${P}/merge_requests/104/approvals`]: { json: { approved_by: [], user_can_approve: false, user_has_approved: false } },
    [`GET projects/${P}/merge_requests/104/discussions`]: {
      json: [
        {
          id: 'a'.repeat(40),
          notes: [
            {
              id: 11,
              body: '**Suggestion**: this rollForward flag should stay false for the new tool.',
              resolvable: true,
              resolved: true,
              author: { username: 'ann', name: 'Ann Lee' },
              created_at: '2026-11-03T10:00:00Z',
              position: { new_path: '.config/tools.json', old_path: '.config/tools.json', new_line: 12 }
            },
            {
              id: 12,
              body: 'Agreed, done.',
              resolvable: true,
              resolved: true,
              author: { username: 'sam', name: 'Sam' },
              created_at: '2026-11-03T11:00:00Z',
              position: { new_path: '.config/tools.json', old_path: '.config/tools.json', new_line: 12 }
            }
          ]
        },
        {
          id: 'b'.repeat(40),
          notes: [
            {
              id: 13,
              body: 'Why a new tool here and not in the build script?',
              resolvable: true,
              resolved: false,
              author: { username: 'ann', name: 'Ann Lee' },
              created_at: '2026-11-03T12:00:00Z',
              position: { new_path: '.config/tools.json', old_path: '.config/tools.json', new_line: 7 }
            }
          ]
        },
        {
          id: 'c'.repeat(40),
          notes: [
            {
              id: 14,
              body: '**Section: The CI job builds and publishes the clients**\n\nShould the publish job run on main only?',
              resolvable: true,
              resolved: false,
              author: { username: 'ann', name: 'Ann Lee' },
              created_at: '2026-11-03T13:00:00Z'
            }
          ]
        }
      ]
    },
    [`GET projects/${P}/merge_requests/104/reviewers`]: { json: [] },
    'GET rest/api/3/issue/APP-101': {
      json: {
        key: 'APP-101',
        fields: {
          summary: 'Publish the generated API clients and use them',
          issuetype: { name: 'Task' },
          status: { name: 'Done' },
          assignee: { displayName: 'Sam Lee' },
          updated: '2026-11-10T10:00:00.000+0100',
          description: {
            type: 'doc',
            content: [
              { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
              {
                type: 'bulletList',
                content: [
                  { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A C# and a TypeScript package are published' }] }] }
                ]
              }
            ]
          },
          attachment: []
        }
      }
    },
    'GET rest/api/3/issue/APP-101/comment': { json: { total: 0, comments: [] } }
  }
  forge = await startFakeForge(fixture)
  // a saved page, so the Summarised tab has something to show
  const pageDir = join(root, '.code-diff', 'reviews', 'APP-101')
  mkdirSync(pageDir, { recursive: true })
  const K = 'backend/api-service!104'
  const page104 = {
    summary:
      'The service now builds an API client for C# and for TypeScript from its contract, and publishes both from two manual CI jobs. The change adds the tool, the job and a new entry point text.',
    sections: [
      {
        id: 'tools',
        title: 'A new tool generates the clients',
        text: 'The tool manifest gains the Kiota tool next to the Entity Framework tool. Every build machine now installs the same version, so the clients do not drift between a laptop and the pipeline.',
        snippets: [{ mr: K, path: '.config/tools.json', lines: [6, 13] }]
      },
      {
        id: 'ci',
        title: 'The CI job builds and publishes the clients',
        text: 'A new script runs the generator and stops at the first error. The two manual jobs call it, so a person decides when a new client version goes out.',
        snippets: [{ mr: K, path: 'ci/build-client.sh', lines: [1, 3] }]
      },
      {
        id: 'entry',
        title: 'The entry point changes, and an unused class goes away',
        text: 'Main prints the new text. The class Old had no caller left, so the change removes it.',
        snippets: [
          { mr: K, path: 'src/Api/Program.cs', lines: [7, 7] },
          { mr: K, path: 'src/Api/Old.cs', lines: [1, 1], side: 'old' }
        ]
      }
    ],
    restText: 'Two documents and a test class with an empty method. They hold no logic, so a quick look is enough.'
  }
  writeFileSync(join(pageDir, 'sections.json'), JSON.stringify(page104))
  writeFileSync(join(pageDir, 'sections-basis.json'), JSON.stringify({ issues: ['APP-101'], heads: { [K]: head }, version: SECTIONS_PROMPT_VERSION }))
  const rdir = join(root, '.code-diff', 'reviews', 'APP-101')
  mkdirSync(rdir, { recursive: true })
  writeFileSync(
    join(rdir, 'review.json'),
    JSON.stringify({
      title: 'APP-101: Publish the generated API clients and use them',
      mrs: [{ provider: 'gitlab', host: 'gitlab.com', projectPath: 'team/backend/api-service', iid: 104 }],
      skipped: [],
      issues: ['APP-101']
    })
  )
  const app = await electron.launch({
    args: [main],
    env: {
      ...process.env,
      CODEDIFF_USER_DATA: ud,
      ...forgeEnv(forge.url),
      FAKE_CLAUDE_ANSWER: JSON.stringify({
        checklist: [
          {
            ac: 'APP-101 AC1',
            state: 'partial',
            why: 'The jobs are manual and not part of deploy, but they sit in the dev stage.',
            evidence: [{ mr: 'backend/api-service!104', path: 'ci/build-client.sh', newLine: 2 }],
            comment: { mr: 'backend/api-service!104', path: 'ci/build-client.sh', newLine: 2, body: 'Publish only from main.' }
          }
        ]
      })
    } as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1600, height: 1000 })
  const shot = (name: string): Promise<Buffer> => page.screenshot({ path: join(out!, `${name}.png`) })
  await expect(page.getByRole('heading').first()).toBeVisible()
  await shot('home')
  await page.getByTestId('review-APP-101').dblclick()
  await expect(page.getByTestId('mrs-tab')).toBeVisible()
  await shot('code-changes')
  await page.getByTestId('tab-issues').click()
  await shot('issues')
  await page.getByTestId('tab-diff').click()
  await page
    .getByTestId('file-.config/tools.json')
    .click()
    .catch(() => undefined)
  await expect(page.getByTestId('diff-table').locator('[class*="tk-"]').first()).toBeVisible()
  await shot('diff')

  await page.setViewportSize({ width: 1600, height: 1500 }) // a tall window, so that the picture shows the index and several sections
  await page.getByTestId('tab-summarised').click()
  await expect(page.getByTestId('sections-view')).toBeVisible()
  await page.getByTestId('accept-tools').click() // an accepted section is collapsed to its header
  await expect(page.getByTestId('section-tools')).toHaveAttribute('data-collapsed', 'true')
  await expect(page.getByTestId('section-thread-ci').getByTestId('thread')).toBeVisible()
  await shot('summarised')
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.getByTestId('accept-tools').click() // undo, so the other pictures show no viewed file
  await page.getByTestId('tab-diff').click()
  await page.getByRole('button', { name: 'Linear', exact: true }).click()
  await page.getByTestId('layout-side').click()
  await page.getByTestId('file-src/Api/Program.cs').click()
  await expect(page.getByTestId('diff-table').locator('.tk-kw').first()).toBeVisible()
  await shot('side-by-side')
  await page.getByTestId('layout-full').click()
  await expect(page.getByTestId('diff-table').locator('.tk-kw').first()).toBeVisible()
  await shot('full-file')
  await page.getByTestId('layout-inline').click()
  await page.getByTestId('tab-ac').click()
  await shot('criteria-empty')
  await expect(page.getByTestId('ac-start')).toBeEnabled({ timeout: 20_000 })
  await page.getByTestId('ac-start').click()
  await expect(page.getByTestId('ac-title')).toHaveText('ACs validated', { timeout: 20_000 })
  await shot('criteria')
  await page.getByTestId('ai-pill').click()
  await shot('ai-review')
  await page.getByTestId('ai-pill').click()
  await page.getByTestId('tab-diff').click()
  await page.getByTestId('review-chat-button').click()
  await shot('chat')
  await app.close()
})
