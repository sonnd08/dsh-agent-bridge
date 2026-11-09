import test from 'node:test'
import assert from 'node:assert/strict'

const { render, act, React } = await import('./support/dom.mjs')

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const settle = () => act(() => new Promise((resolve) => { setTimeout(resolve, 0) }))
const realFetch = globalThis.fetch
test.afterEach(() => { globalThis.fetch = realFetch; document.body.replaceChildren() })

test('model preferences: an error answer keeps the empty preferences and a later mount retries', async (context) => {
  context.mock.method(console, 'warn', () => {})
  const { useModelPrefs } = await import('../src/client/model-prefs-store.ts?error')
  let answer = json({ error: 'boom' }, 500)
  globalThis.fetch = async () => answer
  let seen
  const Probe = () => { [seen] = useModelPrefs(); return null }
  const first = await render(React.createElement(Probe))
  await settle()
  assert.deepEqual(seen.favorites, [])
  await first.unmount()
  answer = json({ engines: {}, favorites: ['claude/opus'] })
  const second = await render(React.createElement(Probe))
  await settle()
  assert.deepEqual(seen.favorites, ['claude/opus'])
  await second.unmount()
})

test('model preferences: a save made during the first load is not replaced by the load', async () => {
  const { useModelPrefs } = await import('../src/client/model-prefs-store.ts?race')
  let finish
  globalThis.fetch = (_url, init) => init?.method === 'POST' ? Promise.resolve(json({})) : new Promise((resolve) => { finish = resolve })
  let seen
  let save
  const Probe = () => { [seen, save] = useModelPrefs(); return null }
  const view = await render(React.createElement(Probe))
  await act(() => { save({ engines: {}, favorites: ['mine'] }) })
  await act(async () => { finish(json({ engines: {}, favorites: ['old'] })); await new Promise((resolve) => { setTimeout(resolve, 0) }) })
  assert.deepEqual(seen.favorites, ['mine'])
  await view.unmount()
})

test('provider list: an error answer does not throw, and a later mount retries', async (context) => {
  context.mock.method(console, 'warn', () => {})
  const { useProviders } = await import('../src/client/providers-store.ts?error')
  let answer = json({ error: 'boom' }, 500)
  let asked = 0
  globalThis.fetch = async () => { asked += 1; return answer }
  let seen
  const Probe = () => { ({ providers: seen } = useProviders()); return null }
  const first = await render(React.createElement(Probe))
  await settle()
  assert.ok(seen.length > 0)
  await first.unmount()
  answer = json({ instances: [{ id: 'extra', engine: 'claude', label: 'Extra', home: '/invented/x' }] })
  const second = await render(React.createElement(Probe))
  await settle()
  assert.equal(asked, 2)
  assert.ok(seen.some(item => item.id === 'claude@extra'))
  await second.unmount()
})

test('info: an error belongs to its folder and does not stay after the folder changes', async () => {
  const { useInfo, useInfos } = await import('../src/client/info.ts?error')
  globalThis.fetch = async url => String(url).includes('bad') ? json({ error: 'failed' }, 500) : json({ models: [], commands: [], mcp: [] })
  let one
  let many
  const Probe = ({ cwd }) => { one = useInfo('claude', cwd); many = useInfos(['claude'], cwd); return null }
  const view = await render(React.createElement(Probe, { cwd: '/invented/bad' }))
  await settle()
  assert.equal(one.error, 'failed')
  assert.equal(many.claude.error, 'failed')
  await view.update(React.createElement(Probe, { cwd: '' }))
  await settle()
  assert.equal(one.error, undefined)
  assert.equal(many.claude.error, undefined)
  await view.unmount()
})

test('info: an error page that is not JSON reports its status', async () => {
  const { loadInfo } = await import('../src/client/info.ts?html')
  globalThis.fetch = async () => new Response('<html>', { status: 502 })
  await assert.rejects(loadInfo('claude', '/invented/a'), /HTTP 502/)
})

test('sign-in: an answer that started before Sign in does not clear the attempt', async () => {
  const store = await import('../src/client/login-store.ts?stale')
  const pending = []
  globalThis.fetch = (url, init) => init?.method === 'POST'
    ? new Promise(() => {})
    : new Promise((resolve) => { pending.push(resolve); void url })
  let seen
  const Probe = () => { seen = store.useLogins(['p1']).p1; return null }
  const view = await render(React.createElement(Probe))
  await act(() => { void store.startLogin('p1') })
  assert.equal(seen.flow.state, 'running')
  await act(async () => { pending[0](json({ signedIn: false })); await new Promise((resolve) => { setTimeout(resolve, 0) }) })
  assert.equal(seen.flow.state, 'running')
  await view.unmount()
})

test('sign-in: each success text stays for the full time', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const original = { set: window.setTimeout, clear: window.clearTimeout }
  window.setTimeout = (...args) => setTimeout(...args)
  window.clearTimeout = id => clearTimeout(id)
  context.after(() => { window.setTimeout = original.set; window.clearTimeout = original.clear })
  const store = await import('../src/client/login-store.ts?done')
  const answers = [json({ flow: { state: 'succeeded' }, signedIn: true }), json({ flow: { state: 'succeeded' }, signedIn: true })]
  globalThis.fetch = async () => answers.shift() ?? json({})
  let seen
  const Probe = () => { seen = store.useLogins([]).p2; return null }
  const view = await render(React.createElement(Probe))
  await act(() => store.refreshLogin('p2', true))
  await act(() => { context.mock.timers.tick(5_000) })
  await act(() => store.refreshLogin('p2', true))
  await act(() => { context.mock.timers.tick(5_000) })
  assert.equal(seen.flow.state, 'succeeded', 'the first timer must not remove the second text')
  await act(() => { context.mock.timers.tick(3_000) })
  assert.equal(seen.flow, undefined)
  await view.unmount()
})

test('sign-in: an error page that is not JSON shows its status', async () => {
  const store = await import('../src/client/login-store.ts?html')
  globalThis.fetch = async (_url, init) => init?.method === 'POST' ? new Response('<html>', { status: 502 }) : json({ signedIn: false })
  let seen
  const Probe = () => { seen = store.useLogins(['p3']).p3; return null }
  const view = await render(React.createElement(Probe))
  await settle()
  await act(() => store.startLogin('p3'))
  assert.equal(seen.flow.error, 'HTTP 502')
  await view.unmount()
})
