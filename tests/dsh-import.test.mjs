import test from 'node:test'
import assert from 'node:assert/strict'
import { importEvents, importTurns } from '../src/dsh-import.ts'

const text = (id, role, value) => ({ id, role, blocks: [{ type: 'text', text: value }] })
const route = { provider: 'p', model: 'm', reasoningEffort: 'medium' }

test('dsh import: replies of one turn join, and tool results do not start a turn', () => {
  const messages = [
    text('u1', 'user', 'hello'),
    text('a1', 'assistant', 'first'),
    { id: 'r1', role: 'user', blocks: [{ type: 'tool_result', text: 'output', forId: 'x' }] },
    { id: 'a2', role: 'assistant', blocks: [{ type: 'thinking', text: 'hidden' }, { type: 'text', text: 'second' }] },
    text('u2', 'user', 'next'),
  ]
  assert.deepEqual(importTurns(messages), [{ user: 'hello', assistant: 'first\n\nsecond' }, { user: 'next', assistant: '' }])
})

test('dsh import: the size limit keeps the newest turns', () => {
  const big = 'x'.repeat(300_000)
  const turns = importTurns([text('u1', 'user', `old${big}`), text('u2', 'user', `mid${big}`), text('u3', 'user', 'new')])
  assert.deepEqual(turns.map(turn => turn.user.slice(0, 3)), ['mid', 'new'])
})

test('dsh import: events are contiguous complete turns with one request header', () => {
  const events = importEvents([text('u1', 'user', 'hello'), text('a1', 'assistant', 'hi'), text('u2', 'user', 'again'), text('a2', 'assistant', 'yes')], route, 5)
  assert.deepEqual(events.map(event => event.type), [
    'turn/start', 'step/start', 'system/message', 'user/message', 'request/header', 'assistant/message', 'step/end', 'turn/end',
    'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
  ])
  assert.deepEqual(events.map(event => event.seq), events.map((_event, index) => index))
  assert.ok(events.every(event => event.time === 5))
  assert.deepEqual(events[4].data, { header: { config: route_config() }, reason: 'initial' })
  assert.equal(events[2].data.message.source.kind, 'system-prompt')
  assert.equal(events[3].surfaceOp, 'append')
  assert.equal(events[0].surfaceOp, undefined)
  const reply = events[11].data
  assert.equal(reply.turn, 2)
  assert.deepEqual(reply.stream, [])
  assert.deepEqual(reply.message.source, { kind: 'model', provider: 'p', model: 'm' })
  assert.equal(reply.message.role, 'assistant')
})

test('dsh import: a turn with no reply stays complete, and an empty transcript has no events', () => {
  assert.deepEqual(importEvents([text('u1', 'user', 'hello')], route, 1).map(event => event.type), ['turn/start', 'step/start', 'system/message', 'user/message', 'request/header', 'step/end', 'turn/end'])
  assert.deepEqual(importEvents([], route, 1), [])
})

function route_config() {
  return { provider: 'p', model: 'm', reasoningEffort: 'medium' }
}
