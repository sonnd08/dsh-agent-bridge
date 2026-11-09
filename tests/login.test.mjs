import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineLogin, explainTurnError, LoginFlows, parseLoginStatus } from '../src/login.ts'
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
