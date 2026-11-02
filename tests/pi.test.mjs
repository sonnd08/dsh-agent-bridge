import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findPiFile, listPiRows, piSessionDir, PiEngine, readPiMessages, readPiUsage, searchPi } from '../src/pi.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))
let root, sessions, cwd, engine

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ee-pi-')))
  sessions = join(root, 'sessions')
  cwd = join(root, 'project')
  mkdirSync(sessions)
  mkdirSync(cwd)
  process.env.PI_CODING_AGENT_SESSION_DIR = sessions
  process.env.FAKE_PI_LOG = join(root, 'calls.jsonl')
  engine = new PiEngine(FAKE)
})

afterEach(() => {
  engine.closeAll()
  delete process.env.PI_CODING_AGENT_SESSION_DIR
  delete process.env.FAKE_PI_LOG
  rmSync(root, { recursive: true, force: true })
})

/** Collect a session's live events until its turn ends. */
function collect(id) {
  const events = []
  const ended = new Promise((resolve) => {
    engine.subscribe(id, (event) => {
      events.push(event)
      if (event.kind === 'ended') resolve(event)
    })
  })
  return { events, ended }
}

const texts = messages => messages.flatMap(message => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []))

/** Write a session file holding the given entries after the header. */
function sessionFile(id, entries, dir = join(sessions, '--project--')) {
  mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd }
  writeFileSync(join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`), [header, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n')
}

const entry = (id, parentId, message) => ({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00.000Z', message })
const userSays = text => ({ role: 'user', content: [{ type: 'text', text }] })
const assistantSays = text => ({ role: 'assistant', content: [{ type: 'text', text }], usage: { input: 5, output: 1, cacheRead: 2, cacheWrite: 3 } })

test('the session folder follows the environment overrides and otherwise is the home default', () => {
  assert.equal(piSessionDir(), sessions)
  delete process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_DIR = '/x/agent'
  assert.equal(piSessionDir(), '/x/agent/sessions')
  delete process.env.PI_CODING_AGENT_DIR
  assert.match(piSessionDir(), /\.pi\/agent\/sessions$/)
})

test('rows list sessions newest first, titled by the session name or the first message, skipping files that are not sessions', async () => {
  sessionFile('aaa', [entry('1', null, { role: 'system', content: '' }), entry('2', '1', userSays('fix the login page'))])
  sessionFile('bbb', [entry('1', null, userSays('old words')), { type: 'session_info', id: '2', parentId: '1', name: 'Named session' }])
  writeFileSync(join(sessions, 'stray.jsonl'), '{"type":"other"}\n')
  const rows = await listPiRows(10)
  assert.deepEqual(rows.map(row => row.id).sort(), ['pi:aaa', 'pi:bbb'])
  assert.equal(rows.find(row => row.id === 'pi:aaa').title, 'fix the login page')
  assert.equal(rows.find(row => row.id === 'pi:bbb').title, 'Named session')
  assert.equal(rows[0].cwd, cwd)
  assert.equal((await listPiRows(1)).length <= 1, true)
})

test('a missing session folder lists nothing instead of failing', async () => {
  rmSync(sessions, { recursive: true })
  assert.deepEqual(await listPiRows(10), [])
})

test('the transcript shows the active branch only, with tools paired, and hides the system prompt', async () => {
  sessionFile('tree', [
    entry('s', null, { role: 'system', content: '', sections: { preamble: 'secret prompt' } }),
    entry('u1', 's', userSays('first')),
    entry('abandoned', 'u1', assistantSays('abandoned branch')),
    entry('a1', 'u1', { role: 'assistant', content: [
      { type: 'thinking', thinking: 'let me look' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
    ], usage: { input: 5, output: 1, cacheRead: 2, cacheWrite: 3 } }),
    entry('r1', 'a1', { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'y'.repeat(30_000) }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }], isError: true }),
    entry('a2', 'r1', assistantSays('done')),
  ])
  const messages = await readPiMessages('tree')
  assert.deepEqual(messages.map(message => message.id), ['u1', 'a1', 'r1', 'a2'])
  assert.deepEqual(texts(messages), ['first', 'done'])
  assert.ok(!JSON.stringify(messages).includes('secret prompt'))
  assert.deepEqual(messages[1].blocks[0], { type: 'thinking', text: 'let me look' })
  const use = messages[1].blocks[1]
  assert.equal(use.name, 'command', 'bash draws as the command card')
  assert.deepEqual(use.args, { command: 'ls' })
  const result = messages[2].blocks[0]
  assert.equal(result.forId, 'call-1')
  assert.equal(result.isError, true)
  assert.ok(result.text.length <= 20_001, `tool output is ${result.text.length} characters`)
  assert.deepEqual(result.images, ['data:image/png;base64,QUJD'])
  assert.deepEqual(await readPiUsage('tree'), { input: 10, output: 2, cacheRead: 4, cacheWrite: 6 })
})

test('a half-written last line does not break reading, and a session without a file is empty', async () => {
  sessionFile('partial', [entry('u1', null, userSays('hello'))])
  const file = await findPiFile('partial')
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"type":"message","id":"a1"`)
  assert.deepEqual(texts(await readPiMessages('partial')), ['hello'])
  assert.deepEqual(await readPiMessages('nothing-here'), [])
  assert.equal(await readPiUsage('nothing-here'), undefined)
})

test('a failed assistant message with no content shows its error when reopened', async () => {
  sessionFile('failed', [entry('a', null, { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider is down' })])
  assert.deepEqual(texts(await readPiMessages('failed')), ['provider is down'])
})

test('search finds text in messages and returns a snippet', async () => {
  sessionFile('s1', [entry('u', null, userSays('the Quokka bug'))])
  sessionFile('s2', [entry('u', null, userSays('nothing relevant'))])
  const hits = await searchPi(await listPiRows(10), 'quokka', 10)
  assert.deepEqual(hits.map(hit => hit.id), ['pi:s1'])
  assert.match(hits[0].snippet, /Quokka/)
})

test('journey: new session, reply, reopen, continue', async () => {
  const id = await engine.start({ cwd, text: 'hello', model: 'acme/big', effort: 'high' })
  const first = collect(id)
  assert.deepEqual(await first.ended, { kind: 'ended', status: 'ok' })
  assert.deepEqual(first.events.filter(event => event.kind === 'delta').map(event => event.text).join(''), 'echo hello model=acme/big thinking=high')
  assert.deepEqual(texts(await readPiMessages(id)), ['hello', 'echo hello model=acme/big thinking=high'])
  const rows = await listPiRows(10)
  assert.deepEqual(rows.map(row => [row.id, row.title, row.cwd]), [[`pi:${id}`, 'hello', cwd]])
  assert.deepEqual(await readPiUsage(id), { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 })

  const second = collect(id)
  assert.equal(await engine.start({ sessionId: id, cwd, text: 'again' }), id)
  const end = await second.ended
  assert.deepEqual(end, { kind: 'ended', status: 'ok' })
  assert.deepEqual(texts(await readPiMessages(id)), ['hello', 'echo hello model=acme/big thinking=high', 'again', 'echo again model=- thinking=-'])
  const calls = readFileSync(process.env.FAKE_PI_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls[0].args, ['--mode', 'rpc', '--session-id', id, '--model', 'acme/big', '--thinking', 'high'])
  assert.deepEqual(calls[1].args, ['--mode', 'rpc', '--session', await findPiFile(id)])
  assert.ok(calls.every(call => call.cwd.endsWith('/project')), 'each turn runs in the session folder')
  assert.equal(engine.isRunning(id), false)
})

test('interrupting a running turn ends it as interrupted', async () => {
  const id = await engine.start({ cwd, text: 'hang here' })
  const { events, ended } = collect(id)
  assert.equal(engine.isRunning(id), true)
  await waitUntil(() => events.some(event => event.kind === 'message'))
  assert.equal(engine.interrupt(id), true)
  assert.deepEqual(await ended, { kind: 'ended', status: 'interrupted' })
  assert.ok(events.some(event => event.kind === 'message'), 'the user message was announced')
  assert.equal(engine.isRunning(id), false)
})

test('a running session refuses a second turn', async () => {
  const id = await engine.start({ cwd, text: 'hang here' })
  await assert.rejects(engine.start({ sessionId: id, cwd, text: 'second' }), /already running/)
})

test('a session that no longer exists says so instead of starting a new one', async () => {
  await assert.rejects(engine.start({ sessionId: 'gone', cwd, text: 'hi' }), /no longer exists/)
})

test('a model error is reported as the turn error', async () => {
  const id = await engine.start({ cwd, text: 'please fail' })
  const { ended } = collect(id)
  assert.deepEqual(await ended, { kind: 'ended', status: 'error', error: 'provider is down' })
  assert.deepEqual(texts(await readPiMessages(id)), ['please fail', 'provider is down'])
})

test('a child that dies mid-turn ends the turn with its error output', async () => {
  const id = await engine.start({ cwd, text: 'crash now' })
  const { ended } = collect(id)
  const end = await ended
  assert.equal(end.status, 'error')
  assert.match(end.error, /boom/)
  assert.equal(engine.isRunning(id), false)
})

test('a refused prompt fails the send and leaves nothing running', async () => {
  await assert.rejects(engine.start({ cwd, text: 'refuse this' }), /prompt refused/)
  assert.deepEqual(await listPiRows(10), [])
})

test('a missing executable fails the send with a readable error instead of crashing the host', async () => {
  const missing = new PiEngine(join(root, 'no-such-pi'))
  await assert.rejects(missing.start({ cwd, text: 'hi' }), /ENOENT|no-such-pi/)
})

test('a prompt an extension command consumes ends at once', async () => {
  const id = await engine.start({ cwd, text: '/handled now' })
  assert.equal(engine.isRunning(id), false)
})

test('a confirm dialog becomes a permission card and the answer reaches Pi', async () => {
  const id = await engine.start({ cwd, text: 'dialog please' })
  const { events, ended } = collect(id)
  await waitUntil(() => events.some(event => event.kind === 'permission'))
  const { permission } = events.find(event => event.kind === 'permission')
  assert.equal(permission.title, 'Allow it?')
  assert.equal(permission.input, 'rm -rf build')
  assert.equal(permission.questions, undefined)
  assert.equal(engine.answer(id, permission.requestId, { behavior: 'deny' }), true)
  await ended
  assert.ok(events.some(event => event.kind === 'permission_done'))
  assert.deepEqual(texts(await readPiMessages(id)).at(-1), 'confirmed=false')
  assert.equal(engine.answer(id, permission.requestId, { behavior: 'allow' }), false, 'nothing is pending after the turn')
})

test('a select dialog becomes a question whose answer reaches Pi', async () => {
  const id = await engine.start({ cwd, text: 'select please' })
  const { events, ended } = collect(id)
  await waitUntil(() => events.some(event => event.kind === 'permission'))
  const { permission } = events.find(event => event.kind === 'permission')
  assert.deepEqual(permission.questions[0].options.map(option => option.label), ['Red', 'Blue'])
  engine.answer(id, permission.requestId, { behavior: 'allow', answers: { 'Which one?': 'Blue' } })
  await ended
  assert.deepEqual(texts(await readPiMessages(id)).at(-1), 'picked=Blue')
})

test('a text-input dialog is cancelled at once so the turn cannot hang on it', async () => {
  const id = await engine.start({ cwd, text: 'input please' })
  await waitUntil(() => !engine.isRunning(id))
  assert.deepEqual(texts(await readPiMessages(id)).at(-1), 'cancelled=true')
})

test('interrupting answers an open dialog so the abort is not left waiting on it', async () => {
  const id = await engine.start({ cwd, text: 'dialog please' })
  const { events } = collect(id)
  await waitUntil(() => events.some(event => event.kind === 'permission'))
  engine.interrupt(id)
  await waitUntil(() => events.some(event => event.kind === 'permission_done'))
})

test('rename, fork and delete act on the session and survive in the list', async () => {
  const id = await engine.start({ cwd, text: 'hello' })
  await waitUntil(() => !engine.isRunning(id))
  await engine.rename(id, 'Better title')
  assert.equal((await listPiRows(10)).find(row => row.id === `pi:${id}`).title, 'Better title')
  const copy = await engine.fork(id)
  assert.notEqual(copy, id)
  assert.deepEqual(texts(await readPiMessages(copy)).slice(0, 1), ['hello'])
  const file = await findPiFile(id)
  await engine.delete(id)
  assert.equal(existsSync(file), false)
  assert.deepEqual((await listPiRows(10)).map(row => row.id), [`pi:${copy}`])
  await assert.rejects(engine.delete(id), /no longer exists/)
})

test('rename of a session whose folder is gone says what is wrong', async () => {
  const id = await engine.start({ cwd, text: 'hello' })
  await waitUntil(() => !engine.isRunning(id))
  rmSync(cwd, { recursive: true })
  await assert.rejects(engine.rename(id, 'x'), /working directory no longer exists/)
})

test('info names the models with provider, the levels each supports, the defaults, and the commands', async () => {
  const info = await engine.readInfo(cwd)
  assert.deepEqual(info.models.map(model => [model.value, model.name, model.isDefault === true]), [['acme/big', 'Acme Big', true], ['acme/small', 'Acme Small', false]])
  assert.deepEqual(info.models[0].efforts, ['minimal', 'low', 'medium', 'high', 'xhigh'], 'a null level is removed and only named extras are added')
  assert.deepEqual(info.models[1].efforts, [])
  assert.deepEqual(info.defaults, { model: 'Acme Big', effort: 'medium' })
  assert.deepEqual(info.commands.map(command => command.name), ['review'])
  const calls = readFileSync(process.env.FAKE_PI_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls[0].args, ['--mode', 'rpc', '--no-session'], 'asking for info creates no session')
  assert.deepEqual(await listPiRows(10), [])
})

async function waitUntil(condition, ms = 5000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
