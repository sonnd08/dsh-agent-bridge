import test from 'node:test'
import assert from 'node:assert/strict'
import { applySdkMessage, claudeDriver, createEngineHost, ENGINE_TOOL, turnInput } from '../src/native-engine.ts'
import { codexDriver } from '../src/native-codex.ts'

const ROUTE = 'engine-route'
const KEY = `s|${ROUTE}`
const typed = (id, text, extra = []) => ({ id, role: 'user', content: [{ type: 'text', text }, ...extra], source: { kind: 'user' } })
const request = messages => ({ provider: ROUTE, model: 'm', sessionId: 's', messages })
const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const proxy = (host, id) => host.executeProxy({}, { rootCallId: id, signal: new AbortController().signal })
const toolCalls = chunks => chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').map(chunk => chunk.block)
const texts = chunks => chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'text').map(chunk => chunk.block.text)
const finish = chunks => chunks.at(-1).reason.kind

const harness = (deps = {}, play = sink => sink.push({ kind: 'done' })) => {
  const log = { begins: [], authorized: 0 }
  let sink
  const driver = {
    route: ROUTE, name: 'Engine', listModels: () => Promise.resolve([]), oneShot: () => Promise.resolve(''),
    begin: (turn) => { log.begins.push(turn); sink = turn.sink; play(turn.sink); return Promise.resolve({ interrupt: () => Promise.resolve() }) },
  }
  const host = createEngineHost({ authorize: () => { log.authorized += 1; return Promise.resolve(true) }, cwdOf: () => '/w', threadOf: () => undefined, saveThread: () => {}, writeHandoff: () => Promise.resolve('/h'), onRealTurn: () => {}, ...deps })
  return { host, adapter: host.adapterFor(driver), log, sink: () => sink }
}

const assistantStep = (id, name) => ({ role: 'assistant', content: [{ type: 'tool-call', id, name, arguments: '{}' }], source: { kind: 'model', provider: ROUTE } })
const toolAnswer = id => ({ role: 'tool', content: [{ type: 'text', text: 'x' }], toolCallId: id })
const twoSteps = {
  user: 'go', assistant: 'done',
  steps: [
    { text: 'first', tools: [{ id: 'a', name: 'Bash', input: { command: 'ls' }, output: 'out', isError: false, attachments: [{ attachmentId: 'i' }] }] },
    { text: 'done', tools: [] },
  ],
}

test('replay: the first step shows the text and the tool call, and the engine does not run', async () => {
  const { host, adapter, log } = harness()
  host.armReplay(KEY, twoSteps)
  const chunks = await collect(adapter.stream(request([typed('1', 'go')])))
  assert.deepEqual(texts(chunks), ['first'])
  assert.deepEqual(toolCalls(chunks), [{ type: 'tool-call', id: 'a', name: ENGINE_TOOL, arguments: JSON.stringify({ tool: 'Bash', input: { command: 'ls' } }) }])
  assert.equal(finish(chunks), 'tool-calls')
  assert.equal(log.begins.length, 0)
})

test('replay: the call takes its recorded result with no permission check', async () => {
  const { host, adapter, log } = harness()
  host.armReplay(KEY, twoSteps)
  await collect(adapter.stream(request([typed('1', 'go')])))
  assert.deepEqual(await proxy(host, 'a'), { output: 'out', is_error: false, images: [{ attachmentId: 'i' }] })
  assert.equal(log.authorized, 0)
})

test('replay: the next step ends the turn, and the arm is used up', async () => {
  const { host, adapter, log } = harness()
  host.armReplay(KEY, twoSteps)
  await collect(adapter.stream(request([typed('1', 'go')])))
  const chunks = await collect(adapter.stream(request([typed('1', 'go'), assistantStep('a', ENGINE_TOOL), toolAnswer('a')])))
  assert.deepEqual(texts(chunks), ['done'])
  assert.equal(finish(chunks), 'stop')
  await collect(adapter.stream(request([typed('1', 'go'), assistantStep('a', ENGINE_TOOL), toolAnswer('a'), typed('2', 'more')])))
  assert.equal(log.begins.length, 1)
})

test('replay: a new message from the user during the steps runs the engine', async () => {
  const { host, adapter, log } = harness()
  host.armReplay(KEY, twoSteps)
  await collect(adapter.stream(request([typed('1', 'go')])))
  await collect(adapter.stream(request([typed('1', 'go'), assistantStep('a', ENGINE_TOOL), toolAnswer('a'), typed('2', 'stop that')])))
  assert.equal(log.begins.length, 1)
})

test('replay: a last step with only tool calls still ends the turn with a reply', async () => {
  const { host, adapter } = harness()
  host.armReplay(KEY, { user: 'go', assistant: 'x', steps: [{ text: '', tools: [{ id: 'a', name: 'Bash', input: {}, output: '', isError: false }] }] })
  const first = await collect(adapter.stream(request([typed('1', 'go')])))
  assert.deepEqual(texts(first), [])
  assert.equal(finish(first), 'tool-calls')
  const last = await collect(adapter.stream(request([typed('1', 'go'), assistantStep('a', ENGINE_TOOL), toolAnswer('a')])))
  assert.deepEqual(texts(last), ['(end of turn)'])
  assert.equal(finish(last), 'stop')
})

test('replay: a turn with no steps still shows the text', async () => {
  const { host, adapter } = harness()
  host.armReplay(KEY, { user: 'go', assistant: 'plain' })
  const chunks = await collect(adapter.stream(request([typed('1', 'go')])))
  assert.deepEqual(texts(chunks), ['plain'])
  assert.equal(finish(chunks), 'stop')
})

test('live: a Claude tool result gives its images to the run', () => {
  const settled = []
  applySdkMessage({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }] }] } }, { queue: { push: () => {} }, settle: (...args) => settled.push(args) }, () => {})
  assert.deepEqual(settled, [['a', { text: 'shot', isError: false, images: ['data:image/png;base64,QUJD'] }]])
})

test('live: the proxy returns the saved images, and leaves out an image that was not saved', async () => {
  const { host, adapter, sink } = harness({ saveImages: sources => Promise.resolve(new Map([[sources[0], { attachmentId: 'i' }]])) }, (turn) => { turn.push({ kind: 'tool', id: 'a', name: 'Bash', input: {} }); turn.push({ kind: 'step-end' }) })
  await collect(adapter.stream(request([typed('1', 'go')])))
  sink().settle('a', { text: 'shot', isError: false, images: ['one', 'two'] })
  assert.deepEqual(await proxy(host, 'a'), { output: 'shot', is_error: false, images: [{ attachmentId: 'i' }] })
})

test('live: the tool result stays when the images cannot be saved', async () => {
  const { host, adapter, sink } = harness({ saveImages: () => Promise.reject(new Error('full')) }, (turn) => { turn.push({ kind: 'tool', id: 'a', name: 'Bash', input: {} }); turn.push({ kind: 'step-end' }) })
  await collect(adapter.stream(request([typed('1', 'go')])))
  sink().settle('a', { text: 'shot', isError: false, images: ['one'] })
  assert.deepEqual(await proxy(host, 'a'), { output: 'shot', is_error: false })
})

test('composer: the images of the new message reach the engine turn', async () => {
  const ref = { attachmentId: 'i' }
  const image = { mime: 'image/png', base64: 'QUJD', path: '/tmp/i.png' }
  const { adapter, log } = harness({ loadImages: refs => { assert.deepEqual(refs, [ref]); return Promise.resolve([image]) } })
  await collect(adapter.stream(request([typed('1', 'see', [{ type: 'image', attachment: ref }])])))
  assert.deepEqual(log.begins[0].images, [image])
})

test('composer: a turn with no image has no images field', async () => {
  const { adapter, log } = harness()
  await collect(adapter.stream(request([typed('1', 'see')])))
  assert.equal('images' in log.begins[0], false)
})

test('composer: only the images after the last reply belong to the turn', () => {
  const older = { type: 'image', attachment: { attachmentId: 'old' } }
  const newer = { type: 'image', attachment: { attachmentId: 'new' } }
  const input = turnInput([typed('1', 'a', [older]), { role: 'assistant', content: [{ type: 'text', text: 'r' }], source: { kind: 'model', provider: ROUTE } }, typed('2', 'b', [newer])], ROUTE, true)
  assert.deepEqual(input.images, [newer.attachment])
})

test('Claude driver: a turn with images sends one message with the image and the text', async () => {
  let prompt
  const driver = claudeDriver({ route: ROUTE, listModels: () => Promise.resolve([]), options: () => ({}), query: (params) => { prompt = params.prompt; return (async function* () { /* no messages */ })() } })
  await driver.begin({ cwd: '/w', prompt: 'see', images: [{ mime: 'image/png', base64: 'QUJD', path: '/tmp/i.png' }], model: 'm', sink: { push: () => {}, settle: () => {}, approve: () => Promise.resolve(true), onThread: () => {} } })
  const messages = []
  for await (const message of prompt) messages.push(message)
  assert.deepEqual(messages[0].message.content, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }, { type: 'text', text: 'see' }])
})

test('Claude driver: a turn with no image sends plain text', async () => {
  let prompt
  const driver = claudeDriver({ route: ROUTE, listModels: () => Promise.resolve([]), options: () => ({}), query: (params) => { prompt = params.prompt; return (async function* () { /* no messages */ })() } })
  await driver.begin({ cwd: '/w', prompt: 'see', model: 'm', sink: { push: () => {}, settle: () => {}, approve: () => Promise.resolve(true), onThread: () => {} } })
  assert.equal(prompt, 'see')
})

test('Codex driver: a turn with images sends the file paths', async () => {
  const started = []
  const engine = { prepareThread: () => Promise.resolve('t'), watch: () => () => {}, answer: () => {}, start: (options) => { started.push(options); return Promise.resolve('t') } }
  const driver = codexDriver({ route: ROUTE, engine: () => engine, listModels: () => Promise.resolve([]), home: () => '/home/user' })
  await driver.begin({ thread: 't', cwd: '/w', prompt: 'see', images: [{ mime: 'image/png', base64: 'QUJD', path: '/tmp/i.png' }], model: 'm', sink: { push: () => {}, settle: () => {}, approve: () => Promise.resolve(true), onThread: () => {} } })
  assert.deepEqual(started[0]?.images, ['/tmp/i.png'])
})
