import test from 'node:test'
import assert from 'node:assert/strict'
import { applySdkMessage, CLAUDE_PROVIDER, claudeDriver, createEngineHost, ENGINE_TOOL, turnInput } from '../src/native-engine.ts'
import { codexDriver } from '../src/native-codex.ts'
import { CODEX_ROUTE } from '../src/native-routes.ts'

const ROUTE = 'engine-route'
const KEY = `s|${ROUTE}`
const typed = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const reply = (id, provider, text) => ({ id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider } })
const request = (change = {}) => ({ provider: ROUTE, model: 'm', sessionId: 's', messages: [typed('1', 'hi')], ...change })
const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const settle = () => new Promise(resolve => { setImmediate(resolve) })
const types = chunks => chunks.map(chunk => chunk.type)

/** A host and a driver that plays the given run events for each turn. */
const harness = (play = () => {}, deps = {}) => {
  const log = { begins: [], interrupts: 0, saved: [], handoffs: [], realTurns: [] }
  let sink
  const driver = {
    route: ROUTE,
    name: 'Engine',
    listModels: () => Promise.resolve([]),
    oneShot: (prompt, model) => { log.oneShot = [prompt, model]; return Promise.resolve('short') },
    begin: (turn) => { log.begins.push(turn); sink = turn.sink; play(turn.sink, log.begins.length); return Promise.resolve({ interrupt: () => { log.interrupts += 1; return Promise.resolve() } }) },
  }
  const host = createEngineHost({ authorize: (...args) => (authorizeFor ?? (async () => true))(...args), cwdOf: () => '/w', threadOf: () => undefined, saveThread: (...args) => log.saved.push(args), writeHandoff: (...args) => { log.handoffs.push(args); return Promise.resolve('/h/file.md') }, onRealTurn: key => log.realTurns.push(key), ...deps })
  return { host, adapter: host.adapterFor(driver), driver, log, sink: () => sink }
}
let authorizeFor
test.afterEach(() => { authorizeFor = undefined })
const tool = (id, name = 'Bash', input = {}) => ({ kind: 'tool', id, name, input })
const proxy = (host, id, signal = new AbortController().signal) => host.executeProxy({}, { rootCallId: id, signal })

test('sdk messages: thinking, usage and the step end become events', () => {
  const events = []
  const run = { queue: { push: event => events.push(event) }, settle: () => {} }
  const stream = event => applySdkMessage({ type: 'stream_event', parent_tool_use_id: null, event }, run, () => {})
  stream({ type: 'content_block_start', content_block: { type: 'thinking' } })
  stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'why' } })
  stream({ type: 'content_block_stop' })
  stream({ type: 'message_start', message: { usage: { input_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } } })
  stream({ type: 'message_start', message: { usage: { input_tokens: 4 } } })
  stream({ type: 'message_delta', usage: { output_tokens: 5 } })
  stream({ type: 'message_stop' })
  assert.deepEqual(events, [
    { kind: 'start', block: 'reasoning' }, { kind: 'delta', text: 'why' }, { kind: 'stop' },
    { kind: 'usage', input: 3, output: 0, cacheRead: 1, cacheWrite: 2 }, { kind: 'usage', input: 4, output: 0, cacheRead: 0, cacheWrite: 0 },
    { kind: 'usage', input: 0, output: 5, cacheRead: 0, cacheWrite: 0 }, { kind: 'step-end' },
  ])
})

test('sdk messages: blocks and deltas of other kinds add nothing', () => {
  const events = []
  const run = { queue: { push: event => events.push(event) }, settle: () => {} }
  const stream = event => applySdkMessage({ type: 'stream_event', parent_tool_use_id: null, event }, run, () => {})
  stream({ type: 'content_block_start', content_block: { type: 'tool_use' } })
  stream({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } })
  assert.deepEqual(events, [])
})

test('sdk messages: a failed result reports its text or its list of errors', () => {
  const done = (message) => {
    const events = []
    applySdkMessage({ type: 'result', ...message }, { queue: { push: event => events.push(event) }, settle: () => {} }, () => {})
    return events
  }
  assert.deepEqual(done({ is_error: true, subtype: 'success', result: 'blocked' }), [{ kind: 'done', error: 'blocked' }])
  assert.deepEqual(done({ is_error: true, subtype: 'error_during_execution', errors: ['one', 'two'] }), [{ kind: 'done', error: 'one\ntwo' }])
  assert.deepEqual(done({ is_error: false, subtype: 'success', result: 'x' }), [{ kind: 'done' }])
})

test('sdk messages: a tool result can be text or blocks, and can be an error', () => {
  const settled = []
  const run = { queue: { push: () => {} }, settle: (id, outcome) => settled.push([id, outcome]) }
  const send = content => applySdkMessage({ type: 'user', parent_tool_use_id: null, message: { content } }, run, () => {})
  send([{ type: 'tool_result', tool_use_id: 'a', content: 'plain', is_error: true }])
  send([{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'x' }, { type: 'image' }, { type: 'text', text: 'y' }] }])
  send([{ type: 'tool_result', tool_use_id: 'c' }])
  send('a typed message')
  send([{ type: 'text', text: 'not a result' }])
  assert.deepEqual(settled, [['a', { text: 'plain', isError: true }], ['b', { text: 'x\ny', isError: false }], ['c', { text: '', isError: false }]])
})

test('sdk messages: a subagent result is left out', () => {
  const settled = []
  applySdkMessage({ type: 'user', parent_tool_use_id: 'agent', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] } }, { queue: { push: () => {} }, settle: (...args) => settled.push(args) }, () => {})
  assert.deepEqual(settled, [])
})

test('sdk messages: only the init message names the thread', () => {
  const threads = []
  const run = { queue: { push: () => {} }, settle: () => {} }
  applySdkMessage({ type: 'system', subtype: 'status', session_id: 'x' }, run, id => threads.push(id))
  applySdkMessage({ type: 'other' }, run, id => threads.push(id))
  assert.deepEqual(threads, [])
})

test('turn input: a message with no source is what the user typed', () => {
  assert.equal(turnInput([{ role: 'user', content: [{ type: 'text', text: 'a' }] }], ROUTE, false).text, 'a')
})

test('turn input: messages after the last reply are joined, and context is left out', () => {
  const context = { role: 'user', content: [{ type: 'text', text: 'ctx' }], source: { kind: 'runtime-context' } }
  assert.equal(turnInput([typed('1', 'a'), reply('2', ROUTE, 'b'), typed('3', 'c'), context, typed('4', 'd')], ROUTE, true).text, 'c\n\nd')
})

test('turn input: an engine tool call in the history shows the real tool', () => {
  const call = { id: 'x', role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: ENGINE_TOOL, arguments: JSON.stringify({ tool: 'Bash', input: { command: 'ls' } }) }, { type: 'tool-call', id: 't2', name: 'read', arguments: '{}' }], source: { kind: 'model', provider: 'other' } }
  const { unseen } = turnInput([typed('1', 'a'), call, typed('2', 'b')], ROUTE, false)
  assert.deepEqual(unseen[1].blocks, [{ type: 'tool_use', name: 'Bash', input: '', id: 't1', args: { command: 'ls' } }, { type: 'tool_use', name: 'read', input: '', id: 't2' }])
})

test('turn input: an empty reply is left out of what the engine has not seen', () => {
  const empty = { id: 'x', role: 'assistant', content: [{ type: 'reasoning' }], source: { kind: 'model', provider: 'other' } }
  assert.equal(turnInput([typed('1', 'a'), empty, typed('2', 'b')], ROUTE, false).unseen.length, 1)
})

test('stream: text becomes a block, with its parts and usage', async () => {
  const { adapter } = harness((sink) => {
    sink.push({ kind: 'usage', input: 3, output: 0, cacheRead: 1, cacheWrite: 2 })
    sink.push({ kind: 'start', block: 'text' })
    sink.push({ kind: 'delta', text: 'he' })
    sink.push({ kind: 'delta', text: 'llo' })
    sink.push({ kind: 'stop' })
    sink.push({ kind: 'usage', input: 1, output: 4, cacheRead: 0, cacheWrite: 0 })
    sink.push({ kind: 'done' })
  })
  assert.deepEqual(await collect(adapter.stream(request())), [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'he' },
    { type: 'text-delta', index: 0, text: 'llo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    { type: 'usage', usage: { inputTokens: 4, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('stream: reasoning uses reasoning deltas, and the next block has the next index', async () => {
  const { adapter } = harness((sink) => {
    sink.push({ kind: 'start', block: 'reasoning' })
    sink.push({ kind: 'delta', text: 'x' })
    sink.push({ kind: 'stop' })
    sink.push({ kind: 'start', block: 'text' })
    sink.push({ kind: 'stop' })
    sink.push({ kind: 'done' })
  })
  const chunks = await collect(adapter.stream(request()))
  assert.deepEqual(chunks[1], { type: 'reasoning-delta', index: 0, text: 'x' })
  assert.deepEqual(chunks[3], { type: 'block-start', index: 1, blockType: 'text' })
})

test('stream: text with no open block is dropped', async () => {
  const { adapter } = harness((sink) => {
    sink.push({ kind: 'delta', text: 'lost' })
    sink.push({ kind: 'stop' })
    sink.push({ kind: 'done' })
  })
  assert.deepEqual(types(await collect(adapter.stream(request()))), ['usage', 'finish'])
})

test('stream: an engine error stops the turn with its text', async () => {
  const { adapter, host } = harness(sink => sink.push({ kind: 'done', error: 'Rate limit reached' }))
  await assert.rejects(collect(adapter.stream(request())), /^Error: Rate limit reached$/)
  assert.equal(host.isActive(KEY), false)
})

test('stream: a signed-out engine tells the user what to do', async () => {
  const { adapter } = harness(sink => sink.push({ kind: 'done', error: 'Not logged in · Please run /login' }))
  await assert.rejects(collect(adapter.stream(request())), /Engine is not signed in\. Select Sign in above the message box/)
})

test('stream: a failure to start the engine rejects the turn and keeps nothing active', async () => {
  const { host } = harness()
  const adapter = host.adapterFor({ route: ROUTE, name: 'Engine', listModels: () => Promise.resolve([]), oneShot: () => Promise.resolve(''), begin: () => Promise.reject(new Error('no process')) })
  await assert.rejects(collect(adapter.stream(request())), /no process/)
  assert.equal(host.isActive(KEY), false)
})

test('stream: a tool ends the step with the proxy tool', async () => {
  const { adapter, host } = harness((sink) => {
    sink.push({ kind: 'start', block: 'text' })
    sink.push({ kind: 'stop' })
    sink.push(tool('c1', 'Bash', { command: 'ls' }))
    sink.push({ kind: 'step-end' })
  })
  const chunks = await collect(adapter.stream(request()))
  assert.deepEqual(chunks.slice(2), [
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: ENGINE_TOOL, arguments: JSON.stringify({ tool: 'Bash', input: { command: 'ls' } }) } },
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
  assert.equal(host.isActive(KEY), true)
})

test('stream: several tools of one step share the step', async () => {
  const { adapter } = harness((sink) => {
    sink.push(tool('c1'))
    sink.push(tool('c2'))
    sink.push({ kind: 'step-end' })
  })
  const chunks = await collect(adapter.stream(request()))
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => [chunk.index, chunk.block.id]), [[0, 'c1'], [1, 'c2']])
})

test('stream: a tool reported after the step end closes the step', async () => {
  const { adapter } = harness((sink) => {
    sink.push({ kind: 'step-end' })
    sink.push(tool('c1'))
  })
  assert.deepEqual((await collect(adapter.stream(request()))).at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('stream: a step with no tool does not end the turn', async () => {
  const { adapter, sink } = harness(events => events.push({ kind: 'step-end' }))
  const pending = collect(adapter.stream(request()))
  await settle()
  sink().push({ kind: 'done' })
  assert.deepEqual((await pending).at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('stream: the next step of a turn continues the same run', async () => {
  const { adapter, sink, log } = harness((events, count) => { if (count === 1) { events.push(tool('c1')); events.push({ kind: 'step-end' }) } })
  await collect(adapter.stream(request()))
  sink().push({ kind: 'start', block: 'text' })
  sink().push({ kind: 'stop' })
  sink().push({ kind: 'done' })
  assert.deepEqual(types(await collect(adapter.stream(request()))), ['block-start', 'block-end', 'usage', 'finish'])
  assert.equal(log.begins.length, 1)
})

test('stream: the next step refuses a tool call that DSH did not run', async () => {
  const { adapter, sink } = harness((events) => { events.push(tool('c1')); events.push({ kind: 'step-end' }) })
  await collect(adapter.stream(request()))
  const decision = sink().approve('c1')
  const next = adapter.stream(request())[Symbol.asyncIterator]().next()
  assert.equal(await decision, false)
  sink().push({ kind: 'done' })
  await next
})

test('stream: a real turn is reported once, and not for its next step', async () => {
  const { adapter, log, sink } = harness((events) => { events.push(tool('c1')); events.push({ kind: 'step-end' }) })
  await collect(adapter.stream(request()))
  sink().push({ kind: 'done' })
  await collect(adapter.stream(request()))
  assert.deepEqual(log.realTurns, [KEY])
})

test('stream: the engine gets the folder, the model, the effort and the known thread', async () => {
  const { adapter, log } = harness(sink => sink.push({ kind: 'done' }), { threadOf: key => key === KEY ? 'old-thread' : undefined })
  await collect(adapter.stream(request({ reasoningEffort: 'high' })))
  const { sink: _sink, ...turn } = log.begins[0]
  assert.deepEqual(turn, { thread: 'old-thread', cwd: '/w', prompt: 'hi', model: 'm', effort: 'high' })
})

test('stream: a turn with no thread or effort names none', async () => {
  const { adapter, log } = harness(sink => sink.push({ kind: 'done' }))
  await collect(adapter.stream(request()))
  assert.equal('thread' in log.begins[0], false)
  assert.equal('effort' in log.begins[0], false)
})

test('stream: the thread of the engine is saved under the session and route', async () => {
  const { adapter, log } = harness((sink) => { sink.onThread('new-thread'); sink.push({ kind: 'done' }) })
  await collect(adapter.stream(request()))
  assert.deepEqual(log.saved, [[KEY, 'new-thread']])
})

test('stream: messages of another model go to the engine through a file', async () => {
  const { adapter, log } = harness(sink => sink.push({ kind: 'done' }))
  await collect(adapter.stream(request({ messages: [typed('1', 'a'), reply('2', 'other', 'b'), typed('3', 'c')] })))
  assert.equal(log.handoffs.length, 1)
  assert.equal(log.handoffs[0][0], 's')
  assert.match(log.handoffs[0][1], /b/)
  assert.match(log.begins[0].prompt, /\/h\/file\.md/)
  assert.ok(log.begins[0].prompt.includes('c'))
})

test('stream: with nothing unseen the prompt is what the user typed', async () => {
  const { adapter, log } = harness(sink => sink.push({ kind: 'done' }), { threadOf: () => 'thread' })
  await collect(adapter.stream(request({ messages: [typed('1', 'a'), reply('2', ROUTE, 'b'), typed('3', 'c')] })))
  assert.equal(log.begins[0].prompt, 'c')
  assert.deepEqual(log.handoffs, [])
})

test('stream: a request with a purpose or no session is one short answer', async () => {
  for (const change of [{ purpose: 'title' }, { sessionId: undefined }]) {
    const { adapter, log } = harness()
    const chunks = await collect(adapter.stream(request({ ...change, messages: [typed('1', 'a'), { role: 'user', content: [] }, typed('2', 'b')] })))
    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'short' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'short' } }, { type: 'finish', reason: { kind: 'stop' } },
    ])
    assert.deepEqual(log.oneShot, ['a\n\nb', 'm'])
    assert.deepEqual(log.begins, [])
    assert.deepEqual(log.realTurns, [])
  }
})

test('replay: a message that is not the armed turn runs the engine, and the arm is used up', async () => {
  const { adapter, host, log } = harness(sink => sink.push({ kind: 'done' }))
  host.armReplay(KEY, { user: 'written outside', assistant: 'reply outside' })
  await collect(adapter.stream(request({ messages: [typed('1', 'something else')] })))
  assert.equal(log.begins.length, 1)
  await collect(adapter.stream(request({ messages: [typed('1', 'written outside')] })))
  assert.equal(log.begins.length, 2)
})

test('replay: an armed turn shows once, and the same text later runs the engine', async () => {
  const { adapter, host, log } = harness(sink => sink.push({ kind: 'done' }))
  host.armReplay(KEY, { user: 'hi', assistant: 'outside' })
  assert.equal((await collect(adapter.stream(request())))[1].text, 'outside')
  assert.deepEqual(log.begins, [])
  await collect(adapter.stream(request()))
  assert.equal(log.begins.length, 1)
})

test('replay: an arm for another session or route is not used', async () => {
  const { adapter, host, log } = harness(sink => sink.push({ kind: 'done' }))
  host.armReplay(`other|${ROUTE}`, { user: 'hi', assistant: 'outside' })
  await collect(adapter.stream(request()))
  assert.equal(log.begins.length, 1)
})

test('stop: an abort during a step interrupts the engine and ends the stream', async () => {
  const controller = new AbortController()
  const { adapter, host, log, sink } = harness()
  const pending = collect(adapter.stream(request({ signal: controller.signal })))
  await settle()
  assert.equal(host.isActive(KEY), true)
  controller.abort(new Error('stopped by user'))
  assert.equal(log.interrupts, 1)
  assert.equal(host.isActive(KEY), false)
  sink().push({ kind: 'done' })
  await assert.rejects(pending, /stopped by user/)
})

test('stop: an abort after the step ended does not reach the engine', async () => {
  const controller = new AbortController()
  const { adapter, log } = harness((sink) => { sink.push(tool('c1')); sink.push({ kind: 'step-end' }) })
  await collect(adapter.stream(request({ signal: controller.signal })))
  controller.abort()
  assert.equal(log.interrupts, 0)
})

test('stop: a stopped engine that rejects its interrupt does no harm', async () => {
  const controller = new AbortController()
  const { host } = harness()
  let sink
  const adapter = host.adapterFor({ route: ROUTE, name: 'Engine', listModels: () => Promise.resolve([]), oneShot: () => Promise.resolve(''), begin: (turn) => { sink = turn.sink; return Promise.resolve({ interrupt: () => Promise.reject(new Error('already ended')) }) } })
  const pending = collect(adapter.stream(request({ signal: controller.signal })))
  await settle()
  controller.abort(new Error('stopped'))
  sink.push({ kind: 'done' })
  await assert.rejects(pending, /stopped/)
  await settle()
})

test('proxy: a call that no engine made is refused', async () => {
  const { host } = harness()
  assert.deepEqual(await proxy(host, 'unknown'), { output: 'This tool only records calls that another engine already made. Do not call it.', is_error: true })
})

test('proxy: a result that arrived first is returned, and the call can run only once', async () => {
  const { adapter, host, sink } = harness((events) => { events.push(tool('c1')); events.push({ kind: 'step-end' }) })
  await collect(adapter.stream(request()))
  sink().settle('c1', { text: 'done', isError: false })
  assert.deepEqual(await proxy(host, 'c1'), { output: 'done', is_error: false })
  assert.equal((await proxy(host, 'c1')).is_error, true)
})

test('proxy: it waits for the result of the engine, and reports an error result', async () => {
  const { adapter, host, sink } = harness((events) => { events.push(tool('c1')); events.push({ kind: 'step-end' }) })
  await collect(adapter.stream(request()))
  const pending = proxy(host, 'c1')
  await settle()
  sink().settle('c1', { text: 'failed', isError: true })
  assert.deepEqual(await pending, { output: 'failed', is_error: true })
})

test('proxy: a call that starts allows the engine to run it, before or after the engine asks', async () => {
  const { adapter, host, sink } = harness((events) => { events.push(tool('c1')); events.push(tool('c2')); events.push({ kind: 'step-end' }) })
  await collect(adapter.stream(request()))
  const asked = sink().approve('c1')
  const first = proxy(host, 'c1')
  assert.equal(await asked, true)
  const second = proxy(host, 'c2')
  assert.equal(await sink().approve('c2'), true)
  sink().settle('c1', { text: '', isError: false })
  sink().settle('c2', { text: '', isError: false })
  await Promise.all([first, second])
})

test('proxy: a call that DSH never started is refused when the turn ends', async () => {
  const { adapter, sink } = harness((events) => { events.push(tool('c1')); events.push({ kind: 'step-end' }) })
  await collect(adapter.stream(request()))
  const asked = sink().approve('c1')
  sink().push({ kind: 'done' })
  assert.equal(await asked, false)
})

test('proxy: a signal that is already stopped stops the engine at once', async () => {
  const { adapter, host, log } = harness((events) => { events.push(tool('c1')); events.push({ kind: 'step-end' }) })
  await collect(adapter.stream(request()))
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await proxy(host, 'c1', controller.signal), { output: 'The user stopped this tool call.', is_error: true })
  assert.equal(log.interrupts, 1)
  assert.equal(host.isActive(KEY), false)
})

test('adapter: it describes the provider and resolves a model with its efforts', async () => {
  const { host } = harness()
  const efforts = [{ id: 'low', name: 'Low' }]
  const adapter = host.adapterFor({ route: ROUTE, name: 'Engine', listModels: () => Promise.resolve([{ id: 'a', name: 'A', efforts, defaultEffort: 'low' }, { id: 'b', name: 'B', efforts: [] }]), oneShot: () => Promise.resolve(''), begin: () => Promise.reject(new Error('x')) })
  assert.deepEqual(adapter.providerInfo('p'), { id: 'p', name: 'Engine' })
  assert.equal(adapter.providerRetryPolicy(), undefined)
  assert.equal(adapter.imageRequestPricing(), undefined)
  assert.deepEqual(adapter.imageRequestTarget('p', 'a', { width: 1, height: 2, bytes: 3 }), { width: 1, height: 2, maxBytes: 3 })
  assert.deepEqual(await adapter.listModels('p'), [{ id: 'a', name: 'A', provider: 'p' }, { id: 'b', name: 'B', provider: 'p' }])
  assert.deepEqual(await adapter.resolveModel('p', 'a'), { provider: 'p', id: 'a', name: 'A', reasoning: { efforts, defaultEffort: 'low' }, context: { contextWindow: 1_000_000 } })
  assert.deepEqual(await adapter.resolveModel('p', 'b'), { provider: 'p', id: 'b', name: 'B', context: { contextWindow: 1_000_000 } })
  assert.equal((await adapter.prepareCall('p', 'b')).stream, adapter.stream)
})

test('adapter: a model that the engine does not list keeps its id, and a list failure gives an empty list', async () => {
  const { host } = harness()
  const adapter = host.adapterFor({ route: ROUTE, name: 'Engine', listModels: () => Promise.reject(new Error('no list')), oneShot: () => Promise.resolve(''), begin: () => Promise.reject(new Error('x')) })
  assert.deepEqual(await adapter.listModels('p'), [])
  assert.deepEqual(await adapter.resolveModel('p', 'unlisted'), { provider: 'p', id: 'unlisted', name: 'unlisted', context: { contextWindow: 1_000_000 } })
})

/** A Claude query that plays the messages made by `script`. */
const claudeQuery = (script) => {
  const calls = []
  const query = (params) => {
    const handle = { interrupts: 0, closes: 0, params }
    const release = {}
    handle.stopped = new Promise((resolve) => { release.resolve = resolve })
    const messages = script(params, handle)
    calls.push(handle)
    return Object.assign(messages, { close: () => { handle.closes += 1 }, interrupt: () => { handle.interrupts += 1; release.resolve(); return Promise.resolve() } })
  }
  return { query, calls }
}
const claudeHost = (query, options = () => ({})) => {
  const host = createEngineHost({ authorize: async () => true, cwdOf: () => '/w', threadOf: () => undefined, saveThread: () => {}, writeHandoff: () => Promise.resolve('/h'), onRealTurn: () => {} })
  return { host, adapter: host.adapterFor(claudeDriver({ route: CLAUDE_PROVIDER, query, options, listModels: () => Promise.resolve([]) })), driver: claudeDriver({ route: CLAUDE_PROVIDER, query, options, listModels: () => Promise.resolve([]) }) }
}
const claudeRequest = () => ({ provider: CLAUDE_PROVIDER, model: 'haiku', sessionId: 's', messages: [typed('1', 'hi')] })
const stepEnd = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } }
const toolUse = id => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } })
const result = { type: 'result', is_error: false, subtype: 'success', result: 'ok' }

test('claude driver: a process that stops early reports it', async () => {
  const { query } = claudeQuery(() => (async function* () { yield { type: 'system', subtype: 'init', session_id: 'T' } })())
  await assert.rejects(collect(claudeHost(query).adapter.stream(claudeRequest())), /Claude Code stopped before the turn ended/)
})

test('claude driver: a process that throws reports the message', async () => {
  const { query } = claudeQuery(() => (async function* () { throw new Error('process died') })())
  await assert.rejects(collect(claudeHost(query).adapter.stream(claudeRequest())), /process died/)
})

test('claude driver: a signed-out result tells the user what to do', async () => {
  const { query } = claudeQuery(() => (async function* () { yield { type: 'result', is_error: true, subtype: 'success', result: 'Not logged in · Please run /login' } })())
  await assert.rejects(collect(claudeHost(query).adapter.stream(claudeRequest())), /Claude Code is not signed in\. Select Sign in/)
})

test('claude driver: the turn keeps the options of the plugin and adds its own', async () => {
  const { query, calls } = claudeQuery(() => (async function* () { yield result })())
  const options = ({ thread, cwd, text, model, effort }) => ({ env: { A: '1' }, disallowedTools: ['Other'], resume: thread, cwd, text, model, effort })
  const { driver } = claudeHost(query, options)
  await driver.begin({ thread: 'old', cwd: '/w', prompt: 'p', model: 'm', effort: 'high', sink: { push: () => {}, settle: () => {}, approve: () => Promise.resolve(true), onThread: () => {} } })
  const seen = calls[0].params.options
  assert.equal(calls[0].params.prompt, 'p')
  assert.equal(seen.resume, 'old')
  assert.equal(seen.effort, 'high')
  assert.deepEqual(seen.env, { A: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' })
  assert.deepEqual(seen.disallowedTools, ['Other', 'AskUserQuestion'])
  assert.equal(seen.permissionMode, 'default')
  assert.equal(seen.includePartialMessages, true)
})

test('claude driver: Stop reaches the running process', async () => {
  const { query, calls } = claudeQuery((_params, handle) => (async function* () { await handle.stopped; yield result })())
  const { driver } = claudeHost(query)
  const events = []
  const running = await driver.begin({ cwd: '/w', prompt: 'p', model: 'm', sink: { push: event => events.push(event), settle: () => {}, approve: () => Promise.resolve(true), onThread: () => {} } })
  await running.interrupt()
  assert.equal(calls[0].interrupts, 1)
})

test('claude driver: a tool runs after DSH starts it, and is refused after the turn moves on', async () => {
  const decisions = []
  const { query } = claudeQuery(({ options }) => (async function* () {
    yield stepEnd
    yield toolUse('c1')
    decisions.push(await options.canUseTool('Bash', { a: 1 }, { toolUseID: 'c1' }))
    yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'out' }] } }
    yield stepEnd
    yield toolUse('c2')
    decisions.push(await options.canUseTool('Bash', { a: 2 }, { toolUseID: 'c2' }))
    yield result
  })())
  const { adapter, host } = claudeHost(query)
  await collect(adapter.stream(claudeRequest()))
  const outcome = await host.executeProxy({}, { rootCallId: 'c1', signal: new AbortController().signal })
  assert.deepEqual(outcome, { output: 'out', is_error: false })
  await collect(adapter.stream(claudeRequest()))
  await settle()
  await collect(adapter.stream(claudeRequest()))
  assert.deepEqual(decisions, [{ behavior: 'allow', updatedInput: { a: 1 } }, { behavior: 'deny', message: 'The user denied this tool call.' }])
})

test('claude one-shot: it uses no session and no tools, and returns the result text', async () => {
  const { query, calls } = claudeQuery(() => (async function* () { yield { type: 'other' }; yield { type: 'result', is_error: false, subtype: 'success', result: 'A title' } })())
  assert.equal(await claudeHost(query, ({ model }) => ({ model })).driver.oneShot('name this', 'haiku'), 'A title')
  const { options } = calls[0].params
  assert.equal(options.persistSession, false)
  assert.equal(options.maxTurns, 1)
  assert.deepEqual(options.tools, [])
  assert.equal(options.model, 'haiku')
})

test('claude one-shot: a result that failed gives empty text', async () => {
  const { query } = claudeQuery(() => (async function* () { yield { type: 'result', is_error: true, subtype: 'error_max_turns', errors: ['x'] } })())
  assert.equal(await claudeHost(query).driver.oneShot('q', 'm'), '')
})

/** A Codex engine stand-in that reports a tool item at the turn start. */
const codexStandIn = (item, change = {}) => {
  const listeners = new Map()
  const interrupts = []
  const engine = {
    prepareThread: () => Promise.resolve('T1'),
    watch: (thread, listener) => { listeners.set(thread, listener); return () => listeners.delete(thread) },
    start: () => { setImmediate(() => listeners.get('T1')({ method: 'item/started', params: { item } })); return Promise.resolve('T1') },
    answer: () => true,
    interrupt: (thread) => { interrupts.push(thread); return Promise.resolve(true) },
    cleanTerminals: () => Promise.resolve(),
    ...change,
  }
  return { engine, listeners, interrupts }
}
const codexHost = (engine) => {
  const host = createEngineHost({ authorize: async () => true, cwdOf: () => '/w', threadOf: () => undefined, saveThread: () => {}, writeHandoff: () => Promise.resolve('/h'), onRealTurn: () => {} })
  return { host, adapter: host.adapterFor(codexDriver({ route: CODEX_ROUTE, engine: () => engine, listModels: () => Promise.resolve([]), home: () => '/h' })) }
}
const codexRequest = () => ({ provider: CODEX_ROUTE, model: 'm', sessionId: 's', messages: [typed('1', 'hi')] })

test('codex in a chat: Stop during a tool interrupts Codex, and the next turn is a new run', async () => {
  const parts = codexStandIn({ id: 'c1', type: 'commandExecution', command: 'sleep 9' })
  const { host, adapter } = codexHost(parts.engine)
  const chunks = await collect(adapter.stream(codexRequest()))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  const controller = new AbortController()
  const proxied = host.executeProxy({}, { rootCallId: 'c1', signal: controller.signal })
  controller.abort()
  assert.deepEqual(await proxied, { output: 'The user stopped this tool call.', is_error: true })
  assert.deepEqual(parts.interrupts, ['T1'])
  assert.equal(host.isActive(`s|${CODEX_ROUTE}`), false)
})

test('codex in a chat: a failed turn from a missing sign-in tells the user what to do', async () => {
  const parts = codexStandIn({}, { start: () => { setImmediate(() => parts.listeners.get('T1')({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: '401 Unauthorized: run codex login' } } } })); return Promise.resolve('T1') } })
  await assert.rejects(collect(codexHost(parts.engine).adapter.stream(codexRequest())), /Codex is not signed in\. Select Sign in/)
})

test('codex in a chat: a turn that cannot start keeps its error text', async () => {
  const parts = codexStandIn({}, { start: () => Promise.reject(new Error('a turn is already running in this session')) })
  await assert.rejects(collect(codexHost(parts.engine).adapter.stream(codexRequest())), /a turn is already running/)
})

test('stream: two tools reported together after the step end stay in one step', async () => {
  const { adapter } = harness((sink) => {
    sink.push({ kind: 'step-end' })
    sink.push(tool('c1'))
    sink.push(tool('c2'))
  })
  const chunks = await collect(adapter.stream(request()))
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.id), ['c1', 'c2'])
})

test('permission: a call that the engine asks about gets the decision of the permission level', async () => {
  for (const allow of [true, false]) {
    const seen = []
    authorizeFor = async (call, exec, cwd) => { seen.push([call, exec.rootCallId, cwd]); return allow }
    const { adapter, host, sink } = harness((events) => { events.push(tool('c1')); events.push({ kind: 'step-end' }) })
    await collect(adapter.stream(request()))
    const asked = sink().approve('c1')
    const running = host.executeProxy({ tool: 'Bash', input: { command: 'touch a' } }, { rootCallId: 'c1', signal: new AbortController().signal })
    assert.equal(await asked, allow)
    assert.deepEqual(seen, [[{ tool: 'Bash', input: { command: 'touch a' } }, 'c1', '/w']])
    sink().settle('c1', { text: 'done', isError: false })
    await running
  }
})

test('permission: an engine that asks after DSH started the call gets the same decision', async () => {
  authorizeFor = async () => false
  const { adapter, host, sink } = harness((events) => { events.push(tool('c1')); events.push({ kind: 'step-end' }) })
  await collect(adapter.stream(request()))
  const running = host.executeProxy({ tool: 'Bash', input: {} }, { rootCallId: 'c1', signal: new AbortController().signal })
  assert.equal(await sink().approve('c1'), false)
  sink().settle('c1', { text: 'denied', isError: true })
  await running
})

test('permission: a safe call that the engine does not ask about is not sent for a decision', async () => {
  let asked = 0
  authorizeFor = async () => { asked += 1; return false }
  const { adapter, host, sink } = harness((events) => { events.push(tool('c1', 'Read')); events.push({ kind: 'step-end' }) })
  await collect(adapter.stream(request()))
  const running = host.executeProxy({ tool: 'Read', input: {} }, { rootCallId: 'c1', signal: new AbortController().signal })
  sink().settle('c1', { text: 'file text', isError: false })
  assert.equal((await running).is_error, false)
  assert.equal(asked, 0)
})

test('permission: a failed decision refuses the call', async () => {
  authorizeFor = async () => { throw new Error('no service') }
  const { adapter, host, sink } = harness((events) => { events.push(tool('c1')); events.push({ kind: 'step-end' }) })
  await collect(adapter.stream(request()))
  const running = host.executeProxy({ tool: 'Bash', input: {} }, { rootCallId: 'c1', signal: new AbortController().signal })
  assert.equal(await sink().approve('c1'), false)
  sink().settle('c1', { text: 'denied', isError: true })
  await running
})

test('turn input: an old tool call with broken arguments does not block the chat', () => {
  const broken = { id: 'a', role: 'assistant', content: [{ type: 'tool-call', id: 'x', name: 'other', arguments: '{bad' }] }
  assert.doesNotThrow(() => turnInput([broken, typed('2', 'hi')], ROUTE, false))
})
