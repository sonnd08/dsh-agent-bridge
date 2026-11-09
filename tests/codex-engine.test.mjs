import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexEngine, capped, retryWhileClosing } from '../src/codex.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex-scripted.mjs', import.meta.url))
const ACCESS = { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }
const CWD = '/work/app'

const thread = id => [{ result: { thread: { id } } }]
const turn = (then = []) => [{ result: { turn: { id: 'turn-1' } }, then }]
const note = (method, threadId, params = {}) => ({ method, params: { threadId, ...params } })
const finished = (threadId, status = 'completed', extra = {}) => note('turn/completed', threadId, { turn: { id: 'turn-1', status, ...extra } })

const until = async (read) => {
  for (let tries = 0; tries < 200; tries += 1) {
    const value = read()
    if (value !== undefined && value !== false) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out')
}

async function withEngine(scenario, check) {
  const folder = mkdtempSync(join(tmpdir(), 'bridge-codex-'))
  const file = join(folder, 'scenario.json')
  const log = join(folder, 'calls.jsonl')
  writeFileSync(file, JSON.stringify(scenario))
  const engine = new CodexEngine(FAKE, { env: { FAKE_CODEX_SCENARIO: file, FAKE_CODEX_LOG: log } })
  const messages = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const calls = method => messages().filter(message => message.method === method).map(message => message.params)
  const replies = () => messages().filter(message => message.method === undefined)
  try {
    await check(engine, { calls, replies })
  } finally {
    await engine.closeAll()
    rmSync(folder, { recursive: true, force: true })
  }
}

test('codex thread: a new thread gets the folder, access and model', async () => {
  await withEngine({ 'thread/start': thread('T1') }, async (engine, { calls }) => {
    assert.equal(await engine.prepareThread({ cwd: CWD, ...ACCESS, model: 'model-a' }), 'T1')
    assert.deepEqual(calls('thread/start'), [{ cwd: CWD, ...ACCESS, model: 'model-a' }])
  })
})

test('codex thread: a resume names the model, so that it does not keep the last one', async () => {
  await withEngine({ 'thread/resume': [{ result: {} }] }, async (engine, { calls }) => {
    assert.equal(await engine.prepareThread({ threadId: 'T1', cwd: CWD, ...ACCESS, model: 'model-b' }), 'T1')
    assert.deepEqual(calls('thread/resume'), [{ threadId: 'T1', ...ACCESS, model: 'model-b' }])
  })
})

test('codex thread: no model or an empty model names none', async () => {
  await withEngine({ 'thread/start': thread('T1'), 'thread/resume': [{ result: {} }] }, async (engine, { calls }) => {
    await engine.prepareThread({ cwd: CWD, ...ACCESS })
    await engine.prepareThread({ cwd: CWD, ...ACCESS, model: '' })
    await engine.prepareThread({ threadId: 'T2', cwd: CWD, ...ACCESS, model: '' })
    assert.deepEqual(calls('thread/start').map(params => 'model' in params), [false, false])
    assert.equal('model' in calls('thread/resume')[0], false)
  })
})

test('codex thread: a loaded thread is not resumed again', async () => {
  await withEngine({ 'thread/resume': [{ result: {} }] }, async (engine, { calls }) => {
    await engine.prepareThread({ threadId: 'T1', cwd: CWD, ...ACCESS })
    await engine.prepareThread({ threadId: 'T1', cwd: CWD, ...ACCESS })
    assert.equal(calls('thread/resume').length, 1)
  })
})

test('codex thread: a resume repeats while the thread closes', async () => {
  await withEngine({ 'thread/resume': [{ error: { code: -1, message: 'thread T1 is closing' } }, { result: {} }] }, async (engine, { calls }) => {
    assert.equal(await engine.prepareThread({ threadId: 'T1', cwd: CWD, ...ACCESS }), 'T1')
    assert.equal(calls('thread/resume').length, 2)
  })
})

test('codex thread: a resume that fails for another reason fails once and leaves the thread not loaded', async () => {
  await withEngine({ 'thread/resume': [{ error: { code: -1, message: 'no such thread' } }, { result: {} }] }, async (engine, { calls }) => {
    await assert.rejects(engine.prepareThread({ threadId: 'T1', cwd: CWD, ...ACCESS }), /no such thread/)
    assert.equal(calls('thread/resume').length, 1)
    await engine.prepareThread({ threadId: 'T1', cwd: CWD, ...ACCESS })
    assert.equal(calls('thread/resume').length, 2)
  })
})

test('codex thread: a finished thread is released, and the next turn resumes it', async () => {
  await withEngine({ 'thread/start': thread('T1'), 'turn/start': turn([finished('T1')]), 'thread/resume': [{ result: {} }] }, async (engine, { calls }) => {
    await engine.start({ cwd: CWD, text: 'hi', ...ACCESS })
    await until(() => calls('thread/unsubscribe').length === 1)
    assert.deepEqual(calls('thread/unsubscribe'), [{ threadId: 'T1' }])
    await engine.prepareThread({ threadId: 'T1', cwd: CWD, ...ACCESS })
    assert.equal(calls('thread/resume').length, 1)
  })
})

test('codex retry: the last error comes back after the most repeats', async () => {
  let tries = 0
  await assert.rejects(retryWhileClosing(() => { tries += 1; return Promise.reject(new Error('T is closing')) }, 0, 3), /is closing/)
  assert.equal(tries, 4)
})

test('codex retry: a value that is not an Error is not repeated', async () => {
  let tries = 0
  await assert.rejects(retryWhileClosing(() => { tries += 1; return Promise.reject('is closing') }, 0, 3), error => error === 'is closing') // eslint-disable-line prefer-promise-reject-errors
  assert.equal(tries, 1)
})

test('codex retry: a success on the first try runs once', async () => {
  let tries = 0
  assert.equal(await retryWhileClosing(() => { tries += 1; return Promise.resolve('done') }, 0, 3), 'done')
  assert.equal(tries, 1)
})

test('codex ask: the thread is ephemeral, read-only and asks for no approval', async () => {
  await withEngine({ 'thread/start': thread('E1'), 'turn/start': turn([finished('E1')]) }, async (engine, { calls }) => {
    await engine.ask(CWD, 'title please', 'model-a')
    assert.deepEqual(calls('thread/start'), [{ cwd: CWD, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true }])
    assert.deepEqual(calls('turn/start'), [{ threadId: 'E1', input: [{ type: 'text', text: 'title please', text_elements: [] }], model: 'model-a' }])
  })
})

test('codex ask: the reply is the last agent message', async () => {
  const item = (id, type, text) => note('item/completed', 'E1', { item: { id, type, text } })
  await withEngine({ 'thread/start': thread('E1'), 'turn/start': turn([item('a', 'agentMessage', 'first'), item('b', 'reasoning', 'thought'), item('c', 'agentMessage', 'last'), finished('E1')]) }, async (engine) => {
    assert.equal(await engine.ask(CWD, 'q', 'm'), 'last')
  })
})

test('codex ask: a turn with no message gives empty text', async () => {
  await withEngine({ 'thread/start': thread('E1'), 'turn/start': turn([finished('E1')]) }, async (engine) => {
    assert.equal(await engine.ask(CWD, 'q', 'm'), '')
  })
})

test('codex ask: a turn that cannot start rejects', async () => {
  await withEngine({ 'thread/start': thread('E1'), 'turn/start': [{ error: { code: -1, message: 'bad model' } }] }, async (engine) => {
    await assert.rejects(engine.ask(CWD, 'q', 'm'), /bad model/)
  })
})

test('codex ask: a thread that cannot start rejects and starts no turn', async () => {
  await withEngine({ 'thread/start': [{ error: { code: -1, message: 'no folder' } }] }, async (engine, { calls }) => {
    await assert.rejects(engine.ask(CWD, 'q', 'm'), /no folder/)
    assert.deepEqual(calls('turn/start'), [])
  })
})

test('codex watch: a listener gets the events of its thread only', async () => {
  await withEngine({ 'thread/start': thread('W1'), 'turn/start': turn([note('item/started', 'other', { item: { id: 'x' } }), note('item/started', 'W1', { item: { id: 'mine' } }), finished('W1')]) }, async (engine) => {
    const events = []
    const threadId = await engine.prepareThread({ cwd: CWD, ...ACCESS })
    engine.watch(threadId, event => events.push(event))
    await engine.start({ threadId, cwd: CWD, text: 'hi', ...ACCESS })
    await until(() => events.some(event => event.method === 'turn/completed'))
    assert.deepEqual(events.map(event => event.method), ['item/started', 'turn/completed'])
    assert.equal(events[0].params.item.id, 'mine')
  })
})

test('codex watch: the end function stops the events', async () => {
  await withEngine({ 'thread/start': thread('W1'), 'turn/start': turn([finished('W1')]) }, async (engine) => {
    const events = []
    const threadId = await engine.prepareThread({ cwd: CWD, ...ACCESS })
    engine.watch(threadId, event => events.push(event))()
    await engine.start({ threadId, cwd: CWD, text: 'hi', ...ACCESS })
    await until(() => !engine.isRunning(threadId))
    assert.deepEqual(events, [])
  })
})

test('codex watch: the end function of an old listener leaves the new listener', async () => {
  await withEngine({ 'thread/start': thread('W1'), 'turn/start': turn([finished('W1')]) }, async (engine) => {
    const old = []
    const fresh = []
    const threadId = await engine.prepareThread({ cwd: CWD, ...ACCESS })
    const stopOld = engine.watch(threadId, event => old.push(event))
    engine.watch(threadId, event => fresh.push(event))
    stopOld()
    await engine.start({ threadId, cwd: CWD, text: 'hi', ...ACCESS })
    await until(() => fresh.length > 0)
    assert.deepEqual(old, [])
  })
})

test('codex watch: an approval reaches the listener with its request and tool', async () => {
  const ask = { id: 91, method: 'item/commandExecution/requestApproval', params: { threadId: 'W1', itemId: 'c1', command: 'ls', reason: 'why' } }
  await withEngine({ 'thread/start': thread('W1'), 'turn/start': turn([ask]) }, async (engine) => {
    const events = []
    const threadId = await engine.prepareThread({ cwd: CWD, ...ACCESS })
    engine.watch(threadId, event => events.push(event))
    await engine.start({ threadId, cwd: CWD, text: 'hi', ...ACCESS })
    const approval = await until(() => events.find(event => event.method === 'approval'))
    assert.equal(approval.params.request, 'item/commandExecution/requestApproval')
    assert.equal(approval.params.itemId, 'c1')
    assert.equal(typeof approval.params.requestId, 'string')
  })
})

test('codex answer: each decision reaches the app-server', async () => {
  for (const [decision, expected] of [[{ behavior: 'allow' }, 'accept'], [{ behavior: 'allow', remember: true }, 'acceptForSession'], [{ behavior: 'deny' }, 'decline']]) {
    const ask = { id: 92, method: 'item/fileChange/requestApproval', params: { threadId: 'W1', itemId: 'f1', reason: 'edit' } }
    await withEngine({ 'thread/start': thread('W1'), 'turn/start': turn([ask]) }, async (engine, { replies }) => {
      const permissions = []
      const threadId = await engine.start({ cwd: CWD, text: 'hi', ...ACCESS })
      engine.subscribe(threadId, event => permissions.push(event))
      const permission = await until(() => permissions.find(event => event.kind === 'permission'))
      assert.equal(engine.answer(threadId, permission.permission.requestId, decision), true)
      const reply = await until(() => replies().find(item => item.id === 92))
      assert.deepEqual(reply.result, { decision: expected })
      assert.equal(engine.answer(threadId, permission.permission.requestId, decision), false)
    })
  }
})

test('codex answer: a question sends the answers by question id', async () => {
  const ask = { id: 93, method: 'item/tool/requestUserInput', params: { threadId: 'W1', itemId: 'q1', questions: [{ id: 'q-a', question: 'Which?', header: 'H', options: [{ label: 'One', description: 'd' }] }, { id: 'q-b', question: 'Other?' }] } }
  await withEngine({ 'thread/start': thread('W1'), 'turn/start': turn([ask]) }, async (engine, { replies }) => {
    const seen = []
    const threadId = await engine.start({ cwd: CWD, text: 'hi', ...ACCESS })
    engine.subscribe(threadId, event => seen.push(event))
    const { permission } = await until(() => seen.find(event => event.kind === 'permission'))
    assert.deepEqual(permission.questions[0], { question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'One', description: 'd' }] })
    engine.answer(threadId, permission.requestId, { behavior: 'allow', answers: { 'Which?': 'One' } })
    const reply = await until(() => replies().find(item => item.id === 93))
    assert.deepEqual(reply.result, { answers: { 'q-a': { answers: ['One'] } } })
  })
})

test('codex answer: an unknown request of the app-server is refused', async () => {
  const ask = { id: 94, method: 'item/other/request', params: { threadId: 'W1' } }
  await withEngine({ 'thread/start': thread('W1'), 'turn/start': turn([ask]) }, async (engine, { replies }) => {
    await engine.start({ cwd: CWD, text: 'hi', ...ACCESS })
    const reply = await until(() => replies().find(item => item.id === 94))
    assert.match(reply.error.message, /unsupported request item\/other\/request/)
  })
})

test('codex answer: nothing pending gives false', async () => {
  await withEngine({}, async (engine) => {
    assert.equal(engine.answer('none', 'r', { behavior: 'allow' }), false)
  })
})

test('codex interrupt: pending approvals are declined and the running turn stops', async () => {
  const ask = { id: 95, method: 'item/commandExecution/requestApproval', params: { threadId: 'W1', itemId: 'c1', command: 'ls' } }
  await withEngine({ 'thread/start': thread('W1'), 'turn/start': turn([ask]) }, async (engine, { calls, replies }) => {
    const seen = []
    const threadId = await engine.start({ cwd: CWD, text: 'hi', ...ACCESS })
    engine.subscribe(threadId, event => seen.push(event))
    await until(() => seen.some(event => event.kind === 'permission'))
    assert.equal(await engine.interrupt(threadId), true)
    assert.deepEqual(calls('turn/interrupt'), [{ threadId, turnId: 'turn-1' }])
    const reply = await until(() => replies().find(item => item.id === 95))
    assert.deepEqual(reply.result, { decision: 'decline' })
  })
})

test('codex interrupt: no running turn gives false', async () => {
  await withEngine({}, async (engine, { calls }) => {
    assert.equal(await engine.interrupt('none'), false)
    assert.deepEqual(calls('turn/interrupt'), [])
  })
})

test('codex turn: model, effort, images and speed reach the turn', async () => {
  await withEngine({ 'thread/start': thread('T1'), 'turn/start': turn() }, async (engine, { calls }) => {
    await engine.start({ cwd: CWD, text: 'hi', ...ACCESS, model: 'm', effort: 'high', speed: 'fast', images: ['/img/a.png'] })
    assert.deepEqual(calls('turn/start'), [{ threadId: 'T1', input: [{ type: 'localImage', path: '/img/a.png' }, { type: 'text', text: 'hi', text_elements: [] }], ...ACCESS, model: 'm', effort: 'high', serviceTier: 'fast' }])
  })
})

test('codex turn: an empty speed asks for standard, and no speed keeps the thread speed', async () => {
  await withEngine({ 'thread/start': thread('T1'), 'turn/start': [{ result: { turn: { id: 't' } }, then: [finished('T1')] }] }, async (engine, { calls }) => {
    await engine.start({ cwd: CWD, text: 'a', ...ACCESS, speed: '' })
    await until(() => !engine.isRunning('T1'))
    await engine.start({ cwd: CWD, text: 'b', ...ACCESS })
    const [first, second] = calls('turn/start')
    assert.equal(first.serviceTier, null)
    assert.equal('serviceTier' in second, false)
  })
})

test('codex turn: an empty model or effort is not sent', async () => {
  await withEngine({ 'thread/start': thread('T1'), 'turn/start': turn() }, async (engine, { calls }) => {
    await engine.start({ cwd: CWD, text: 'a', ...ACCESS, model: '', effort: '' })
    assert.equal('model' in calls('turn/start')[0], false)
    assert.equal('effort' in calls('turn/start')[0], false)
  })
})

test('codex turn: a second turn in a running thread is refused', async () => {
  await withEngine({ 'thread/resume': [{ result: {} }], 'turn/start': turn() }, async (engine) => {
    await engine.start({ threadId: 'T1', cwd: CWD, text: 'a', ...ACCESS })
    await assert.rejects(engine.start({ threadId: 'T1', cwd: CWD, text: 'b', ...ACCESS }), /already running/)
  })
})

test('codex turn: live events report text and the end', async () => {
  await withEngine({ 'thread/start': thread('T1'), 'turn/start': turn([note('item/agentMessage/delta', 'T1', { delta: 'hel' }), note('item/completed', 'T1', { item: { id: 'm', type: 'agentMessage' } }), finished('T1')]) }, async (engine) => {
    const events = []
    const threadId = await engine.prepareThread({ cwd: CWD, ...ACCESS })
    engine.subscribe(threadId, (event) => { if (event.kind !== 'idle') events.push(event) })
    await engine.start({ threadId, cwd: CWD, text: 'hi', ...ACCESS })
    await until(() => events.some(event => event.kind === 'ended'))
    assert.deepEqual(events.map(event => event.kind), ['delta', 'message', 'ended'])
    assert.deepEqual(events.at(-1), { kind: 'ended', status: 'ok' })
    assert.equal(engine.isRunning(threadId), false)
  })
})

test('codex turn: a failed turn reports the message of the turn', async () => {
  await withEngine({ 'thread/start': thread('T1'), 'turn/start': turn([finished('T1', 'failed', { error: { message: 'rate limited' } })]) }, async (engine) => {
    const events = []
    const threadId = await engine.prepareThread({ cwd: CWD, ...ACCESS })
    engine.subscribe(threadId, (event) => { if (event.kind !== 'idle') events.push(event) })
    await engine.start({ threadId, cwd: CWD, text: 'hi', ...ACCESS })
    await until(() => events.some(event => event.kind === 'ended'))
    assert.deepEqual(events.at(-1), { kind: 'ended', status: 'error', error: 'rate limited' })
  })
})

test('codex turn: a failed turn with no message reports the error event before it', async () => {
  await withEngine({ 'thread/start': thread('T1'), 'turn/start': turn([note('error', 'T1', { error: { message: 'stream lost' } }), finished('T1', 'failed')]) }, async (engine) => {
    const events = []
    const threadId = await engine.prepareThread({ cwd: CWD, ...ACCESS })
    engine.subscribe(threadId, (event) => { if (event.kind !== 'idle') events.push(event) })
    await engine.start({ threadId, cwd: CWD, text: 'hi', ...ACCESS })
    await until(() => events.some(event => event.kind === 'ended'))
    assert.equal(events.at(-1).error, 'stream lost')
  })
})

test('codex turn: an interrupted turn ends as interrupted, with no error', async () => {
  await withEngine({ 'thread/start': thread('T1'), 'turn/start': turn([finished('T1', 'interrupted')]) }, async (engine) => {
    const events = []
    const threadId = await engine.prepareThread({ cwd: CWD, ...ACCESS })
    engine.subscribe(threadId, (event) => { if (event.kind !== 'idle') events.push(event) })
    await engine.start({ threadId, cwd: CWD, text: 'hi', ...ACCESS })
    await until(() => events.some(event => event.kind === 'ended'))
    assert.deepEqual(events.at(-1), { kind: 'ended', status: 'interrupted' })
  })
})

test('codex goal: /goal clear clears it and starts no turn', async () => {
  await withEngine({ 'thread/start': thread('G1'), 'thread/goal/clear': [{ result: {} }] }, async (engine, { calls }) => {
    assert.equal(await engine.start({ cwd: CWD, text: '/goal stop', ...ACCESS }), 'G1')
    assert.deepEqual(calls('thread/goal/clear'), [{ threadId: 'G1' }])
    assert.deepEqual(calls('turn/start'), [])
    assert.equal(engine.isRunning('G1'), false)
  })
})

test('codex goal: /goal with a condition sets it and waits for the turn', async () => {
  await withEngine({ 'thread/start': thread('G1'), 'thread/goal/set': [{ result: {}, then: [note('turn/started', 'G1', { turn: { id: 'g-turn' } })] }] }, async (engine, { calls }) => {
    await engine.start({ cwd: CWD, text: '/goal  ship the app ', ...ACCESS })
    assert.deepEqual(calls('thread/goal/set'), [{ threadId: 'G1', objective: 'ship the app' }])
    assert.equal(engine.isRunning('G1'), true)
  })
})

test('codex account: no account is not signed in', async () => {
  for (const result of [{}, { account: null }]) {
    await withEngine({ 'account/read': [{ result }] }, async (engine, { calls }) => {
      assert.deepEqual(await engine.readAccount(), { loggedIn: false })
      assert.deepEqual(calls('account/read'), [{ refreshToken: false }])
    })
  }
})

test('codex account: the report names the email, plan and type', async () => {
  await withEngine({ 'account/read': [{ result: { account: { email: 'user@example.test', planType: 'pro', type: 'chatgpt' } } }] }, async (engine) => {
    assert.deepEqual(await engine.readAccount(), { loggedIn: true, email: 'user@example.test', plan: 'pro', provider: 'chatgpt' })
  })
})

test('codex account: fields of another type are left out, and the type defaults to codex', async () => {
  await withEngine({ 'account/read': [{ result: { account: { email: 1, planType: null } } }] }, async (engine) => {
    assert.deepEqual(await engine.readAccount(), { loggedIn: true, provider: 'codex' })
  })
})

const MODELS = [{ value: 'model-a', name: 'Model A', description: '', efforts: [] }, { value: 'model-b', name: 'Model B', description: '', efforts: [], isDefault: true }]

test('codex defaults: the configured model is shown by its name, with its effort', async () => {
  await withEngine({ 'config/read': [{ result: { config: { model: 'model-a', model_reasoning_effort: 'high' } } }] }, async (engine, { calls }) => {
    assert.deepEqual(await engine.readDefaults(MODELS), { model: 'Model A', effort: 'high' })
    assert.deepEqual(calls('config/read'), [{}])
  })
})

test('codex defaults: with no configured model the listed default is used', async () => {
  await withEngine({ 'config/read': [{ result: { config: {} } }] }, async (engine) => {
    assert.deepEqual(await engine.readDefaults(MODELS), { model: 'Model B' })
  })
})

test('codex defaults: no config and no listed default gives nothing', async () => {
  await withEngine({ 'config/read': [{ result: {} }] }, async (engine) => {
    assert.deepEqual(await engine.readDefaults([]), {})
  })
})

test('codex defaults: an effort that is not text is left out', async () => {
  await withEngine({ 'config/read': [{ result: { config: { model_reasoning_effort: 3 } } }] }, async (engine) => {
    assert.deepEqual(await engine.readDefaults([]), {})
  })
})

test('codex models: hidden models are left out, and efforts and the default come through', async () => {
  const data = [{ model: 'a', displayName: 'A', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, 'high'], isDefault: true }, { model: 'hidden', hidden: true }, { id: 'b' }]
  await withEngine({ 'model/list': [{ result: { data } }] }, async (engine) => {
    const models = await engine.listModels()
    assert.deepEqual(models.map(model => model.value), ['a', 'b'])
    assert.deepEqual(models[0].efforts, ['low', 'high'])
    assert.equal(models[0].isDefault, true)
    assert.deepEqual(models[1].efforts, [])
    assert.equal('isDefault' in models[1], false)
  })
})

test('codex models: fast mode uses the new tier list before the old one, and prefers fast', async () => {
  const data = [
    { model: 'a', serviceTiers: [{ id: 'priority' }, { id: 'fast' }], additionalSpeedTiers: ['other'] },
    { model: 'b', additionalSpeedTiers: ['priority'] },
    { model: 'c', serviceTiers: [{ id: 'flex' }] },
    { model: 'd' },
  ]
  await withEngine({ 'model/list': [{ result: { data } }] }, async (engine) => {
    assert.deepEqual((await engine.listModels()).map(model => model.fastTier), ['fast', 'priority', undefined, undefined])
  })
})

test('codex list: rows have the prefix, a time in milliseconds, and the branch when known', async () => {
  const data = [{ id: 'a', name: 'Name', preview: 'p', cwd: '/x', updatedAt: 1_700_000_000, gitInfo: { branch: 'main' } }, { id: 'b', preview: 'preview', updatedAt: 1_700_000_000_000, gitInfo: { branch: null } }, { id: 'c' }]
  await withEngine({ 'thread/list': [{ result: { data } }] }, async (engine) => {
    const rows = await engine.listRows(5)
    assert.deepEqual(rows[0], { id: 'codex:a', title: 'Name', cwd: '/x', updatedAt: 1_700_000_000_000, branch: 'main' })
    assert.equal(rows[1].title, 'preview')
    assert.equal(rows[1].updatedAt, 1_700_000_000_000)
    assert.equal('branch' in rows[1], false)
    assert.equal(rows[2].title, 'c')
    assert.equal(rows[2].cwd, '')
  })
})

test('codex search: the term and limit reach the list', async () => {
  await withEngine({ 'thread/list': [{ result: { data: [{ id: 'a', updatedAt: 1 }] } }] }, async (engine, { calls }) => {
    assert.deepEqual((await engine.search('needle', 7)).map(row => row.id), ['codex:a'])
    assert.deepEqual(calls('thread/list'), [{ limit: 7, sortKey: 'updated_at', searchTerm: 'needle' }])
  })
})

test('codex transcript: each kind of item becomes messages in order', async () => {
  const items = [
    { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'hi' }, { type: 'image' }] },
    { id: 'r', type: 'reasoning', summary: ['why'], content: [] },
    { id: 'empty', type: 'reasoning' },
    { id: 'c', type: 'commandExecution', command: 'ls', cwd: '/x', aggregatedOutput: 'out', exitCode: 2 },
    { id: 'f', type: 'fileChange', changes: [{ path: 'a.txt', diff: '+x' }] },
    { id: 'm', type: 'mcpToolCall', tool: 'lookup' },
    { id: 'p', type: 'plan', text: 'the plan' },
    { id: 'a', type: 'agentMessage', text: 'done' },
    { id: 'z', type: 'unknownThing' },
  ]
  await withEngine({ 'thread/turns/list': [{ result: { data: [{ items }], nextCursor: null } }] }, async (engine) => {
    const page = await engine.readMessages('T', 5)
    assert.equal(page.earlierOmitted, false)
    assert.deepEqual(page.messages.map(message => message.id), ['u', 'r', 'c:use', 'c:result', 'f:use', 'f:result', 'm:use', 'm:result', 'p', 'a'])
    assert.equal(page.messages[0].blocks[0].text, 'hi\n[image]')
    assert.equal(page.messages[3].blocks[0].isError, true)
    assert.deepEqual(page.messages[2].blocks[0].args, { command: 'ls', cwd: '/x' })
    assert.deepEqual(page.messages[4].blocks[0].args, { paths: ['a.txt'] })
    assert.equal(page.messages[5].blocks[0].text, 'a.txt\n+x')
    assert.equal(page.messages[6].blocks[0].name, 'lookup')
  })
})

test('codex goal read: a goal that is complete or absent is no goal', async () => {
  await withEngine({ 'thread/goal/get': [{ result: { goal: { objective: 'x', status: 'complete' } } }, { result: { goal: null } }, { result: { goal: { objective: 'ship', status: 'active', tokensUsed: 5 } } }] }, async (engine) => {
    assert.equal(await engine.readGoal('T'), undefined)
    assert.equal(await engine.readGoal('T'), undefined)
    assert.deepEqual(await engine.readGoal('T'), { condition: 'ship', tokensUsed: 5, reason: 'active' })
  })
})

test('codex file: a thread with no path has no file', async () => {
  await withEngine({ 'thread/read': [{ result: { thread: { path: null } } }, { result: { thread: { path: '/files/t.jsonl' } } }] }, async (engine, { calls }) => {
    assert.equal(await engine.findFile('T'), undefined)
    assert.equal(await engine.findFile('T'), '/files/t.jsonl')
    assert.deepEqual(calls('thread/read')[0], { threadId: 'T', includeTurns: false })
  })
})

test('codex manage: fork, rename and delete call the app-server', async () => {
  await withEngine({ 'thread/fork': thread('F1'), 'thread/name/set': [{ result: {} }], 'thread/delete': [{ result: {} }] }, async (engine, { calls }) => {
    assert.equal(await engine.fork('T'), 'F1')
    await engine.rename('T', 'New')
    await engine.delete('T')
    assert.deepEqual(calls('thread/name/set'), [{ threadId: 'T', name: 'New' }])
    assert.deepEqual(calls('thread/delete'), [{ threadId: 'T' }])
  })
})

test('codex process: an error with no message has a default text', async () => {
  await withEngine({ 'thread/fork': [{ error: { code: -1 } }] }, async (engine) => {
    await assert.rejects(engine.fork('T'), /codex error/)
  })
})

test('codex process: a call in progress fails when the app-server exits, and the next call starts it again', async () => {
  await withEngine({ 'thread/list': [{ exit: true }], 'thread/fork': thread('F1') }, async (engine) => {
    await assert.rejects(engine.listRows(1), /codex app-server exited/)
    assert.equal(await engine.fork('T'), 'F1')
  })
})

test('codex output: long text is cut, and short text stays', () => {
  assert.equal(capped('short'), 'short')
  const cut = capped('x'.repeat(20_001))
  assert.equal(cut.length, 20_001)
  assert.ok(cut.endsWith('…'))
  assert.equal(capped('x'.repeat(20_000)).length, 20_000)
})

test('codex process: a missing executable gives an error and does not crash the host', async () => {
  const engine = new CodexEngine('/invented/no-such-codex')
  await assert.rejects(engine.listModels())
  await engine.closeAll()
})

test('codex close: a failed interrupt still closes the process', async () => {
  const engine = new CodexEngine('/invented/no-such-codex')
  let closed = 0
  engine.rpc = { close: () => { closed += 1 } }
  engine.interrupt = async () => { throw new Error('gone') }
  engine.runs.set('t', { pending: new Map(), interrupted: false, turnId: 'x' })
  await engine.closeAll()
  assert.equal(closed, 1)
})

test('codex turn: a turn that ends in the same read as its reply does not stay running', async () => {
  const engine = new CodexEngine('/invented/no-such-codex')
  engine.prepareThread = async () => 't1'
  engine.rpc = { close() {}, call: async (method) => {
    assert.equal(method, 'turn/start')
    engine.endedTurns.set('t1', 'turn-1')
    return { turn: { id: 'turn-1' } }
  } }
  await engine.start({ threadId: 't1', cwd: CWD, text: 'hi', ...ACCESS })
  assert.equal(engine.isRunning('t1'), false)
})

test('codex history: no limit reads every page, and a limit reads one page', async () => {
  const page = (id, nextCursor) => ({ result: { data: [{ id, items: [{ type: 'userMessage', id: `${id}-m`, content: [{ type: 'text', text: id }] }] }], nextCursor } })
  await withEngine({ 'thread/turns/list': [page('new', 'c1'), page('old', null), page('new', 'c1')] }, async (engine, { calls }) => {
    const all = await engine.readMessages('t1', Number.POSITIVE_INFINITY)
    assert.deepEqual(all.messages.flatMap(message => message.blocks.map(block => block.text)), ['old', 'new'])
    assert.equal(all.earlierOmitted, false)
    assert.equal(calls('thread/turns/list')[1].cursor, 'c1')
    assert.equal((await engine.readMessages('t1', 1)).earlierOmitted, true)
    assert.equal(calls('thread/turns/list').length, 3)
  })
})

test('codex history: a repeated cursor ends the read', async () => {
  const page = { result: { data: [], nextCursor: 'same' } }
  await withEngine({ 'thread/turns/list': [page] }, async (engine, { calls }) => {
    await engine.readMessages('t1', Number.POSITIVE_INFINITY)
    assert.equal(calls('thread/turns/list').length, 2)
  })
})
