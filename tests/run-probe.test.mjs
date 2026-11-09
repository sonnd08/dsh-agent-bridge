import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseOptions, isSignedIn, probeInfo, promptOf, RunManager } from '../src/run.ts'

const folder = mkdtempSync(join(tmpdir(), 'bridge-run-'))
test.after(() => { rmSync(folder, { recursive: true, force: true }) })
let made = 0

/** Writes a stand-in for the Claude executable. It answers the SDK start-up, then plays `plan` after the user message. */
const standIn = (plan) => {
  made += 1
  const log = join(folder, `calls-${String(made)}.jsonl`)
  const executable = join(folder, `claude-${String(made)}`)
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs')
const plan = ${JSON.stringify(plan)}
const write = message => process.stdout.write(JSON.stringify(message) + '\\n')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2) }) + '\\n')
if (plan.failAtStart !== undefined) { process.stderr.write(plan.failAtStart); process.exit(1) }
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const kind = message.request.subtype
    const response = kind === 'initialize' ? plan.initialize : kind === 'mcp_status' ? { mcpServers: plan.mcp ?? [] } : {}
    write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
    if (kind === 'interrupt') setTimeout(() => process.exit(0), 10)
  }
  if (message.type === 'user') {
    for (const item of plan.after ?? []) write(item)
    if (plan.exit !== undefined) setTimeout(() => process.exit(plan.exit), 10)
  }
})
`)
  chmodSync(executable, 0o755)
  return { executable, calls: () => readFileSync(log, 'utf8').trim().split('\n').map(item => JSON.parse(item)) }
}

const initialize = (change = {}) => ({ commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {}, ...change })
const init = (change = {}) => ({ type: 'system', subtype: 'init', session_id: 'S1', model: 'model-one', tools: [], mcp_servers: [], apiKeySource: 'none', cwd: '/w', slash_commands: [], output_style: 'default', permissionMode: 'default', uuid: 'u', ...change })
const options = (executable, change = {}) => ({ cwd: folder, text: '', executable, permissionMode: 'default', allowedTools: [], computerUse: false, peekabooCommand: 'x', memory: '', ...change })
const until = async (read) => {
  for (let tries = 0; tries < 300; tries += 1) {
    const value = read()
    if (value !== undefined && value !== false) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out')
}

test('probe: the models, commands, MCP servers and account of the executable are reported', async () => {
  const fake = standIn({
    initialize: initialize({
      commands: [{ name: 'review', description: 'Review', argumentHint: '[pr]' }],
      models: [{ value: 'model-one', displayName: 'Model One', description: 'd', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsFastMode: true }],
      account: { email: 'user@example.test', subscriptionType: 'max', apiProvider: 'firstParty', tokenSource: 'claude.ai' },
    }),
    mcp: [{ name: 'files', status: 'connected', scope: 'user', tools: [{ name: 'a' }, { name: 'b' }] }, { name: 'bad', status: 'failed', error: 'no' }],
    after: [init({ effort: 'high' })],
  })
  assert.deepEqual(await probeInfo(options(fake.executable)), {
    models: [{ value: 'model-one', name: 'Model One', description: 'd', efforts: ['low', 'high'], fastTier: 'fast' }],
    defaults: { model: 'Model One', effort: 'high' },
    commands: [{ name: 'review', description: 'Review', argumentHint: '[pr]' }],
    mcp: [{ name: 'files', status: 'connected', scope: 'user', tools: 2 }, { name: 'bad', status: 'failed', error: 'no' }],
    account: { loggedIn: true, email: 'user@example.test', plan: 'max', provider: 'firstParty' },
  })
})

test('probe: the probe leaves no session behind', async () => {
  const fake = standIn({ initialize: initialize(), after: [init()] })
  await probeInfo(options(fake.executable))
  assert.ok(fake.calls()[0].args.includes('--no-session-persistence'))
})

test('probe: a model with no effort support has no levels and no fast tier', async () => {
  const fake = standIn({ initialize: initialize({ models: [{ value: 'small', displayName: 'Small', description: '', supportedEffortLevels: ['low'] }] }), after: [init({ model: 'small' })] })
  const info = await probeInfo(options(fake.executable))
  assert.deepEqual(info.models, [{ value: 'small', name: 'Small', description: '', efforts: [] }])
})

test('probe: an account with no login is reported as not signed in', async () => {
  const fake = standIn({ initialize: initialize({ account: { tokenSource: 'none', apiProvider: 'firstParty' } }), after: [init()] })
  assert.deepEqual((await probeInfo(options(fake.executable))).account, { loggedIn: false, provider: 'firstParty' })
})

test('probe: with no effort in the init message, the saved setting of the folder is used', async () => {
  const home = join(folder, 'config-home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ effortLevel: 'low' }))
  const fake = standIn({ initialize: initialize(), after: [init()] })
  assert.equal((await probeInfo(options(fake.executable, { configDir: home }))).defaults.effort, 'low')
})

test('probe: with no effort anywhere, no effort is named', async () => {
  const home = join(folder, 'empty-home')
  mkdirSync(home, { recursive: true })
  const fake = standIn({ initialize: initialize(), after: [init()] })
  assert.equal('effort' in (await probeInfo(options(fake.executable, { configDir: home }))).defaults, false)
})

test('probe: an executable that ends with no init message fails', async () => {
  const fake = standIn({ initialize: initialize(), after: [], exit: 0 })
  await assert.rejects(probeInfo(options(fake.executable)), /no init message/)
})

test('probe: an executable that fails to start fails the probe', async () => {
  const fake = standIn({ failAtStart: 'cannot start' })
  await assert.rejects(probeInfo(options(fake.executable)))
})

test('sign-in report: a usable login needs an email, a token, a key or an external provider', () => {
  assert.equal(isSignedIn({ apiProvider: 'firstParty' }), false)
  assert.equal(isSignedIn({ tokenSource: 'none', apiKeySource: 'none' }), false)
  assert.equal(isSignedIn({ apiKeySource: 'user' }), true)
  assert.equal(isSignedIn({ tokenSource: 'oauth' }), true)
})

const base = (change = {}) => baseOptions(options('/bin/claude', { text: 't', cwd: '/w', ...change }))

test('turn options: a resumed session names its id, and a new one names none', () => {
  assert.equal(base({ sessionId: 'abc' }).resume, 'abc')
  assert.equal('resume' in base(), false)
})

test('turn options: only known reasoning levels are sent', () => {
  assert.equal(base({ effort: 'high' }).effort, 'high')
  assert.equal('effort' in base({ effort: 'turbo' }), false)
  assert.equal('effort' in base({ effort: '' }), false)
})

test('turn options: speed sets the fast mode, and no speed leaves the setting', () => {
  assert.deepEqual(base({ speed: 'fast' }).settings, { fastMode: true })
  assert.deepEqual(base({ speed: '' }).settings, { fastMode: false })
  assert.equal('settings' in base(), false)
})

test('turn options: an empty model is not sent', () => {
  assert.equal(base({ model: 'm' }).model, 'm')
  assert.equal('model' in base({ model: '' }), false)
})

test('turn options: full access needs the second flag', () => {
  assert.equal(base({ permissionMode: 'bypassPermissions' }).allowDangerouslySkipPermissions, true)
  assert.equal('allowDangerouslySkipPermissions' in base(), false)
})

test('turn options: an added instance uses its folder and arguments', () => {
  const made = base({ configDir: '/h', extraArgs: { chrome: null } })
  assert.equal(made.env.CLAUDE_CONFIG_DIR, '/h')
  assert.deepEqual(made.extraArgs, { chrome: null })
})

test('turn options: memory goes in the system prompt, and no memory adds nothing', () => {
  assert.match(base({ memory: 'remember x' }).systemPrompt.append, /remember x/)
  assert.equal('systemPrompt' in base(), false)
})

test('turn options: the browser and screen servers follow the settings', () => {
  assert.equal('mcpServers' in base(), false)
  const screen = base({ computerUse: true, peekabooCommand: '/bin/peek' })
  assert.deepEqual(Object.keys(screen.mcpServers), ['peekaboo-dsh'])
  assert.equal(screen.mcpServers['peekaboo-dsh'].command, '/bin/peek')
  const browser = base({ browserUse: true })
  assert.ok(browser.mcpServers['playwright-dsh'].args.includes('--headless'))
  assert.ok(!base({ browserUse: true, browserHeaded: true }).mcpServers['playwright-dsh'].args.includes('--headless'))
})

test('turn options: extra folders are readable', () => {
  assert.deepEqual(base({ additionalDirectories: ['/a'] }).additionalDirectories, ['/a'])
})

test('prompt: text alone is plain text, and images make a message with the text last', async () => {
  assert.equal(promptOf({ text: 'hi' }), 'hi')
  assert.equal(promptOf({ text: 'hi', images: [] }), 'hi')
  const messages = []
  for await (const message of promptOf({ text: 'hi', images: [{ mime: 'image/png', base64: 'AA' }] })) messages.push(message)
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].message.content.map(block => block.type), ['image', 'text'])
})

test('run: a new turn gets the id of the session, and a failed result ends it with the error', async () => {
  const fake = standIn({ initialize: initialize(), after: [init(), { type: 'result', subtype: 'success', is_error: true, result: 'quota', duration_ms: 1, duration_api_ms: 1, num_turns: 1, session_id: 'S1', total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: 'u2' }], exit: 0 })
  const runs = new RunManager()
  const events = []
  const id = await runs.start(options(fake.executable, { text: 'hi' }))
  assert.equal(id, 'S1')
  runs.subscribe(id, event => events.push(event))
  await until(() => events.some(event => event.kind === 'ended'))
  assert.deepEqual(events.at(-1), { kind: 'ended', status: 'error', error: 'quota' })
  assert.equal(runs.isRunning(id), false)
})

test('run: a resumed session is running at once, and a second turn is refused', async () => {
  const fake = standIn({ initialize: initialize(), after: [] })
  const runs = new RunManager()
  const id = await runs.start(options(fake.executable, { sessionId: 'S2', text: 'first' }))
  assert.equal(id, 'S2')
  assert.equal(runs.isRunning('S2'), true)
  assert.equal(runs.runningPrompt('S2'), 'first')
  await assert.rejects(runs.start(options(fake.executable, { sessionId: 'S2', text: 'second' })), /already running/)
  await runs.closeAll()
})

test('run: a process that fails before the session starts rejects the turn', async () => {
  const fake = standIn({ failAtStart: 'cannot start' })
  await assert.rejects(new RunManager().start(options(fake.executable, { text: 'hi' })))
})

test('run: nothing running has nothing to answer or stop', async () => {
  const runs = new RunManager()
  assert.equal(runs.answer('none', 'r', { behavior: 'allow' }), false)
  assert.equal(await runs.interrupt('none'), false)
  assert.equal(runs.runningPrompt('none'), undefined)
  assert.equal(runs.isRunning('none'), false)
})
