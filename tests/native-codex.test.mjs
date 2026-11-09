import test from 'node:test'
import assert from 'node:assert/strict'
import { codexDriver, CodexTurnReader } from '../src/native-codex.ts'
import { CODEX_ROUTE } from '../src/native-routes.ts'

const sinkOf = (allow = true) => {
  const events = []
  const settled = []
  const asked = []
  return { events, settled, asked, sink: { push: event => events.push(event), settle: (id, outcome) => settled.push([id, outcome]), approve: (id) => { asked.push(id); return Promise.resolve(allow) }, onThread: () => {} } }
}
const reading = (allow = true) => {
  const parts = sinkOf(allow)
  const answers = []
  const reader = new CodexTurnReader(parts.sink, (id, value) => answers.push([id, value]))
  return { ...parts, answers, read: (method, params) => reader.read({ method, params }) }
}
const kinds = events => events.map(event => event.kind)

test('codex turn: reasoning and text are separate blocks', () => {
  const { events, read } = reading()
  read('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'why' })
  read('item/reasoning/textDelta', { itemId: 'r1', delta: ' more' })
  read('item/completed', { item: { id: 'r1', type: 'reasoning' } })
  read('item/agentMessage/delta', { itemId: 'm1', delta: 'answer' })
  assert.deepEqual(events, [{ kind: 'start', block: 'reasoning' }, { kind: 'delta', text: 'why' }, { kind: 'delta', text: ' more' }, { kind: 'stop' }, { kind: 'start', block: 'text' }, { kind: 'delta', text: 'answer' }])
})

test('codex turn: a new item closes the block that is open', () => {
  const { events, read } = reading()
  read('item/reasoning/textDelta', { itemId: 'r1', delta: 'x' })
  read('item/agentMessage/delta', { itemId: 'm1', delta: 'y' })
  assert.deepEqual(kinds(events), ['start', 'delta', 'stop', 'start', 'delta'])
})

test('codex turn: a message that came with no deltas is sent whole', () => {
  const { events, read } = reading()
  read('item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'whole' } })
  assert.deepEqual(events, [{ kind: 'start', block: 'text' }, { kind: 'delta', text: 'whole' }, { kind: 'stop' }])
})

test('codex turn: a streamed message is not sent twice', () => {
  const { events, read } = reading()
  read('item/agentMessage/delta', { itemId: 'm1', delta: 'hi' })
  read('item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'hi' } })
  read('item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'hi' } })
  assert.deepEqual(kinds(events), ['start', 'delta', 'stop'])
})

test('codex turn: an empty message adds no block', () => {
  const { events, read } = reading()
  read('item/completed', { item: { id: 'm1', type: 'agentMessage', text: '' } })
  read('item/completed', { item: { id: 'm2', type: 'agentMessage' } })
  assert.deepEqual(events, [])
})

test('codex turn: a tool closes the open text and ends the step', () => {
  const { events, read } = reading()
  read('item/agentMessage/delta', { itemId: 'm1', delta: 'hi' })
  read('item/started', { item: { id: 'c1', type: 'commandExecution', command: 'ls' } })
  assert.deepEqual(events.slice(2), [{ kind: 'stop' }, { kind: 'tool', id: 'c1', name: 'command', input: { command: 'ls' } }, { kind: 'step-end' }])
})

test('codex turn: a tool is reported once, when it starts and when it ends', () => {
  const { events, settled, read } = reading()
  read('item/started', { item: { id: 'c1', type: 'commandExecution', command: 'ls' } })
  read('item/completed', { item: { id: 'c1', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' } })
  assert.equal(events.filter(event => event.kind === 'tool').length, 1)
  assert.deepEqual(settled, [['c1', { text: 'ok', isError: false }]])
})

test('codex turn: a tool seen only at its end is still reported before its result', () => {
  const { events, settled, read } = reading()
  read('item/completed', { item: { id: 'c1', type: 'fileChange', status: 'completed', changes: [{ path: 'a.txt', diff: '+x' }] } })
  assert.deepEqual(events, [{ kind: 'tool', id: 'c1', name: 'fileChange', input: { paths: ['a.txt'] } }, { kind: 'step-end' }])
  assert.deepEqual(settled, [['c1', { text: 'a.txt\n+x', isError: false }]])
})

test('codex turn: a command fails on a bad status or a bad exit code', () => {
  const outcome = (item) => {
    const { settled, read } = reading()
    read('item/completed', { item: { id: 'c1', type: 'commandExecution', aggregatedOutput: 'out', ...item } })
    return settled[0][1].isError
  }
  assert.equal(outcome({ status: 'completed', exitCode: 0 }), false)
  assert.equal(outcome({ status: 'completed' }), false)
  assert.equal(outcome({ status: 'completed', exitCode: 2 }), true)
  assert.equal(outcome({ status: 'declined' }), true)
})

test('codex turn: a file change that did not complete is an error', () => {
  const { settled, read } = reading()
  read('item/completed', { item: { id: 'c1', type: 'fileChange', status: 'declined', changes: [] } })
  assert.equal(settled[0][1].isError, true)
})

test('codex turn: an MCP tool names its tool and gives its result or its error', () => {
  const { events, settled, read } = reading()
  read('item/completed', { item: { id: 'a', type: 'mcpToolCall', tool: 'lookup', arguments: { q: 1 }, result: { rows: 2 } } })
  read('item/completed', { item: { id: 'b', type: 'dynamicToolCall', tool: 'other', error: { message: 'no' } } })
  assert.deepEqual(events.filter(event => event.kind === 'tool').map(event => [event.name, event.input]), [['lookup', { q: 1 }], ['other', {}]])
  assert.deepEqual(settled, [['a', { text: '{"rows":2}', isError: false }], ['b', { text: '{"message":"no"}', isError: true }]])
})

test('codex turn: a web search shows its query', () => {
  const { events, read } = reading()
  read('item/started', { item: { id: 'w', type: 'webSearch', query: 'term' } })
  assert.deepEqual(events[0], { kind: 'tool', id: 'w', name: 'webSearch', input: { query: 'term' } })
})

test('codex turn: an item that is not a tool makes no tool event', () => {
  const { events, settled, read } = reading()
  read('item/started', { item: { id: 'p', type: 'plan' } })
  read('item/completed', { item: { id: 'p', type: 'plan' } })
  assert.deepEqual(events, [])
  assert.deepEqual(settled, [])
})

test('codex turn: long tool output is cut', () => {
  const { settled, read } = reading()
  read('item/completed', { item: { id: 'c', type: 'commandExecution', status: 'completed', aggregatedOutput: 'x'.repeat(30_000) } })
  assert.equal(settled[0][1].text.length, 20_001)
})

test('codex turn: token use counts cached input separately', () => {
  const { events, read } = reading()
  read('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 } } })
  read('thread/tokenUsage/updated', { tokenUsage: { last: { outputTokens: 1 } } })
  read('thread/tokenUsage/updated', { tokenUsage: {} })
  read('thread/tokenUsage/updated', {})
  assert.deepEqual(events, [{ kind: 'usage', input: 6, output: 2, cacheRead: 4, cacheWrite: 0 }, { kind: 'usage', input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }])
})

test('codex turn: an approval waits for DSH and answers what DSH decided', async () => {
  for (const allow of [true, false]) {
    const { asked, answers, read } = reading(allow)
    assert.equal(read('approval', { requestId: 'r1', itemId: 'c1', request: 'item/commandExecution/requestApproval' }), false)
    await Promise.resolve()
    assert.deepEqual(asked, ['c1'])
    assert.deepEqual(answers, [['r1', allow]])
  }
})

test('codex turn: a question from the engine is refused without asking DSH', () => {
  const { asked, answers, read } = reading()
  read('approval', { requestId: 'q1', itemId: 'x', request: 'item/tool/requestUserInput' })
  assert.deepEqual(asked, [])
  assert.deepEqual(answers, [['q1', false]])
})

test('codex turn: the end closes an open block and returns true', () => {
  const { events, read } = reading()
  read('item/agentMessage/delta', { itemId: 'm1', delta: 'hi' })
  assert.equal(read('turn/completed', { turn: { status: 'completed' } }), true)
  assert.deepEqual(kinds(events), ['start', 'delta', 'stop', 'done'])
  assert.equal(events.at(-1).error, undefined)
})

test('codex turn: a failed turn with no message has a default text', () => {
  const { events, read } = reading()
  read('turn/completed', { turn: { status: 'failed' } })
  assert.deepEqual(events, [{ kind: 'done', error: 'Codex failed this turn.' }])
})

test('codex turn: an interrupted turn ends with no error', () => {
  const { events, read } = reading()
  read('turn/completed', { turn: { status: 'interrupted' } })
  assert.deepEqual(events, [{ kind: 'done' }])
})

test('codex turn: other events do not end the turn', () => {
  const { events, read } = reading()
  assert.equal(read('turn/started', { turn: { id: 't' } }), false)
  assert.equal(read('something/else', {}), false)
  assert.deepEqual(events, [])
})

const engineOf = (change = {}) => {
  const listeners = new Map()
  const calls = []
  const engine = {
    prepareThread: (options) => { calls.push(['prepareThread', options]); return Promise.resolve('T1') },
    watch: (thread, listener) => { listeners.set(thread, listener); return () => { if (listeners.get(thread) === listener) listeners.delete(thread) } },
    start: (options) => { calls.push(['start', options]); return Promise.resolve('T1') },
    answer: (...args) => { calls.push(['answer', ...args]); return true },
    interrupt: (thread) => { calls.push(['interrupt', thread]); return Promise.resolve(true) },
    cleanTerminals: (thread) => { calls.push(['clean', thread]); return Promise.resolve() },
    ask: (...args) => { calls.push(['ask', ...args]); return Promise.resolve('reply') },
    ...change,
  }
  return { engine, calls, listeners }
}
const driverOf = engine => codexDriver({ route: CODEX_ROUTE, engine: () => engine, listModels: () => Promise.resolve([{ id: 'm', name: 'M', efforts: [] }]), home: () => '/home/user' })
const turnOf = (sink, change = {}) => ({ cwd: '/w', prompt: 'hi', model: 'm', sink, ...change })
const ACCESS = { approvalPolicy: 'untrusted', sandbox: 'danger-full-access' }

test('codex driver: it names its route and lists the models of the plugin', async () => {
  const driver = driverOf(engineOf().engine)
  assert.equal(driver.route, CODEX_ROUTE)
  assert.equal(driver.name, 'Codex')
  assert.deepEqual((await driver.listModels()).map(model => model.id), ['m'])
})

test('codex driver: a one-shot request uses the home folder', async () => {
  const { engine, calls } = engineOf()
  assert.equal(await driverOf(engine).oneShot('title', 'm'), 'reply')
  assert.deepEqual(calls, [['ask', '/home/user', 'title', 'm']])
})

test('codex driver: a new turn gets a thread, reports it and starts with the access of DSH', async () => {
  const { engine, calls } = engineOf()
  const threads = []
  const { sink } = sinkOf()
  await driverOf(engine).begin(turnOf({ ...sink, onThread: id => threads.push(id) }, { effort: 'high' }))
  assert.deepEqual(threads, ['T1'])
  assert.deepEqual(calls[0], ['prepareThread', { cwd: '/w', model: 'm', ...ACCESS }])
  assert.deepEqual(calls[1], ['start', { threadId: 'T1', cwd: '/w', text: 'hi', model: 'm', effort: 'high', ...ACCESS }])
})

test('codex driver: a turn in a known thread names that thread, and no effort is left out', async () => {
  const { engine, calls } = engineOf()
  await driverOf(engine).begin(turnOf(sinkOf().sink, { thread: 'old' }))
  assert.equal(calls[0][1].threadId, 'old')
  assert.equal('effort' in calls[1][1], false)
})

test('codex driver: the watch starts before the turn, and ends with the turn', async () => {
  let watchedAtStart = false
  const parts = engineOf({ start: () => { watchedAtStart = parts.listeners.has('T1'); return Promise.resolve('T1') } })
  const { events, sink } = sinkOf()
  await driverOf(parts.engine).begin(turnOf(sink))
  assert.equal(watchedAtStart, true)
  parts.listeners.get('T1')({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  assert.equal(parts.listeners.has('T1'), false)
  assert.deepEqual(events.at(-1), { kind: 'done' })
})

test('codex driver: a turn that cannot start ends with its error and stops the watch', async () => {
  const parts = engineOf({ start: () => Promise.reject(new Error('busy')) })
  const { events, sink } = sinkOf()
  const handle = await driverOf(parts.engine).begin(turnOf(sink))
  assert.deepEqual(events, [{ kind: 'done', error: 'busy' }])
  assert.equal(parts.listeners.has('T1'), false)
  assert.equal(typeof handle.interrupt, 'function')
})

test('codex driver: a thread that cannot start rejects', async () => {
  const { engine } = engineOf({ prepareThread: () => Promise.reject(new Error('no folder')) })
  await assert.rejects(driverOf(engine).begin(turnOf(sinkOf().sink)), /no folder/)
})

test('codex driver: Stop interrupts the thread of the turn', async () => {
  const { engine, calls } = engineOf()
  const handle = await driverOf(engine).begin(turnOf(sinkOf().sink))
  await handle.interrupt()
  assert.ok(calls.some(call => call[0] === 'interrupt' && call[1] === 'T1'))
})

test('codex driver: an approval is answered in the thread of the turn', async () => {
  const parts = engineOf()
  const { sink } = sinkOf(false)
  await driverOf(parts.engine).begin(turnOf(sink))
  parts.listeners.get('T1')({ method: 'approval', params: { requestId: 'r1', itemId: 'c1', request: 'item/commandExecution/requestApproval' } })
  await Promise.resolve()
  assert.deepEqual(parts.calls.at(-1), ['answer', 'T1', 'r1', { behavior: 'deny' }])
})

test('codex driver: an approved call answers allow', async () => {
  const parts = engineOf()
  await driverOf(parts.engine).begin(turnOf(sinkOf(true).sink))
  parts.listeners.get('T1')({ method: 'approval', params: { requestId: 'r1', itemId: 'c1', request: 'item/fileChange/requestApproval' } })
  await Promise.resolve()
  assert.deepEqual(parts.calls.at(-1), ['answer', 'T1', 'r1', { behavior: 'allow' }])
})
