import test from 'node:test'
import assert from 'node:assert/strict'
import { applySdkMessage, CLAUDE_PROVIDER, claudeDriver, createEngineHost, turnInput } from '../src/native-engine.ts'
import { CodexTurnReader } from '../src/native-codex.ts'
import { retryWhileClosing } from '../src/codex.ts'
import { markOfRoute } from '../src/native-routes.ts'

const typed = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const reply = (id, provider, text) => ({ id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider } })
const context = id => ({ id, role: 'user', content: [{ type: 'text', text: 'runtime' }], source: { kind: 'runtime-context' } })
const realTurns = []
const provider = query => {
  const host = createEngineHost({ onRealTurn: key => realTurns.push(key), cwdOf: () => '/w', threadOf: () => undefined, saveThread: () => {}, writeHandoff: () => Promise.resolve('/h') })
  return { host, adapter: host.adapterFor(claudeDriver({ route: CLAUDE_PROVIDER, query, options: () => ({}), listModels: () => Promise.resolve([]) })), executeProxy: host.executeProxy }
}
const system = { id: 's', role: 'system', content: [{ type: 'text', text: 'prompt' }] }

test('native engine: a first turn sends what the user typed', () => {
  assert.deepEqual(turnInput([system, typed('1', 'hello'), context('2')], CLAUDE_PROVIDER, false), { text: 'hello', unseen: [] })
})

test('native engine: its own earlier replies are not sent again', () => {
  const input = turnInput([typed('1', 'a'), reply('2', CLAUDE_PROVIDER, 'b'), typed('3', 'c')], CLAUDE_PROVIDER, true)
  assert.equal(input.text, 'c')
  assert.deepEqual(input.unseen, [])
})

test('native engine: replies of another model are unseen', () => {
  const input = turnInput([typed('1', 'a'), reply('2', CLAUDE_PROVIDER, 'b'), typed('3', 'c'), reply('4', 'other', 'd'), typed('5', 'e')], CLAUDE_PROVIDER, true)
  assert.equal(input.text, 'e')
  assert.deepEqual(input.unseen.map(item => item.id), ['3', '4'].map((_, index) => input.unseen[index].id))
  assert.equal(input.unseen.length, 2)
})

test('native engine: without a thread, the whole history is unseen', () => {
  assert.equal(turnInput([typed('1', 'a'), reply('2', CLAUDE_PROVIDER, 'b'), typed('3', 'c')], CLAUDE_PROVIDER, false).unseen.length, 2)
})

test('native engine: SDK messages become events, and subagent work is left out', () => {
  const events = []
  const settled = []
  const threads = []
  const run = { queue: { push: event => events.push(event) }, settle: (id, outcome) => settled.push([id, outcome]) }
  const send = message => applySdkMessage(message, run, id => threads.push(id))
  send({ type: 'system', subtype: 'init', session_id: 'T' })
  send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } })
  send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } })
  send({ type: 'stream_event', parent_tool_use_id: 'x', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } } })
  send({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }] } })
  send({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'tool_use', id: 'c2', name: 'Bash', input: {} }] } })
  send({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'out' }] }] } })
  send({ type: 'result', is_error: false, subtype: 'success', result: 'x' })
  assert.deepEqual(threads, ['T'])
  assert.deepEqual(events.map(event => event.kind), ['start', 'delta', 'tool', 'done'])
  assert.deepEqual(settled, [['c1', { text: 'out', isError: false }]])
})

test('native engine: a turn has no background tasks, and its process closes at the result', async () => {
  const calls = []
  let closed = 0
  const query = ({ options }) => {
    calls.push(options)
    const messages = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'T' }
      yield { type: 'result', is_error: false, subtype: 'success', result: 'ok' }
      assert.fail('the turn must not read past its result')
    })()
    return Object.assign(messages, { close: () => { closed += 1 }, interrupt: () => Promise.resolve() })
  }
  const { adapter } = provider(query)
  const chunks = []
  for await (const chunk of adapter.stream({ provider: CLAUDE_PROVIDER, model: 'haiku', sessionId: 's', messages: [typed('1', 'hi')] })) chunks.push(chunk)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(calls[0].env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1')
  assert.equal(closed, 1)
})

test('native engine: Stop during a tool interrupts the engine, and the next turn is a new run', async () => {
  const runs = []
  const query = () => {
    let release
    const interrupted = new Promise((resolve) => { release = resolve })
    const number = runs.length
    const messages = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'T' }
      if (number === 0) {
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } }
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }] } }
        await interrupted
      }
      yield { type: 'result', is_error: false, subtype: 'success', result: 'ok' }
    })()
    const handle = Object.assign(messages, { close: () => {}, interrupt: () => { handle.interrupts += 1; release(); return Promise.resolve() }, interrupts: 0 })
    runs.push(handle)
    return handle
  }
  const { adapter, executeProxy } = provider(query)
  const request = { provider: CLAUDE_PROVIDER, model: 'haiku', sessionId: 's', messages: [typed('1', 'hi')] }
  const first = []
  for await (const chunk of adapter.stream(request)) first.push(chunk)
  assert.deepEqual(first.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  const controller = new AbortController()
  const result = executeProxy({}, { rootCallId: 'c1', signal: controller.signal })
  controller.abort({ kind: 'user' })
  assert.deepEqual(await result, { output: 'The user stopped this tool call.', is_error: true })
  assert.equal(runs[0].interrupts, 1)
  for await (const _chunk of adapter.stream(request)) { /* read to the end */ }
  assert.equal(runs.length, 2)
})

test('native engine: a Codex turn becomes text, a proxied tool and an end', async () => {
  const events = []
  const settled = []
  const answers = []
  const reader = new CodexTurnReader({ push: event => events.push(event), settle: (id, outcome) => settled.push([id, outcome]), approve: () => Promise.resolve(true), onThread: () => {} }, (id, allow) => answers.push([id, allow]))
  const read = (method, params) => reader.read({ method, params })
  read('item/agentMessage/delta', { itemId: 'm1', delta: 'hi' })
  read('item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'hi' } })
  read('item/started', { item: { id: 'c1', type: 'commandExecution', command: 'ls', cwd: '/w' } })
  read('approval', { requestId: 'r1', itemId: 'c1', request: 'item/commandExecution/requestApproval' })
  read('item/completed', { item: { id: 'c1', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'out' } })
  read('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 } } })
  assert.equal(read('turn/completed', { turn: { status: 'completed' } }), true)
  await Promise.resolve()
  assert.deepEqual(events, [
    { kind: 'start', block: 'text' }, { kind: 'delta', text: 'hi' }, { kind: 'stop' },
    { kind: 'tool', id: 'c1', name: 'command', input: { command: 'ls', cwd: '/w' } }, { kind: 'step-end' },
    { kind: 'usage', input: 6, output: 2, cacheRead: 4, cacheWrite: 0 }, { kind: 'done' },
  ])
  assert.deepEqual(settled, [['c1', { text: 'out', isError: false }]])
  assert.deepEqual(answers, [['r1', true]])
})

test('native engine: a failed Codex turn reports its error, and a question is refused', () => {
  const events = []
  const answers = []
  const reader = new CodexTurnReader({ push: event => events.push(event), settle: () => {}, approve: () => Promise.resolve(true), onThread: () => {} }, (id, allow) => answers.push([id, allow]))
  reader.read({ method: 'approval', params: { requestId: 'q1', request: 'item/tool/requestUserInput' } })
  reader.read({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'no quota' } } } })
  assert.deepEqual(answers, [['q1', false]])
  assert.deepEqual(events, [{ kind: 'done', error: 'no quota' }])
})

test('native engine: a resume repeats while the thread closes, and other errors stop it', async () => {
  let calls = 0
  const closing = () => { calls += 1; return calls < 3 ? Promise.reject(new Error('thread T is closing; retry after the thread is closed')) : Promise.resolve('ok') }
  assert.equal(await retryWhileClosing(closing, 0), 'ok')
  assert.equal(calls, 3)
  await assert.rejects(retryWhileClosing(() => Promise.reject(new Error('no such thread')), 0), /no such thread/)
  await assert.rejects(retryWhileClosing(() => Promise.reject(new Error('T is closing')), 0, 2), /is closing/)
})

test('native engine: a chat row shows the mark of the selected provider', () => {
  assert.equal(markOfRoute('claude-code'), 'claude')
  assert.equal(markOfRoute('claude@work'), 'claude')
  assert.equal(markOfRoute('codex-cli'), 'codex')
  assert.equal(markOfRoute('codex@work'), 'codex')
  assert.equal(markOfRoute('deepseek-account'), 'dsh')
  assert.equal(markOfRoute(undefined), 'dsh')
})

test('native engine: a turn from another app is shown as written, and the engine does not run', async () => {
  let queries = 0
  const { host, adapter } = provider(() => { queries += 1; throw new Error('the engine must not run') })
  host.armReplay(`r|${CLAUDE_PROVIDER}`, { user: 'hello', assistant: 'written outside' })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: CLAUDE_PROVIDER, model: 'haiku', sessionId: 'r', messages: [typed('1', 'hello')] })) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
  assert.equal(chunks[1].text, 'written outside')
  assert.equal(queries, 0)
  assert.ok(!realTurns.includes(`r|${CLAUDE_PROVIDER}`))
})
