import test from 'node:test'
import assert from 'node:assert/strict'
import { isQuiet, MIRROR_QUIET_MS, nextReplay } from '../src/mirror.ts'
import { allTurns } from '../src/dsh-import.ts'

const say = (role, text) => ({ id: text, role, blocks: [{ type: 'text', text }] })

test('mirror: a chat waits until its file is quiet', () => {
  assert.equal(isQuiet(1000, 1000 + MIRROR_QUIET_MS - 1), false)
  assert.equal(isQuiet(1000, 1000 + MIRROR_QUIET_MS), true)
})

test('mirror: the next turn is the first that the DSH chat has not shown', () => {
  const turns = allTurns([say('user', 'a'), say('assistant', 'b'), say('user', 'c'), say('assistant', 'd'), say('assistant', 'e')])
  assert.equal(turns.length, 2)
  assert.deepEqual(nextReplay(1, turns), { user: 'c', assistant: 'd\n\ne', synced: 2 })
  assert.equal(nextReplay(2, turns), undefined)
})

test('mirror: a turn with no reply text is passed over', () => {
  const turns = allTurns([say('user', 'a'), say('user', 'b'), say('assistant', 'c')])
  assert.deepEqual(nextReplay(0, turns), { user: 'b', assistant: 'c', synced: 2 })
})

test('mirror: a note that Claude Code adds to a message is left out', () => {
  const turns = allTurns([say('user', '<system-reminder>\nnote\n</system-reminder>\n\nmy question'), say('assistant', 'b'), say('user', '<system-reminder>only</system-reminder>')])
  assert.deepEqual(turns, [{ user: 'my question', assistant: 'b' }])
})
