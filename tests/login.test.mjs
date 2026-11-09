import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineLogin, explainTurnError, loginTarget, LoginFlows, parseLoginStatus, pollLogin, readLoginStatus } from '../src/login.ts'
import { orderAccessPresets } from '../src/client/access-order.ts'

const folder = mkdtempSync(join(tmpdir(), 'agent-bridge-login-'))
test.after(() => { rmSync(folder, { recursive: true }) })
let scripts = 0
const script = (text) => {
  scripts += 1
  const executable = join(folder, `engine-${String(scripts)}`)
  writeFileSync(executable, `#!${process.execPath}\n${text}\n`)
  chmodSync(executable, 0o755)
  return { engine: 'claude', executable, env: process.env }
}
const until = async (read) => {
  for (let tries = 0; tries < 200; tries += 1) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out')
}
const finished = (flows, key) => until(() => { const flow = flows.take(key); return flow?.state === 'running' ? undefined : flow })

test('login status: Claude reports JSON, also when it exits with 1', () => {
  assert.deepEqual(parseLoginStatus('claude', '{"loggedIn":false,"authMethod":"none"}', 1), { signedIn: false })
  assert.deepEqual(parseLoginStatus('claude', '{"loggedIn":true,"subscriptionType":"max"}', 0), { signedIn: true, plan: 'max' })
  assert.deepEqual(parseLoginStatus('claude', 'unknown command', 1), {})
})

test('login status: Codex reports text and an exit code', () => {
  assert.deepEqual(parseLoginStatus('codex', 'Logged in using ChatGPT', 0), { signedIn: true })
  assert.deepEqual(parseLoginStatus('codex', 'Not logged in', 1), { signedIn: false })
  assert.deepEqual(parseLoginStatus('codex', 'config error', 1), {})
})

test('login: an added instance signs in to its own folder', () => {
  assert.equal(engineLogin('claude', 'claude', '/x').env.CLAUDE_CONFIG_DIR, '/x')
  assert.equal(engineLogin('codex', 'codex', '/y').env.CODEX_HOME, '/y')
})

test('login: a signed-out turn tells the user what to do, and other errors stay', () => {
  assert.match(explainTurnError('Claude Code', 'Not logged in · Please run /login'), /Claude Code is not signed in\. Select Sign in/)
  assert.equal(explainTurnError('Claude Code', 'Rate limit reached'), 'Rate limit reached')
})

test('login: a flow gives the page, reports success one time and calls back', async () => {
  const flows = new LoginFlows()
  let called = 0
  flows.start('a', script("console.log('\\u001b[1mOpen https://example.test/login?a=1\\u001b[0m');process.exit(0)"), () => { called += 1 })
  const flow = await finished(flows, 'a')
  assert.equal(flow.state, 'succeeded')
  assert.equal(flow.url, 'https://example.test/login?a=1')
  assert.equal(called, 1)
  assert.equal(flows.take('a'), undefined)
})

test('login: a failed flow gives the last line of output', async () => {
  const flows = new LoginFlows()
  flows.start('a', script("console.error('first\\nport is busy');process.exit(3)"), () => { assert.fail('not signed in') })
  const flow = await finished(flows, 'a')
  assert.equal(flow.state, 'failed')
  assert.equal(flow.error, 'port is busy')
})

test('login: a second start uses the running flow, and cancel stops it', async () => {
  const flows = new LoginFlows()
  const login = script('setInterval(()=>{},1000)')
  const first = flows.start('a', login, () => {})
  assert.equal(first.state, 'running')
  assert.deepEqual(flows.start('a', login, () => {}), first)
  flows.cancel('a')
  assert.equal(flows.take('a'), undefined)
})

test('login: the time limit stops a flow', async () => {
  const flows = new LoginFlows(50)
  flows.start('a', script('setInterval(()=>{},1000)'), () => { assert.fail('not signed in') })
  assert.equal((await finished(flows, 'a')).state, 'failed')
})

test('permission order: Auto is third and Full access is last', () => {
  const value = values => orderAccessPresets(values.map(item => ({ value: item }))).map(item => item.value)
  assert.deepEqual(value(['read-only', 'workspace-write', 'danger-full-access', 'auto']), ['read-only', 'workspace-write', 'auto', 'danger-full-access'])
  assert.deepEqual(value(['read-only', 'danger-full-access']), ['read-only', 'danger-full-access'])
  assert.deepEqual(value(['auto', 'danger-full-access', 'read-only', 'workspace-write', 'x']), ['read-only', 'workspace-write', 'auto', 'x', 'danger-full-access'])
})

const statusScript = (engine, text) => ({ ...script(text), engine })

test('login status: the Claude command is asked with auth status, and a report is read from its output', async () => {
  const login = statusScript('claude', "if (process.argv.slice(2).join(' ') !== 'auth status') process.exit(9); console.log(JSON.stringify({ loggedIn: true, subscriptionType: 'pro' }))")
  assert.deepEqual(await readLoginStatus(login), { signedIn: true, plan: 'pro' })
})

test('login status: a Claude report with exit code 1 is still read', async () => {
  const login = statusScript('claude', "console.log(JSON.stringify({ loggedIn: false })); process.exit(1)")
  assert.deepEqual(await readLoginStatus(login), { signedIn: false })
})

test('login status: the Codex command is asked with login status', async () => {
  const login = statusScript('codex', "if (process.argv.slice(2).join(' ') !== 'login status') process.exit(9); console.log('Logged in')")
  assert.deepEqual(await readLoginStatus(login), { signedIn: true })
})

test('login status: Codex that says it is not signed in on stderr is read', async () => {
  const login = statusScript('codex', "console.error('Not logged in'); process.exit(1)")
  assert.deepEqual(await readLoginStatus(login), { signedIn: false })
})

test('login status: the environment of the instance reaches the command', async () => {
  const login = { ...engineLogin('claude', script("console.log(JSON.stringify({ loggedIn: process.env.CLAUDE_CONFIG_DIR === '/instance/home' }))").executable, '/instance/home') }
  assert.deepEqual(await readLoginStatus(login), { signedIn: true })
})

test('login status: a command that cannot run gives no answer', async () => {
  assert.deepEqual(await readLoginStatus({ engine: 'claude', executable: join(folder, 'missing'), env: process.env }), {})
})

test('login status: a command stopped by a signal gives no answer', async () => {
  assert.deepEqual(await readLoginStatus(statusScript('codex', "process.kill(process.pid, 'SIGKILL')")), {})
})

test('login status: output that is not clear gives no answer', async () => {
  assert.deepEqual(await readLoginStatus(statusScript('claude', "console.log('not json')")), {})
  assert.deepEqual(await readLoginStatus(statusScript('claude', "console.log(JSON.stringify({ other: 1 }))")), {})
})

test('login status: a Claude plan that is not text is left out', () => {
  assert.deepEqual(parseLoginStatus('claude', '{"loggedIn":true,"subscriptionType":5}', 0), { signedIn: true })
})

test('login: a turn error for a missing sign-in is explained for each form of the error', () => {
  for (const text of ['Not logged in', 'Please run /login', 'authentication_failed', 'run codex login first', 'HTTP 401 Unauthorized']) {
    assert.match(explainTurnError('Codex', text), /Codex is not signed in/, text)
  }
  assert.equal(explainTurnError('Codex', 'HTTP 500'), 'HTTP 500')
})

test('login: the default engine uses no separate folder', () => {
  const login = engineLogin('claude', 'claude', undefined)
  assert.equal(login.engine, 'claude')
  assert.equal(login.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR)
})

const targets = { claudeExecutable: '/bin/claude-x', codexExecutable: '/bin/codex-x', findInstance: (id) => { throw new Error(`unknown ${id}`) } }

test('login target: an engine with no sign-in command has no target, and no instance is looked up', () => {
  assert.equal(loginTarget('pi', 'nothing', targets), undefined)
  assert.equal(loginTarget('', undefined, targets), undefined)
})

test('login target: each default engine uses its own command', () => {
  assert.equal(loginTarget('claude', undefined, targets).login.executable, '/bin/claude-x')
  assert.equal(loginTarget('codex', undefined, targets).login.executable, '/bin/codex-x')
  assert.equal(loginTarget('codex', undefined, targets).key, 'codex')
})

test('login target: an instance has its own key, folder and command', () => {
  const findInstance = () => ({ id: 'work', engine: 'claude', label: 'W', home: '/instance/claude', binaryPath: '/bin/own-claude' })
  const target = loginTarget('claude', 'work', { ...targets, findInstance })
  assert.equal(target.key, 'claude@work')
  assert.equal(target.login.executable, '/bin/own-claude')
  assert.equal(target.login.env.CLAUDE_CONFIG_DIR, '/instance/claude')
})

test('login target: an instance with no command uses the command of its engine, and ~ expands', () => {
  const findInstance = () => ({ id: 'work', engine: 'codex', label: 'W', home: '~/.codex-work' })
  const target = loginTarget('codex', 'work', { ...targets, findInstance })
  assert.equal(target.login.executable, '/bin/codex-x')
  assert.equal(target.login.env.CODEX_HOME, join(homedir(), '.codex-work'))
})

test('login target: an unknown instance fails', () => {
  assert.throws(() => loginTarget('claude', 'nope', targets), /unknown nope/)
})

test('login poll: with no attempt, the state comes from the engine', async () => {
  let reads = 0
  const state = await pollLogin({ take: () => undefined }, 'a', {}, () => { reads += 1; return Promise.resolve({ signedIn: true, plan: 'pro' }) })
  assert.deepEqual(state, { signedIn: true, plan: 'pro' })
  assert.equal(reads, 1)
})

test('login poll: a running attempt starts no process', async () => {
  let reads = 0
  const state = await pollLogin({ take: () => ({ state: 'running', url: 'https://example.test/a' }) }, 'a', {}, () => { reads += 1; return Promise.resolve({ signedIn: false }) })
  assert.deepEqual(state, { flow: { state: 'running', url: 'https://example.test/a' } })
  assert.equal(reads, 0)
})

test('login poll: a finished attempt reports the new state with the attempt', async () => {
  const state = await pollLogin({ take: () => ({ state: 'succeeded' }) }, 'a', {}, () => Promise.resolve({ signedIn: true }))
  assert.deepEqual(state, { signedIn: true, flow: { state: 'succeeded' } })
})

test('login poll: a failed attempt keeps its error beside the state', async () => {
  const state = await pollLogin({ take: () => ({ state: 'failed', error: 'denied' }) }, 'a', {}, () => Promise.resolve({ signedIn: false }))
  assert.deepEqual(state, { signedIn: false, flow: { state: 'failed', error: 'denied' } })
})

test('login poll: the attempt of a real flow is removed after it is reported', async () => {
  const flows = new LoginFlows()
  flows.start('a', script('process.exit(0)'), () => {})
  await until(() => { const flow = flows.take('a'); return flow?.state === 'succeeded' ? flow : undefined })
  assert.deepEqual(await pollLogin(flows, 'a', {}, () => Promise.resolve({ signedIn: true })), { signedIn: true })
})

test('login: a command that cannot start fails the flow, and success is not called', async () => {
  const flows = new LoginFlows()
  flows.start('a', { engine: 'codex', executable: join(folder, 'missing'), env: process.env }, () => { assert.fail('not signed in') })
  const flow = await finished(flows, 'a')
  assert.equal(flow.state, 'failed')
  assert.match(flow.error, /ENOENT/)
})

test('login: a failure with no output names the exit code', async () => {
  const flows = new LoginFlows()
  flows.start('a', script('process.exit(4)'), () => { assert.fail('not signed in') })
  assert.equal((await finished(flows, 'a')).error, 'exit code 4')
})

test('login: terminal colors are removed from the error', async () => {
  const flows = new LoginFlows()
  flows.start('a', script("console.error('\\u001b[31mbad state\\u001b[0m');process.exit(2)"), () => {})
  assert.equal((await finished(flows, 'a')).error, 'bad state')
})

test('login: the first page stays when the engine prints another', async () => {
  const flows = new LoginFlows()
  flows.start('a', script("console.log('https://example.test/one');setTimeout(()=>{console.log('https://example.test/two');process.exit(0)},30)"), () => {})
  assert.equal((await finished(flows, 'a')).url, 'https://example.test/one')
})

test('login: a page printed on stderr is found', async () => {
  const flows = new LoginFlows()
  flows.start('a', script("console.error('Open https://example.test/err');process.exit(0)"), () => {})
  assert.equal((await finished(flows, 'a')).url, 'https://example.test/err')
})

test('login: a running attempt is reported each time, and a new start is allowed after the end', async () => {
  const flows = new LoginFlows()
  const login = script('setTimeout(()=>process.exit(0),80)')
  flows.start('a', login, () => {})
  assert.equal(flows.take('a').state, 'running')
  assert.equal(flows.take('a').state, 'running')
  await finished(flows, 'a')
  assert.equal(flows.start('a', login, () => {}).state, 'running')
  flows.cancel('a')
})

test('login: a cancelled attempt never reports success', async () => {
  const flows = new LoginFlows()
  let called = 0
  flows.start('a', script('setInterval(()=>{},1000)'), () => { called += 1 })
  flows.cancel('a')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(called, 0)
  assert.equal(flows.take('a'), undefined)
})

test('login: a cancel with no attempt does nothing', () => {
  new LoginFlows().cancel('missing')
})

test('login: closing stops all attempts', () => {
  const flows = new LoginFlows()
  const login = script('setInterval(()=>{},1000)')
  flows.start('a', login, () => {})
  flows.start('b', login, () => {})
  flows.closeAll()
  assert.equal(flows.take('a'), undefined)
  assert.equal(flows.take('b'), undefined)
})

test('login: attempts of two providers are separate', async () => {
  const flows = new LoginFlows()
  const called = []
  flows.start('a', script('process.exit(0)'), () => called.push('a'))
  flows.start('b', script('process.exit(1)'), () => called.push('b'))
  assert.equal((await finished(flows, 'a')).state, 'succeeded')
  assert.equal((await finished(flows, 'b')).state, 'failed')
  assert.deepEqual(called, ['a'])
})
