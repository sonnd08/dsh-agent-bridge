import test from 'node:test'
import assert from 'node:assert/strict'
import { allTurns, importEvents, importImageSources, importTurns } from '../src/dsh-import.ts'
import { nextReplay } from '../src/mirror.ts'
import { toTranscript } from '../src/claude.ts'
import { buildTimeline } from '../src/client/timeline.ts'

const route = { provider: 'claude-code', model: 'opus' }
const image = n => `data:image/png;base64,aW1hZ2U${String(n)}`
const user = (id, ...blocks) => ({ id, role: 'user', blocks })
const assistant = (id, ...blocks) => ({ id, role: 'assistant', blocks })
const text = value => ({ type: 'text', text: value })
const img = n => ({ type: 'image', src: image(n) })
const use = (id, name = 'Bash', args = { command: 'ls' }) => ({ type: 'tool_use', id, name, input: '', args })
const result = (forId, value, extra = {}) => ({ type: 'tool_result', forId, text: value, ...extra })
const saved = (...numbers) => new Map(numbers.map(n => [image(n), { attachmentId: `a${String(n)}` }]))
const eventsOf = (seed, type) => seed.filter(event => event.type === type)

test('transcript: a Claude image block is kept as an image, and not as [image] text', () => {
  const [message] = toTranscript([{ type: 'user', uuid: 'u', message: { role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
    { type: 'text', text: 'see this' },
  ] } }])
  assert.deepEqual(message.blocks, [{ type: 'image', src: 'data:image/jpeg;base64,QUJD' }, { type: 'text', text: 'see this' }])
})

test('transcript: an image with no bytes stays as a short note', () => {
  const [message] = toTranscript([{ type: 'user', uuid: 'u', message: { role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'f' } }] } }])
  assert.deepEqual(message.blocks, [{ type: 'text', text: '[image]' }])
})

test('timeline: an attached image is a drawn item', () => {
  assert.deepEqual(buildTimeline([user('u', img(1))])[0].items, [{ kind: 'image', src: image(1) }])
})

test('turns: the local path note of an image is removed, and a note with no image stays', () => {
  const note = text('[Image: source: /tmp/private/1.png]')
  assert.deepEqual(allTurns([user('u', img(1), note, text('what happens?'))]), [{ user: 'what happens?', assistant: '', images: [image(1)] }])
  assert.equal(allTurns([user('u', note)])[0].user, '[Image: source: /tmp/private/1.png]')
})

test('turns: a message with only an image starts a turn, so the old turn counts stay correct', () => {
  const turns = allTurns([user('1', img(1)), assistant('2', text('seen')), user('3', text('next'))])
  assert.equal(turns.length, 2)
  assert.deepEqual(turns[0], { user: '', assistant: 'seen', images: [image(1)] })
})

test('turns: a tool result is not a turn, and a reply with no tool has no steps', () => {
  const turns = allTurns([user('1', text('go')), assistant('2', use('a')), user('3', result('a', 'out')), assistant('4', text('done')), user('5', text('hi')), assistant('6', text('hello'))])
  assert.equal(turns.length, 2)
  assert.equal(turns[0].assistant, 'done')
  assert.deepEqual(turns[1], { user: 'hi', assistant: 'hello' })
})

test('turns: steps keep the order of text and tool calls, and each call has its result and images', () => {
  const [turn] = allTurns([
    user('1', text('go')),
    assistant('2', text('first'), use('a'), use('b', 'Read', { file_path: 'x' })),
    user('3', result('a', 'out a'), result('b', 'bad', { isError: true, images: [image(2)] })),
    assistant('4', text('second')),
  ])
  assert.deepEqual(turn.steps, [
    { text: 'first', tools: [
      { id: 'a', name: 'Bash', input: { command: 'ls' }, output: 'out a', isError: false },
      { id: 'b', name: 'Read', input: { file_path: 'x' }, output: 'bad', isError: true, images: [image(2)] },
    ] },
    { text: 'second', tools: [] },
  ])
})

test('turns: a repeated tool call is kept one time', () => {
  const [turn] = allTurns([user('1', text('go')), assistant('2', use('a')), assistant('3', use('a'))])
  assert.equal(turn.steps[0].tools.length, 1)
})

test('turns: a long tool output is cut', () => {
  const [turn] = allTurns([user('1', text('go')), assistant('2', use('a')), user('3', result('a', 'x'.repeat(9000)))])
  assert.equal(turn.steps[0].tools[0].output.length, 8001)
})

test('replay: a turn from outside DSH carries its images and steps', () => {
  const turns = allTurns([user('1', img(1), text('go')), assistant('2', use('a')), user('3', result('a', 'out')), assistant('4', text('done'))])
  const replay = nextReplay(0, turns)
  assert.deepEqual(replay.images, [image(1)])
  assert.equal(replay.steps.length, 2)
})

test('seed: a user image becomes an image block with its saved reference', () => {
  const seed = importEvents([user('1', img(1), text('see')), assistant('2', text('ok'))], route, 5, saved(1))
  assert.deepEqual(eventsOf(seed, 'user/message')[0].data.content, [{ type: 'text', text: 'see' }, { type: 'image', attachment: { attachmentId: 'a1' } }])
})

test('seed: an image that was not saved stays as a short note, and an empty message is valid', () => {
  const seed = importEvents([user('1', img(1)), assistant('2', text('ok'))], route, 5)
  assert.deepEqual(eventsOf(seed, 'user/message')[0].data.content, [{ type: 'text', text: '[image]' }])
})

test('seed: tool steps use the DSH event order, and seq numbers stay contiguous', () => {
  const seed = importEvents([
    user('1', text('go')),
    assistant('2', text('first'), use('a')),
    user('3', result('a', 'out', { images: [image(2)] })),
    assistant('4', text('done')),
  ], route, 5, saved(2))
  assert.deepEqual(seed.map(event => event.type), [
    'turn/start', 'step/start', 'system/message', 'user/message', 'request/header',
    'assistant/message', 'tool/call', 'tool/result', 'step/end',
    'step/start', 'assistant/message', 'step/end', 'turn/end',
  ])
  assert.deepEqual(seed.map(event => event.seq), seed.map((_, index) => index))
  const call = eventsOf(seed, 'tool/call')[0]
  const answer = eventsOf(seed, 'tool/result')[0]
  assert.deepEqual(JSON.parse(call.data.arguments), { tool: 'Bash', input: { command: 'ls' } })
  assert.equal(call.data.name, 'engine_tool')
  assert.deepEqual(answer.sourceEventSeqs, [call.seq])
  assert.equal(answer.surfaceOp, 'append')
  assert.equal(answer.data.message.toolCallId, 'a')
  assert.deepEqual(answer.data.message.content, [{ type: 'text', text: 'out' }, { type: 'image', attachment: { attachmentId: 'a2' } }])
  assert.deepEqual(eventsOf(seed, 'assistant/message')[0].data.message.content.map(block => block.type), ['text', 'tool-call'])
  assert.deepEqual([eventsOf(seed, 'step/end')[0].data.step, eventsOf(seed, 'step/end')[1].data.step], [1, 2])
})

test('seed: a failed call is an error, and a call with no result is still answered', () => {
  const seed = importEvents([user('1', text('go')), assistant('2', use('a'), use('b')), user('3', result('a', 'boom', { isError: true }))], route, 5)
  const [failed, open] = eventsOf(seed, 'tool/result').map(event => event.data.message)
  assert.equal(failed.isError, true)
  assert.deepEqual(failed.content, [{ type: 'text', text: 'Error: boom' }])
  assert.deepEqual(open.content, [{ type: 'text', text: '(no output)' }])
})

test('seed: a result with only an image has no empty text', () => {
  const seed = importEvents([user('1', text('go')), assistant('2', use('a')), user('3', result('a', '', { images: [image(2)] }))], route, 5, saved(2))
  assert.deepEqual(eventsOf(seed, 'tool/result')[0].data.message.content, [{ type: 'image', attachment: { attachmentId: 'a2' } }])
})

test('seed: old turns keep their text when the tool calls do not fit', () => {
  const messages = []
  for (let index = 0; index < 60; index += 1) {
    messages.push(user(`u${String(index)}`, text(`turn ${String(index)}`)), assistant(`a${String(index)}`, text(`reply ${String(index)}`), use(`t${String(index)}`)), user(`r${String(index)}`, result(`t${String(index)}`, 'x'.repeat(8000))))
  }
  const seed = importEvents(messages, route, 5)
  assert.equal(importTurns(messages).length, 60)
  assert.equal(eventsOf(seed, 'turn/start').length, 60)
  const calls = eventsOf(seed, 'tool/call')
  assert.ok(calls.length > 0 && calls.length < 60)
  assert.equal(calls.at(-1).data.callId, 't59')
  assert.deepEqual(eventsOf(seed, 'assistant/message')[0].data.message.content, [{ type: 'text', text: 'reply 0' }])
})

test('images: only the newest images are saved, with no repeat, and old tool images are left out', () => {
  const messages = []
  for (let index = 0; index < 150; index += 1) messages.push(user(`u${String(index)}`, img(index), text('x')), assistant(`a${String(index)}`, text('y')))
  messages.push(user('again', img(149), text('same')), assistant('end', text('z')))
  const sources = importImageSources(messages)
  assert.equal(sources.length, 100)
  assert.equal(sources[0], image(149))
  assert.equal(new Set(sources).size, 100)
  assert.ok(!sources.includes(image(0)))
})

test('images: tool images of the kept turns are included', () => {
  const sources = importImageSources([user('1', img(1), text('go')), assistant('2', use('a')), user('3', result('a', 'out', { images: [image(2)] })), assistant('4', text('done'))])
  assert.deepEqual(sources, [image(2), image(1)])
})
