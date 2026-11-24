import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renameReview, reviewDir } from '../src/main/services/reviews'

let root: string

const FULL = {
  title: 'Old name',
  mrs: [{ provider: 'github', host: 'github.com', projectPath: 'acme/widgets', iid: 9 }],
  skipped: [{ key: 'team/other!7', url: 'https://gitlab.com/team/other/-/merge_requests/7', title: 'T7', reason: 'no local clone in the workspace' }],
  issues: ['LX-2813', 'LX-9'],
  futureField: { nested: [1, 2, 3] }
}

function seed(slug: string, content: unknown): string {
  mkdirSync(reviewDir(root, slug), { recursive: true })
  const file = join(reviewDir(root, slug), 'review.json')
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return file
}

const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8'))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codediff-rename-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('renameReview', () => {
  it('sets the title and keeps every other field, also the ones this version does not know', async () => {
    // Arrange
    const file = seed('R-1', FULL)

    // Act
    const result = await renameReview(root, 'R-1', 'Login fix')

    // Assert
    expect(result).toEqual({ ok: true, value: { title: 'Login fix' } })
    expect(read(file)).toEqual({ ...FULL, title: 'Login fix' })
  })

  it('sets a title on a review that had none', async () => {
    const file = seed('R-2', { mrs: [], skipped: [], issues: ['LX-1'] })
    expect(await renameReview(root, 'R-2', 'Named')).toEqual({ ok: true, value: { title: 'Named' } })
    expect(read(file)).toEqual({ title: 'Named', mrs: [], skipped: [], issues: ['LX-1'] })
  })

  it('trims the title and returns the trimmed text', async () => {
    const file = seed('R-3', FULL)
    expect(await renameReview(root, 'R-3', '  \t Spaced out \n ')).toEqual({ ok: true, value: { title: 'Spaced out' } })
    expect(read(file).title).toBe('Spaced out')
  })

  it.each(['', '   ', '\n\t '])('refuses the empty title %j and keeps the old one', async (title) => {
    const file = seed('R-4', FULL)
    const result = await renameReview(root, 'R-4', title)
    expect(result.ok).toBe(false)
    expect(read(file)).toEqual(FULL)
  })

  it.each([
    [199, 199],
    [200, 200],
    [201, 200],
    [500, 200]
  ])('a title of %i characters is saved with %i', async (length, saved) => {
    const file = seed('R-5', FULL)
    const result = await renameReview(root, 'R-5', 'n'.repeat(length))
    expect(result).toEqual({ ok: true, value: { title: 'n'.repeat(saved) } })
    expect(read(file).title).toBe('n'.repeat(saved))
  })

  it('returns an error for a review that does not exist and creates nothing', async () => {
    const result = await renameReview(root, 'nope', 'Name')
    expect(result.ok).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  it('returns an error for a corrupt review.json and does not overwrite it', async () => {
    const file = seed('R-6', '{"title": "Old", "mrs": [')
    const result = await renameReview(root, 'R-6', 'New')
    expect(result.ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{"title": "Old", "mrs": [')
  })

  it('refuses a slug that is not a slug', async () => {
    seed('R-7', FULL)
    const result = await renameReview(root, '../R-7', 'Name')
    expect(result.ok).toBe(false)
  })

  it('keeps the last of two renames in a row, and also of two at the same time', async () => {
    const file = seed('R-8', FULL)
    await renameReview(root, 'R-8', 'First')
    await renameReview(root, 'R-8', 'Second')
    expect(read(file)).toEqual({ ...FULL, title: 'Second' })
    await Promise.all([renameReview(root, 'R-8', 'Third'), renameReview(root, 'R-8', 'Fourth')])
    const after = read(file)
    expect(['Third', 'Fourth']).toContain(after.title)
    expect(after).toEqual({ ...FULL, title: after.title })
  })

  it('never changes the folder name or leaves a temporary file behind', async () => {
    seed('R-9', FULL)
    await renameReview(root, 'R-9', 'A very different name')
    expect(readdirSync(reviewDir(root, 'R-9'))).toEqual(['review.json'])
    expect(readdirSync(join(root, '.code-diff', 'reviews'))).toEqual(['R-9'])
  })
})
