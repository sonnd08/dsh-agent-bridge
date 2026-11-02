/**
 * Acceptance for Pi sessions: real `pi` turns through a running dsh web instance. The instance needs
 * PI_CODING_AGENT_SESSION_DIR=<DEV_HOME>/pi-sessions, so no real session list is touched; turns run only in
 * /tmp/ee-pi-live. Costs a few real model calls.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const require = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')

const DEV_HOME = process.env.DEV_HOME ?? `${homedir()}/.local/share/dsh-dev-home`
const BASE = process.env.DEV_BASE ?? 'http://127.0.0.1:16777'
const PI = process.env.PI_COMMAND ?? `${homedir()}/.local/bin/pi`
const SESSIONS = `${DEV_HOME}/pi-sessions`
const EVIDENCE = fileURLToPath(new URL('../.evidence/pi/', import.meta.url))
const LIVE_CWD = '/tmp/ee-pi-live'
const TURN_MS = 180_000
rmSync(LIVE_CWD, { recursive: true, force: true })
mkdirSync(LIVE_CWD, { recursive: true })
mkdirSync(EVIDENCE, { recursive: true })

const token = [...readFileSync(`${DEV_HOME}/logs/dev-web.log`, 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
if (token === undefined) throw new Error('no login token in the dev log; is the dev instance running?')

// A session the Pi CLI itself wrote, before the plugin touches anything.
const cliId = randomUUID()
execFileSync(PI, ['-p', '--session-id', cliId, 'Reply with exactly the single word CLIWORD'], {
  cwd: LIVE_CWD, env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: SESSIONS }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
})
const fileOf = id => readdirSync(SESSIONS, { recursive: true }).find(name => String(name).endsWith(`_${id}.jsonl`))

const results = []
const pageErrors = []
async function step(name, fn) {
  try {
    await fn()
    results.push(true)
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push(false)
    await page.screenshot({ path: `${EVIDENCE}fail-${results.length}.png` }).catch(() => {})
    console.log(`FAIL  ${name}\n      ${String(error.message ?? error).split('\n').slice(0, 4).join('\n      ')}`)
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', error => pageErrors.push(error.message))
const tid = id => page.locator(`[data-testid="${id}"]`)
const summary = () => tid('ext-summary')
const sessionId = () => summary().getAttribute('data-session')
const listed = () => page.evaluate(async () => (await (await fetch('/api/agent-bridge/sessions', { credentials: 'same-origin' })).json()).sessions)
const assistantTexts = () => page.locator('[data-testid="ext-message"][data-role="assistant"] [data-testid="ext-text"]').allInnerTexts()
async function send(text) {
  await tid('ext-input').fill(text)
  await tid('ext-send').click()
  await page.locator('[data-testid="ext-summary"][data-running="true"]').waitFor({ timeout: 20000 })
}
async function turnEnd() {
  await page.locator('[data-testid="ext-summary"][data-running="false"]').waitFor({ timeout: TURN_MS })
  await page.waitForTimeout(1500)
}
async function menuAction(id) {
  const item = tid(id)
  if (!await item.isVisible().catch(() => false)) await tid('ext-more').click()
  await item.click()
}
async function openTree() {
  const ungrouped = page.getByRole('treeitem').filter({ hasText: /^(Ungrouped|未分组)$/ }).first()
  await ungrouped.waitFor({ timeout: 15000 })
  if (await ungrouped.getAttribute('aria-expanded') === 'false') await ungrouped.click()
}

await page.goto(`${BASE}/?token=${token}`)
for (const name of [/^Continue$/, /^Configure later$/]) {
  await page.locator('button', { hasText: name }).click({ timeout: 6000 }).catch(() => {})
}
// A fresh home also asks to sign in; the dialog closes on Escape.
for (let i = 0; i < 4 && await page.locator('[role="dialog"]').count() > 0; i++) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}

await step('a session the Pi CLI wrote is listed with the Pi mark', async () => {
  const row = (await listed()).find(item => item.id === `pi:${cliId}`)
  assert(row !== undefined, 'the CLI session should be listed')
  assert(row.cwd === LIVE_CWD || row.cwd === `/private${LIVE_CWD}`, `cwd is ${row.cwd}`)
  await openTree()
  const more = page.locator('button', { hasText: /more sessions|更多会话/ })
  while (await more.count() > 0) { await more.first().click(); await page.waitForTimeout(300) }
  const item = page.getByRole('treeitem').filter({ hasText: 'CLIWORD' }).first()
  await item.waitFor({ timeout: 15000 })
  assert(await item.locator('[data-engine="pi"]').count() === 1, 'the row should carry the Pi mark')
})

await step('opening it shows the transcript the CLI wrote, without the system prompt', async () => {
  await page.getByRole('treeitem').filter({ hasText: 'CLIWORD' }).first().click()
  await page.locator('[data-testid="ext-message"][data-role="assistant"]').first().waitFor({ timeout: 15000 })
  assert((await assistantTexts()).some(text => text.includes('CLIWORD')), `assistant text: ${JSON.stringify(await assistantTexts())}`)
  assert(!(await tid('ext-panel').innerText()).includes('expert coding assistant'), 'the system prompt must stay hidden')
  await page.screenshot({ path: `${EVIDENCE}01-cli-session.png` })
})

await step('the composer warns that Pi does not ask, and offers no goal', async () => {
  const placeholder = await tid('ext-input').getAttribute('placeholder')
  assert(/without asking|不会询问/.test(placeholder), `placeholder: ${placeholder}`)
  assert(await tid('ext-goal-toggle').count() === 0, 'Pi has no goals, so the toggle must be absent')
  assert(await tid('ext-permission-trigger').count() === 0, 'Pi has no permission system, so the control must be absent')
})

await step('continuing keeps the context and writes to the same CLI session file', async () => {
  const before = readFileSync(`${SESSIONS}/${fileOf(cliId)}`, 'utf8').length
  await send('Which single word did I ask you to reply with? Answer with just that word.')
  await turnEnd()
  assert((await assistantTexts()).filter(text => text.includes('CLIWORD')).length >= 2, `assistant text: ${JSON.stringify(await assistantTexts())}`)
  assert(readFileSync(`${SESSIONS}/${fileOf(cliId)}`, 'utf8').length > before, 'the CLI session file should grow')
  assert(await sessionId() === `pi:${cliId}`, 'the panel should stay on the session')
  assert(await tid('ext-usage').count() === 1, 'token totals should show')
})

let newId
await step('a new Pi session from the draft row: the model list works, the reply arrives, the session is listed', async () => {
  await openTree()
  await page.getByRole('treeitem').filter({ hasText: /New Pi session|新建 Pi 会话/ }).first().click()
  await tid('ext-cwd').fill(LIVE_CWD)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ext-model"] option').length > 3, undefined, { timeout: 30000 })
  await send('Run the shell command: echo pi-tool-ok . Then reply with exactly the word FINISHED')
  await turnEnd()
  newId = await sessionId()
  assert(newId.startsWith('pi:') && newId !== 'pi:new', `panel should show the created session, got ${newId}`)
  assert((await listed()).some(item => item.id === newId), 'the new session should be listed')
  assert((await assistantTexts()).some(text => text.includes('FINISHED')), `assistant text: ${JSON.stringify(await assistantTexts())}`)
  assert((await tid('ext-panel').innerText()).includes('echo pi-tool-ok'), 'the command should show as a tool card')
  await page.screenshot({ path: `${EVIDENCE}02-new-session.png` })
})

await step('rename reaches the session file and the list', async () => {
  await menuAction('ext-rename')
  await tid('ext-rename-input').fill('renamed pi session')
  await tid('ext-rename-save').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="ext-title"]')?.textContent?.includes('renamed pi session'), undefined, { timeout: 20000 })
  assert(readFileSync(`${SESSIONS}/${fileOf(newId.slice(3))}`, 'utf8').includes('"session_info"'), 'the name should be in the session file')
  assert((await listed()).find(item => item.id === newId).title === 'renamed pi session', 'the list should carry the new title')
})

await step('stop ends a long turn without an error, and the session still works', async () => {
  await send('Run the shell command: sleep 120 . Then reply with the word LATE')
  await page.waitForTimeout(4000)
  await tid('ext-stop').click()
  await page.locator('[data-testid="ext-summary"][data-running="false"]').waitFor({ timeout: 30000 })
  assert(await tid('ext-error').count() === 0, `unexpected error: ${await tid('ext-error').innerText().catch(() => '')}`)
  await page.waitForTimeout(1000)
  await send('Reply with exactly the word AFTERSTOP')
  await turnEnd()
  assert((await assistantTexts()).some(text => text.includes('AFTERSTOP')), `assistant text: ${JSON.stringify(await assistantTexts())}`)
})

await step('fork copies the session and delete removes its file', async () => {
  await menuAction('ext-fork')
  await page.waitForFunction(old => document.querySelector('[data-testid="ext-summary"]')?.getAttribute('data-session') !== old, newId, { timeout: 30000 })
  const copy = await sessionId()
  assert(copy.startsWith('pi:'), `fork opened ${copy}`)
  await page.locator('[data-testid="ext-message"]').first().waitFor({ timeout: 15000 })
  await menuAction('ext-delete')
  await tid('ext-delete-confirm').click()
  await page.waitForFunction(id => !document.querySelector(`[data-testid="ext-summary"][data-session="${id}"]`), copy, { timeout: 20000 })
  assert(fileOf(copy.slice(3)) === undefined, 'the fork file should be gone')
  assert(!(await listed()).some(item => item.id === copy), 'the fork should be off the list')
  assert(existsSync(`${SESSIONS}/${fileOf(newId.slice(3))}`), 'the source session must survive')
})

await step('search finds a word from a Pi session', async () => {
  const hits = await page.evaluate(async () => (await (await fetch('/api/agent-bridge/search?q=AFTERSTOP', { credentials: 'same-origin' })).json()).hits)
  assert(hits.some(hit => hit.id === newId), `hits: ${JSON.stringify(hits).slice(0, 300)}`)
})

await step('no uncaught page errors', async () => {
  assert(pageErrors.length === 0, pageErrors.join('; '))
})

await browser.close()
const failed = results.filter(ok => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
