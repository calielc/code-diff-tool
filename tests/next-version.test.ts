import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bumpFor, bumpVersion, type Commit, draftVersion, highestTag, isConventionalTitle, parseSubject } from '../scripts/next-version.ts'

const commit = (subject: string, body = ''): Commit => ({ subject, body })

test('a subject gives its type and the breaking mark', () => {
  assert.deepEqual(parseSubject('feat: add a thing'), {
    type: 'feat',
    breaking: false
  })
  assert.deepEqual(parseSubject('fix(ui): mend it'), {
    type: 'fix',
    breaking: false
  })
  assert.deepEqual(parseSubject('feat!: change the format'), {
    type: 'feat',
    breaking: true
  })
  assert.deepEqual(parseSubject('refactor(core)!: move it'), {
    type: 'refactor',
    breaking: true
  })
  assert.equal(parseSubject('Merge pull request #4 from x/y'), undefined)
  assert.equal(parseSubject('add a thing'), undefined)
  assert.equal(parseSubject('feat:'), undefined)
})

test('feat gives minor, and every other type gives patch', () => {
  assert.equal(bumpFor([commit('feat: a')]), 'minor')
  assert.equal(bumpFor([commit('fix: a')]), 'patch')
  assert.equal(bumpFor([commit('perf: a')]), 'patch')
  for (const type of ['docs', 'test', 'chore', 'ci', 'build', 'style', 'refactor']) {
    assert.equal(bumpFor([commit(`${type}: a`)]), 'patch', type)
  }
  // No commit at all makes no release. A message in no known form still counts as a change.
  assert.equal(bumpFor([]), 'none')
  assert.equal(bumpFor([commit('update things')]), 'patch')
})

test('the biggest change wins', () => {
  assert.equal(bumpFor([commit('fix: a'), commit('feat: b'), commit('docs: c')]), 'minor')
  assert.equal(bumpFor([commit('chore: a'), commit('docs: b')]), 'patch')
  assert.equal(bumpFor([commit('feat: a'), commit('fix!: b')]), 'major')
})

test('a BREAKING CHANGE line in the body gives major', () => {
  assert.equal(bumpFor([commit('fix: a', 'Some text.\n\nBREAKING CHANGE: the file moved')]), 'major')
  assert.equal(bumpFor([commit('feat: a', 'BREAKING-CHANGE: the file moved')]), 'major')
  // The words inside a sentence are not a footer.
  assert.equal(bumpFor([commit('fix: a', 'This is not a BREAKING CHANGE: really.')]), 'patch')
})

test('a bump adds one step and resets the lower numbers', () => {
  assert.equal(bumpVersion('2.0.0', 'patch'), '2.0.1')
  assert.equal(bumpVersion('2.3.4', 'minor'), '2.4.0')
  assert.equal(bumpVersion('v2.3.4', 'major'), '3.0.0')
  assert.equal(bumpVersion('2.3.4', 'none'), '2.3.4')
  assert.throws(() => bumpVersion('two', 'patch'))
})

test('the highest release tag wins, by number and not by text', () => {
  assert.equal(highestTag(['v2.0.0', 'v2.10.0', 'v2.9.0']), 'v2.10.0')
  assert.equal(highestTag(['swift-v1', 'v1.0.0', 'v2.0.0-beta.1']), 'v1.0.0')
  assert.equal(highestTag(['swift-v1', '']), undefined)
  assert.equal(highestTag([]), undefined)
})

test('a title needs a known type and a description', () => {
  assert.equal(isConventionalTitle('feat: hide the panel'), true)
  assert.equal(isConventionalTitle('fix(ui)!: change it'), true)
  assert.equal(isConventionalTitle('chore: update deps'), true)
  assert.equal(isConventionalTitle('feature: hide the panel'), false)
  assert.equal(isConventionalTitle('Hide the panel'), false)
  assert.equal(isConventionalTitle(''), false)
})

test('a local build gets the next version with a draft mark', () => {
  assert.equal(draftVersion('2.1.0', 3), '2.1.0-draft.3')
  assert.equal(draftVersion('v2.0.0', 0), '2.0.0-draft.0')
})
