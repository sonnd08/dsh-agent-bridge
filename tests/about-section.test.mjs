import test from 'node:test'
import assert from 'node:assert/strict'

const { render, click, act, byTestId, t, React } = await import('./support/dom.mjs')
const { ABOUT_PATH, INFO_PATH, INSTANCES_PATH, LOGIN_PATH, MODEL_PREFS_PATH } = await import('../src/protocol.ts')
const { AboutSection } = await import('../src/client/AboutSection.tsx')

test.afterEach(() => { document.body.replaceChildren() })

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const settle = () => act(() => new Promise((resolve) => { setTimeout(resolve, 0) }))

const ABOUT = {
  plugin: '9.8.7', sdk: '6.5.4', dsh: '3.2.1', dshVerified: ['3.2.1', '3.2.0'],
  engines: [
    { engine: 'claude', enabled: true, executable: '/invented/bin/claude', version: '1.0.0', verified: ['1.0.0'] },
    { engine: 'codex', enabled: true, executable: '/invented/bin/codex', version: '2.0.0', verified: ['1.9.0'] },
  ],
}

/** `about` answers each request of the about route. */
const server = { about: () => json(ABOUT), requests: 0 }
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).split('?')[0]
  if (path === ABOUT_PATH) { server.requests += 1; return server.about() }
  if (path === INFO_PATH) return json({ models: [], commands: [], mcp: [] })
  if (path === LOGIN_PATH) return json({})
  if (path === MODEL_PREFS_PATH) return json(init.method === 'POST' ? {} : { engines: {}, favorites: [] })
  if (path === INSTANCES_PATH) return json({ instances: [] })
  throw new Error(`unexpected request: ${String(url)}`)
}
test.after(() => { globalThis.fetch = realFetch })
test.beforeEach(() => { Object.assign(server, { about: () => json(ABOUT), requests: 0 }) })

function deferred() {
  let resolve, reject
  const promise = new Promise((good, bad) => { resolve = good; reject = bad })
  return { promise, resolve, reject }
}

let cases = 0
async function mount({ codexEnabled = true } = {}) {
  cases += 1
  const cwd = `/invented/about-${cases}`
  const view = await render(React.createElement(AboutSection, { t, getDefaultCwd: () => cwd, codexEnabled: () => codexEnabled }))
  await settle()
  return view
}

const refresh = () => byTestId('about-refresh')
const text = () => byTestId('about-section').textContent
const aboutRow = id => byTestId(`about-${id}`)

test('about page: it shows a loading text and cannot refresh until the answer comes', async () => {
  const pending = deferred()
  server.about = () => pending.promise
  const view = await mount()
  assert.match(text(), /about\.loading/)
  assert.equal(refresh().disabled, true)
  await act(() => { pending.resolve(json(ABOUT)) })
  await settle()
  assert.doesNotMatch(text(), /about\.loading/)
  assert.equal(refresh().disabled, false)
  await view.unmount()
})

test('about page: it names the plugin and the SDK version', async () => {
  const view = await mount()
  assert.match(text(), /about\.plugin9\.8\.7/)
  assert.match(text(), /about\.sdk6\.5\.4/)
  await view.unmount()
})

test('about page: DeepSeek Harness comes first and then each engine', async () => {
  const view = await mount()
  assert.deepEqual([...document.querySelectorAll('[data-testid^="about-"][data-status]')].map(item => item.dataset.testid), ['about-dsh', 'about-claude', 'about-codex'])
  await view.unmount()
})

test('about page: a row shows the name, version, verified versions and status', async () => {
  const view = await mount()
  const row = aboutRow('claude')
  assert.equal(row.dataset.status, 'verified')
  assert.match(row.textContent, /about\.name\.claude/)
  assert.match(row.textContent, /1\.0\.0/)
  assert.match(row.textContent, /about\.status\.verified/)
  assert.match(row.textContent, /about\.verified1\.0\.0/)
  assert.match(aboutRow('dsh').textContent, /about\.verified3\.2\.1, 3\.2\.0/)
  await view.unmount()
})

test('about page: a version outside the verified list says so', async () => {
  const view = await mount()
  assert.equal(aboutRow('codex').dataset.status, 'unverified')
  assert.match(aboutRow('codex').textContent, /about\.status\.unverified/)
  await view.unmount()
})

test('about page: an engine row shows its executable and the DeepSeek row has none', async () => {
  const view = await mount()
  assert.match(aboutRow('claude').textContent, /about\.executable\/invented\/bin\/claude/)
  assert.doesNotMatch(aboutRow('dsh').textContent, /about\.executable/)
  await view.unmount()
})

test('about page: an engine that cannot start shows missing and its error', async () => {
  server.about = () => json({ ...ABOUT, engines: [{ engine: 'claude', enabled: true, executable: 'claude', error: 'spawn claude ENOENT', verified: ['1.0.0'] }] })
  const view = await mount()
  assert.equal(aboutRow('claude').dataset.status, 'missing')
  assert.match(aboutRow('claude').textContent, /about\.status\.missing/)
  assert.match(aboutRow('claude').textContent, /spawn claude ENOENT/)
  assert.match(aboutRow('claude').textContent, /about\.unknown/, 'a row with no version says that it is not known')
  await view.unmount()
})

test('about page: a turned off engine reads off even when it runs', async () => {
  server.about = () => json({ ...ABOUT, engines: [{ engine: 'pi', enabled: false, executable: 'pi', version: '1.0.0', verified: ['1.0.0'] }] })
  const view = await mount()
  assert.equal(aboutRow('pi').dataset.status, 'off')
  assert.match(aboutRow('pi').textContent, /about\.status\.off/)
  await view.unmount()
})

test('about page: a host that reports no DeepSeek version shows unknown', async () => {
  const { dsh: _dsh, ...withoutDsh } = ABOUT
  server.about = () => json(withoutDsh)
  const view = await mount()
  assert.equal(aboutRow('dsh').dataset.status, 'unknown')
  assert.match(aboutRow('dsh').textContent, /about\.status\.unknown/)
  assert.match(aboutRow('dsh').textContent, /about\.unknown/)
  await view.unmount()
})

for (const [name, answer] of [
  ['an HTTP error', () => json({ error: 'no' }, 500)],
  ['a network failure', () => Promise.reject(new Error('offline'))],
  ['a body that is not JSON', () => new Response('not json', { status: 200 })],
]) {
  test(`about page: ${name} shows the failure text and refresh stays available`, async () => {
    server.about = answer
    const view = await mount()
    assert.match(text(), /about\.failed/)
    assert.doesNotMatch(text(), /about\.loading/)
    assert.equal(aboutRow('claude'), null)
    assert.equal(refresh().disabled, false)
    await view.unmount()
  })
}

test('about page: refresh after a failure can succeed', async () => {
  server.about = () => json({}, 500)
  const view = await mount()
  assert.match(text(), /about\.failed/)
  server.about = () => json(ABOUT)
  await click(refresh())
  await settle()
  assert.doesNotMatch(text(), /about\.failed/)
  assert.notEqual(aboutRow('claude'), null)
  assert.equal(server.requests, 2)
  await view.unmount()
})

test('about page: refresh asks again, shows loading while it waits, and shows the new answer', async () => {
  const view = await mount()
  const pending = deferred()
  server.about = () => pending.promise
  await click(refresh())
  assert.match(text(), /about\.loading/)
  assert.equal(aboutRow('claude'), null, 'the old rows are gone while it waits')
  assert.equal(refresh().disabled, true)
  await act(() => { pending.resolve(json({ ...ABOUT, plugin: '9.9.9' })) })
  await settle()
  assert.match(text(), /about\.plugin9\.9\.9/)
  assert.equal(server.requests, 2)
  await view.unmount()
})

test('about page: a failed refresh removes the old rows', async () => {
  const view = await mount()
  server.about = () => json({}, 500)
  await click(refresh())
  await settle()
  assert.match(text(), /about\.failed/)
  assert.equal(aboutRow('claude'), null)
  await view.unmount()
})

test('about page: an answer that comes after the page closes is ignored', async () => {
  const pending = deferred()
  server.about = () => pending.promise
  const view = await mount()
  await view.unmount()
  await act(() => { pending.resolve(json(ABOUT)) })
  await settle()
  assert.equal(aboutRow('claude'), null)
})

test('about page: the provider list is on the page', async () => {
  const view = await mount()
  assert.notEqual(byTestId('ext-models'), null)
  await view.unmount()
})

test('about page: the provider list uses the versions of the answer', async () => {
  const view = await mount()
  assert.match(byTestId('ext-models-engine-claude').textContent, /v1\.0\.0/)
  assert.match(byTestId('ext-models-engine-dsh').textContent, /v3\.2\.1/)
  await view.unmount()
})

test('about page: while it loads the plugin flag decides whether Codex is listed', async () => {
  const pending = deferred()
  server.about = () => pending.promise
  const view = await mount({ codexEnabled: false })
  assert.equal(byTestId('ext-models-provider-codex'), null)
  await act(() => { pending.resolve(json(ABOUT)) })
  await settle()
  assert.notEqual(byTestId('ext-models-provider-codex'), null, 'the answer decides once it arrives')
  await view.unmount()
})

test('about page: after a failure the plugin flag still decides whether Codex is listed', async () => {
  server.about = () => json({}, 500)
  const off = await mount({ codexEnabled: false })
  assert.equal(byTestId('ext-models-provider-codex'), null)
  await off.unmount()
  const on = await mount({ codexEnabled: true })
  assert.notEqual(byTestId('ext-models-provider-codex'), null)
  await on.unmount()
})

test('about page: an answer that turns Codex off removes it from the provider list', async () => {
  server.about = () => json({ ...ABOUT, engines: [ABOUT.engines[0], { ...ABOUT.engines[1], enabled: false }] })
  const view = await mount({ codexEnabled: true })
  assert.equal(byTestId('ext-models-provider-codex'), null)
  await view.unmount()
})
