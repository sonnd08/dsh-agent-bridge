import test from 'node:test'
import assert from 'node:assert/strict'
import { completedPrefix, forkedLink, mergeUnlistedForks } from '../src/fork.ts'
import { mergeLinkedMessages, readableCatchup, renderCatchup } from '../src/links.ts'

const message = (id, role, type = 'text') => ({ id, role, blocks: [type === 'text' ? { type, text: id } : { type: 'tool_result', text: id, forId: 'x' }] })

test('fork: a running turn is left out at its opening user message', () => {
  const messages = [message('u1', 'user'), message('a1', 'assistant'), message('u2', 'user'), message('a2', 'assistant'), message('r2', 'user', 'tool_result')]
  assert.deepEqual(completedPrefix(messages, 'u2'), { upToMessageId: 'a1' })
})

test('fork: a first turn has no completed prefix', () => {
  assert.equal(completedPrefix([message('u1', 'user'), message('a1', 'assistant')], 'u1'), undefined)
  assert.equal(completedPrefix([], 'u1'), undefined)
})

test('fork: a running turn that is not written yet copies the completed turns', () => {
  assert.deepEqual(completedPrefix([message('u1', 'user'), message('a1', 'assistant')], 'u2'), {})
})

test('fork: a saved fork stays in the list until the engine lists it', () => {
  const row = (id, title) => ({ id, title, cwd: '/w', updatedAt: 1 })
  assert.deepEqual(mergeUnlistedForks([row('a', 'A')], [row('f', 'F')]), { rows: [row('a', 'A'), row('f', 'F')], unlisted: [row('f', 'F')] })
  assert.deepEqual(mergeUnlistedForks([row('f', 'listed')], [row('f', 'F')]), { rows: [row('f', 'listed')], unlisted: [] })
})

const link = {
  threads: { claude: 'claude:a', codex: 'codex:b' },
  active: 'codex:b',
  delivered: { 'claude:a': 'a2', 'codex:b': 'gone' },
  segments: [{ thread: 'claude:a', through: 'a2' }],
}
const sources = {
  'claude:a': [message('a1', 'user'), message('a2', 'assistant')],
  'codex:b': [message('b1', 'user'), message('b2', 'assistant')],
}
const copies = {
  'claude:c': [message('c1', 'user'), message('c2', 'assistant')],
  'codex:d': [message('b1', 'user'), message('b2', 'assistant')],
}
const forks = { 'claude:a': 'claude:c', 'codex:b': 'codex:d' }

test('fork: the link of a fork names the new threads and moves positions', () => {
  assert.deepEqual(forkedLink(link, forks, sources, copies), {
    threads: { claude: 'claude:c', codex: 'codex:d' },
    active: 'codex:d',
    delivered: { 'claude:c': 'c2' },
    segments: [{ thread: 'claude:c', through: 'c2' }],
  })
})

test('fork: the merged transcript of a fork has the same order as the source', () => {
  const source = mergeLinkedMessages(link, 'codex:b', sources)
  const copy = mergeLinkedMessages(forkedLink(link, forks, sources, copies), 'codex:d', copies)
  assert.deepEqual(copy.map(item => item.role), source.map(item => item.role))
  assert.deepEqual(copy.map(item => item.id), ['c1', 'c2', 'b1', 'b2'])
  assert.equal(copy[2].switchedTo, 'codex')
})

test('fork: a segment that cannot be placed keeps the rest of its thread', () => {
  const unplaced = { ...link, segments: [{ thread: 'claude:a', through: 'gone' }] }
  const result = forkedLink(unplaced, forks, sources, copies)
  assert.deepEqual(result.segments, [{ thread: 'claude:c', through: '' }])
  assert.deepEqual(mergeLinkedMessages(result, 'codex:d', copies).map(item => item.id), ['c1', 'c2', 'b1', 'b2'])
})

test('catch-up: each reply names the provider that wrote it, and the readable form has no tags', () => {
  const messages = [message('hello', 'user'), message('from claude', 'assistant'), { ...message('next', 'user'), switchedTo: 'codex' }, message('from codex', 'assistant')]
  const block = renderCatchup('claude', messages, false)
  assert.match(block, /Claude Code: from claude/)
  assert.match(block, /Codex: from codex/)
  assert.match(block, /switched to you from Codex/)
  const readable = readableCatchup(block)
  assert.ok(readable.startsWith('---\nThe user switched'))
  assert.ok(!readable.includes('agent-bridge-catchup'))
  assert.equal(readableCatchup(''), '')
})
