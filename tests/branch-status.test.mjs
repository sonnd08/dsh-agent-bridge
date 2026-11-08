import test from 'node:test'
import assert from 'node:assert/strict'
import { BranchStatusReader, pullRequestState } from '../src/branch-status.ts'

function runner(answers) {
  const calls = []
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, ...args].join(' '))
      const key = Object.keys(answers).find(item => [command, ...args].join(' ').includes(item))
      if (key === undefined || answers[key] === undefined) throw new Error('failed')
      return answers[key]
    },
  }
}

const repository = { 'rev-parse': '/repo\n', 'symbolic-ref': 'origin/main\n', 'branch --show-current': 'feature\n' }

test('branch status: an open pull request wins over an older merged one', () => {
  assert.equal(pullRequestState([{ headRefName: 'a', state: 'MERGED' }, { headRefName: 'a', state: 'OPEN' }], 'a'), 'open')
  assert.equal(pullRequestState([{ headRefName: 'a', state: 'MERGED' }], 'a'), 'merged')
  assert.equal(pullRequestState([{ headRefName: 'a', state: 'CLOSED' }], 'a'), undefined)
  assert.equal(pullRequestState([{ headRefName: 'b', state: 'MERGED' }], 'a'), undefined)
})

test('branch status: a merged pull request names a squash-merged branch', async () => {
  const { run } = runner({ ...repository, 'pr list': JSON.stringify([{ headRefName: 'feature', state: 'MERGED', mergedAt: 'x' }]) })
  assert.equal(await new BranchStatusReader(run).read('/repo'), 'merged')
})

test('branch status: without a pull request, only unique commits prove not merged', async () => {
  const ahead = runner({ ...repository, 'pr list': '[]', 'rev-list': '3\n' })
  assert.equal(await new BranchStatusReader(ahead.run).read('/repo'), 'unmerged')
  const even = runner({ ...repository, 'pr list': '[]', 'rev-list': '0\n' })
  assert.equal(await new BranchStatusReader(even.run).read('/repo'), 'none')
})

test('branch status: the default branch, a folder outside Git and an option-like name have no state', async () => {
  assert.equal(await new BranchStatusReader(runner({ ...repository, 'branch --show-current': 'main\n' }).run).read('/repo'), 'none')
  assert.equal(await new BranchStatusReader(runner({}).run).read('/tmp'), 'none')
  assert.equal(await new BranchStatusReader(runner(repository).run).read('/repo', '--upload-pack=x'), 'none')
})

test('branch status: a recorded branch is used, and gh failure falls back to Git', async () => {
  const { run, calls } = runner({ 'rev-parse': '/repo', 'symbolic-ref': 'origin/main', 'rev-list': '1' })
  assert.equal(await new BranchStatusReader(run).read('/repo', 'other'), 'unmerged')
  assert.ok(!calls.some(call => call.includes('--show-current')))
  assert.ok(calls.some(call => call.includes('origin/main..refs/heads/other')))
})

test('branch status: a clone without origin/HEAD uses origin/main', async () => {
  const { run } = runner({ 'rev-parse --show-toplevel': '/repo', 'branch --show-current': 'feature', 'refs/remotes/origin/main': 'abc', 'pr list': '[]', 'rev-list': '2' })
  assert.equal(await new BranchStatusReader(run).read('/repo'), 'unmerged')
})

test('branch status: answers are cached and expire', async () => {
  let time = 0
  const { run, calls } = runner({ ...repository, 'pr list': '[]', 'rev-list': '1' })
  const reader = new BranchStatusReader(run, () => time)
  await reader.read('/repo')
  const first = calls.length
  await reader.read('/repo')
  assert.equal(calls.length, first)
  time = 200_000
  await reader.read('/repo')
  assert.ok(calls.length > first)
})
