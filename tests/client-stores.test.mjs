import test from 'node:test'
import assert from 'node:assert/strict'

const { render, act, React } = await import('./support/dom.mjs')

const INFO = '/api/agent-bridge/info'
const INSTANCES = '/api/agent-bridge/instances'
const PREFS = '/api/agent-bridge/model-prefs'

let serial = 0
/** Each test gets its own copy of a store, which keeps its state at module level. */
const fresh = async name => await import(`../src/client/${name}.ts?test=${String(++serial)}`)

const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function host(context, respond) {
  const calls = []
  context.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', credentials: init.credentials, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) }
    calls.push(call)
    return await respond(call, calls.length)
  })
  return calls
}

/** Mount a component that calls a hook, and read what it returned last. */
async function mount(useHook, props) {
  const seen = { value: undefined, renders: 0 }
  function Probe(current) {
    seen.value = useHook(current)
    seen.renders += 1
    return null
  }
  const view = await render(React.createElement(Probe, props))
  return { seen, unmount: view.unmount, change: next => view.update(React.createElement(Probe, next)) }
}

const info = name => ({ models: [{ value: name, name, description: '', efforts: [] }] })
const settle = () => act(() => {})

// loadInfo

test('info: the request names the engine and the folder', async (context) => {
  const calls = host(context, () => reply(info('alpha')))
  const { loadInfo } = await fresh('info')
  assert.deepEqual(await loadInfo('claude', '/work/one'), info('alpha'))
  assert.equal(calls[0].url, `${INFO}?engine=claude&cwd=%2Fwork%2Fone`)
  assert.equal(calls[0].credentials, 'same-origin')
})

test('info: the request of an added instance names the instance', async (context) => {
  const calls = host(context, () => reply(info('alpha')))
  const { loadInfo } = await fresh('info')
  await loadInfo('codex@spare', '/work/one')
  assert.equal(calls[0].url, `${INFO}?engine=codex&cwd=%2Fwork%2Fone&instance=spare`)
})

test('info: a second load of the same provider and folder uses the first answer', async (context) => {
  const calls = host(context, () => reply(info('alpha')))
  const { loadInfo } = await fresh('info')
  const first = await loadInfo('claude', '/work/one')
  assert.equal(await loadInfo('claude', '/work/one'), first)
  assert.equal(calls.length, 1)
})

test('info: loads at the same time share one request', async (context) => {
  const answer = deferred()
  const calls = host(context, () => answer.promise)
  const { loadInfo } = await fresh('info')
  const both = Promise.all([loadInfo('claude', '/work/one'), loadInfo('claude', '/work/one')])
  answer.resolve(reply(info('alpha')))
  const [left, right] = await both
  assert.equal(left, right)
  assert.equal(calls.length, 1)
})

test('info: another folder or provider is a separate answer', async (context) => {
  const calls = host(context, (_call, number) => reply(info(`model-${String(number)}`)))
  const { loadInfo } = await fresh('info')
  const one = await loadInfo('claude', '/work/one')
  const two = await loadInfo('claude', '/work/two')
  const three = await loadInfo('codex', '/work/one')
  assert.equal(calls.length, 3)
  assert.equal(new Set([one, two, three].map(item => item.models[0].value)).size, 3)
})

test('info: a fresh load goes to the host and replaces the saved answer', async (context) => {
  const calls = host(context, (_call, number) => reply(info(`model-${String(number)}`)))
  const { loadInfo } = await fresh('info')
  await loadInfo('claude', '/work/one')
  const newer = await loadInfo('claude', '/work/one', true)
  assert.match(calls[1].url, /fresh=1/)
  assert.equal(newer.models[0].value, 'model-2')
  assert.equal(await loadInfo('claude', '/work/one'), newer)
  assert.equal(calls.length, 2)
})

test('info: the error text of the host is thrown', async (context) => {
  host(context, () => reply({ error: 'The engine is missing.' }, 500))
  const { loadInfo } = await fresh('info')
  await assert.rejects(loadInfo('claude', '/work/one'), /The engine is missing\./)
})

test('info: a refusal with no text gives the HTTP status', async (context) => {
  host(context, () => reply({}, 502))
  const { loadInfo } = await fresh('info')
  await assert.rejects(loadInfo('claude', '/work/one'), /HTTP 502/)
})

test('info: a failed load is not saved, so the next load asks again', async (context) => {
  const calls = host(context, (_call, number) => number === 1 ? reply({ error: 'Busy.' }, 500) : reply(info('alpha')))
  const { loadInfo } = await fresh('info')
  await assert.rejects(loadInfo('claude', '/work/one'))
  assert.deepEqual(await loadInfo('claude', '/work/one'), info('alpha'))
  assert.equal(calls.length, 2)
})

// useInfo

test('useInfo: no folder loads nothing', async (context) => {
  const calls = host(context, () => reply(info('alpha')))
  const { useInfo } = await fresh('info')
  const hook = ({ cwd }) => useInfo('claude', cwd)
  const { seen, change, unmount } = await mount(hook, { cwd: undefined })
  await change({ cwd: '' })
  assert.equal(calls.length, 0)
  assert.equal(seen.value.info, undefined)
  assert.equal(seen.value.error, undefined)
  await unmount()
})

test('useInfo: the answer of the host is returned', async (context) => {
  host(context, () => reply(info('alpha')))
  const { useInfo } = await fresh('info')
  const { seen, unmount } = await mount(({ cwd }) => useInfo('claude', cwd), { cwd: '/work/one' })
  assert.deepEqual(seen.value.info, info('alpha'))
  assert.equal(seen.value.error, undefined)
  await unmount()
})

test('useInfo: a failed load gives its error text', async (context) => {
  host(context, () => reply({ error: 'The engine is missing.' }, 500))
  const { useInfo } = await fresh('info')
  const { seen, unmount } = await mount(({ cwd }) => useInfo('claude', cwd), { cwd: '/work/one' })
  assert.equal(seen.value.info, undefined)
  assert.equal(seen.value.error, 'The engine is missing.')
  await unmount()
})

test('useInfo: a lost connection gives the error text', async (context) => {
  host(context, () => { throw new Error('offline') })
  const { useInfo } = await fresh('info')
  const { seen, unmount } = await mount(({ cwd }) => useInfo('claude', cwd), { cwd: '/work/one' })
  assert.equal(seen.value.error, 'offline')
  await unmount()
})

test('useInfo: reload asks the host again and shows the new answer', async (context) => {
  const calls = host(context, (_call, number) => reply(info(`model-${String(number)}`)))
  const { useInfo } = await fresh('info')
  const { seen, unmount } = await mount(({ cwd }) => useInfo('claude', cwd), { cwd: '/work/one' })
  assert.equal(seen.value.info.models[0].value, 'model-1')
  await act(() => { seen.value.reload() })
  assert.match(calls[1].url, /fresh=1/)
  assert.equal(seen.value.info.models[0].value, 'model-2')
  await unmount()
})

test('useInfo: a reload that works removes the earlier error', async (context) => {
  host(context, (_call, number) => number === 1 ? reply({ error: 'Busy.' }, 500) : reply(info('alpha')))
  const { useInfo } = await fresh('info')
  const { seen, unmount } = await mount(({ cwd }) => useInfo('claude', cwd), { cwd: '/work/one' })
  assert.equal(seen.value.error, 'Busy.')
  await act(() => { seen.value.reload() })
  assert.equal(seen.value.error, undefined)
  assert.deepEqual(seen.value.info, info('alpha'))
  await unmount()
})

test('useInfo: a reload that fails keeps the models on screen and shows the error', async (context) => {
  host(context, (_call, number) => number === 1 ? reply(info('alpha')) : reply({ error: 'Busy.' }, 500))
  const { useInfo } = await fresh('info')
  const { seen, unmount } = await mount(({ cwd }) => useInfo('claude', cwd), { cwd: '/work/one' })
  await act(() => { seen.value.reload() })
  assert.deepEqual(seen.value.info, info('alpha'))
  assert.equal(seen.value.error, 'Busy.')
  await unmount()
})

test('useInfo: another folder of the same engine shows the last models until its own arrive', async (context) => {
  const second = deferred()
  host(context, (_call, number) => number === 1 ? reply(info('alpha')) : second.promise)
  const { useInfo } = await fresh('info')
  const { seen, change, unmount } = await mount(({ cwd }) => useInfo('claude', cwd), { cwd: '/work/one' })
  await change({ cwd: '/work/two' })
  assert.deepEqual(seen.value.info, info('alpha'))
  await act(async () => { second.resolve(reply(info('beta'))); await second.promise })
  await settle()
  assert.deepEqual(seen.value.info, info('beta'))
  await unmount()
})

test('useInfo: another engine never shows the models of the first one', async (context) => {
  const second = deferred()
  host(context, (_call, number) => number === 1 ? reply(info('alpha')) : second.promise)
  const { useInfo } = await fresh('info')
  const { seen, change, unmount } = await mount(({ engine }) => useInfo(engine, '/work/one'), { engine: 'claude' })
  await change({ engine: 'codex' })
  assert.equal(seen.value.info, undefined)
  await act(async () => { second.resolve(reply(info('beta'))); await second.promise })
  await settle()
  assert.deepEqual(seen.value.info, info('beta'))
  await unmount()
})

test('useInfo: an answer for the folder that was left is ignored', async (context) => {
  const first = deferred()
  host(context, (_call, number) => number === 1 ? first.promise : reply(info('beta')))
  const { useInfo } = await fresh('info')
  const { seen, change, unmount } = await mount(({ cwd }) => useInfo('claude', cwd), { cwd: '/work/one' })
  await change({ cwd: '/work/two' })
  await act(async () => { first.resolve(reply(info('alpha'))); await first.promise })
  await settle()
  assert.deepEqual(seen.value.info, info('beta'))
  await unmount()
})

test('useInfo: a failure of the folder that was left shows no error', async (context) => {
  const first = deferred()
  host(context, (_call, number) => number === 1 ? first.promise : reply(info('beta')))
  const { useInfo } = await fresh('info')
  const { seen, change, unmount } = await mount(({ cwd }) => useInfo('claude', cwd), { cwd: '/work/one' })
  await change({ cwd: '/work/two' })
  await act(async () => { first.resolve(reply({ error: 'Late failure.' }, 500)); await first.promise })
  await settle()
  assert.equal(seen.value.error, undefined)
  await unmount()
})

// useInfos

test('useInfos: each provider gets its own models or its own error', async (context) => {
  host(context, call => call.url.includes('codex') ? reply({ error: 'No Codex.' }, 500) : reply(info('alpha')))
  const { useInfos } = await fresh('info')
  const { seen, unmount } = await mount(({ list, cwd }) => useInfos(list, cwd), { list: ['claude', 'codex'], cwd: '/work/one' })
  assert.deepEqual(seen.value.claude, { info: info('alpha'), error: undefined })
  assert.equal(seen.value.codex.info, undefined)
  assert.equal(seen.value.codex.error, 'No Codex.')
  await unmount()
})

test('useInfos: an empty folder loads nothing and still lists each provider', async (context) => {
  const calls = host(context, () => reply(info('alpha')))
  const { useInfos } = await fresh('info')
  const { seen, unmount } = await mount(({ list, cwd }) => useInfos(list, cwd), { list: ['claude', 'codex'], cwd: '' })
  assert.equal(calls.length, 0)
  assert.deepEqual(seen.value, { claude: { info: undefined, error: undefined }, codex: { info: undefined, error: undefined } })
  await unmount()
})

test('useInfos: a provider that joins the list is loaded, and the others are not read again', async (context) => {
  const calls = host(context, call => reply(info(call.url.includes('codex') ? 'beta' : 'alpha')))
  const { useInfos } = await fresh('info')
  const { seen, change, unmount } = await mount(({ list, cwd }) => useInfos(list, cwd), { list: ['claude'], cwd: '/work/one' })
  await change({ list: ['claude', 'codex'], cwd: '/work/one' })
  assert.equal(calls.length, 2)
  assert.deepEqual(seen.value.codex.info, info('beta'))
  assert.deepEqual(seen.value.claude.info, info('alpha'))
  await unmount()
})

test('useInfos: a provider that leaves the list is not returned', async (context) => {
  host(context, () => reply(info('alpha')))
  const { useInfos } = await fresh('info')
  const { seen, change, unmount } = await mount(({ list, cwd }) => useInfos(list, cwd), { list: ['claude', 'codex'], cwd: '/work/one' })
  await change({ list: ['codex'], cwd: '/work/one' })
  assert.deepEqual(Object.keys(seen.value), ['codex'])
  await unmount()
})

test('useInfos: another folder shows the last models of that provider until its own arrive', async (context) => {
  const second = deferred()
  host(context, (_call, number) => number === 1 ? reply(info('alpha')) : second.promise)
  const { useInfos } = await fresh('info')
  const { seen, change, unmount } = await mount(({ list, cwd }) => useInfos(list, cwd), { list: ['claude'], cwd: '/work/one' })
  await change({ list: ['claude'], cwd: '/work/two' })
  assert.deepEqual(seen.value.claude.info, info('alpha'))
  await act(async () => { second.resolve(reply(info('beta'))); await second.promise })
  await settle()
  assert.deepEqual(seen.value.claude.info, info('beta'))
  await unmount()
})

// providers-store

const INSTANCE = { id: 'work', engine: 'claude', label: 'Work account', accent: '#123456', home: '/fake/home' }
const instancesReply = instances => reply({ instances })

test('providers: Codex and Claude Code are listed before the host answers', async () => {
  const { currentProviders } = await fresh('providers-store')
  assert.deepEqual(currentProviders().map(item => [item.id, item.engine, item.label]), [['codex', 'codex', 'Codex'], ['claude', 'claude', 'Claude Code']])
})

test('providers: added instances follow the two defaults', async (context) => {
  const calls = host(context, () => instancesReply([INSTANCE]))
  const { useProviders, currentProviders } = await fresh('providers-store')
  const { seen, unmount } = await mount(useProviders, {})
  assert.equal(calls[0].url, INSTANCES)
  assert.deepEqual(seen.value.providers.map(item => item.id), ['codex', 'claude', 'claude@work'])
  const added = seen.value.providers[2]
  assert.equal(added.label, 'Work account')
  assert.equal(added.accent, '#123456')
  assert.deepEqual(added.instance, INSTANCE)
  assert.equal(currentProviders(), seen.value.providers)
  await unmount()
})

test('providers: the list is requested one time per page', async (context) => {
  const calls = host(context, () => instancesReply([]))
  const { useProviders } = await fresh('providers-store')
  const first = await mount(useProviders, {})
  const second = await mount(useProviders, {})
  assert.equal(calls.length, 1)
  await first.unmount()
  await second.unmount()
})

test('providers: a failed load keeps the defaults and the next component tries again', async (context) => {
  const warn = context.mock.method(console, 'warn', () => {})
  const calls = host(context, (_call, number) => { if (number === 1) throw new Error('offline'); return instancesReply([INSTANCE]) })
  const { useProviders } = await fresh('providers-store')
  const first = await mount(useProviders, {})
  assert.deepEqual(first.seen.value.providers.map(item => item.id), ['codex', 'claude'])
  assert.equal(warn.mock.callCount(), 1)
  await first.unmount()
  const second = await mount(useProviders, {})
  assert.equal(calls.length, 2)
  assert.deepEqual(second.seen.value.providers.map(item => item.id), ['codex', 'claude', 'claude@work'])
  await second.unmount()
})

test('providers: adding an instance sends it and updates every list', async (context) => {
  const calls = host(context, call => call.method === 'POST' ? instancesReply([INSTANCE]) : instancesReply([]))
  const { useProviders, currentProviders } = await fresh('providers-store')
  const first = await mount(useProviders, {})
  const second = await mount(useProviders, {})
  let result = 'unset'
  await act(async () => { result = await first.seen.value.add({ label: 'Work account' }) })
  assert.equal(result, undefined)
  const post = calls.find(call => call.method === 'POST')
  assert.deepEqual(post.body, { action: 'add', instance: { label: 'Work account' } })
  assert.equal(post.headers['content-type'], 'application/json')
  assert.deepEqual(second.seen.value.providers.map(item => item.id), ['codex', 'claude', 'claude@work'])
  assert.equal(currentProviders().length, 3)
  await first.unmount()
  await second.unmount()
})

test('providers: removing an instance sends its id and removes the row', async (context) => {
  const calls = host(context, call => call.method === 'POST' ? instancesReply([]) : instancesReply([INSTANCE]))
  const { useProviders } = await fresh('providers-store')
  const { seen, unmount } = await mount(useProviders, {})
  assert.equal(seen.value.providers.length, 3)
  await act(async () => { await seen.value.remove('work') })
  assert.deepEqual(calls.find(call => call.method === 'POST').body, { action: 'remove', id: 'work' })
  assert.deepEqual(seen.value.providers.map(item => item.id), ['codex', 'claude'])
  await unmount()
})

for (const [name, answer, expected] of [
  ['the text of the host', () => reply({ error: 'That id is taken.' }, 400), 'That id is taken.'],
  ['the HTTP status when the host gives no text', () => reply({}, 500), 'HTTP 500'],
  ['the HTTP status when an answer has no list', () => reply({}, 200), 'HTTP 200'],
]) {
  test(`providers: a refused change returns ${name} and keeps the list`, async (context) => {
    host(context, call => call.method === 'POST' ? answer() : instancesReply([INSTANCE]))
    const { useProviders } = await fresh('providers-store')
    const { seen, unmount } = await mount(useProviders, {})
    let result
    await act(async () => { result = await seen.value.add({}) })
    assert.equal(result, expected)
    assert.deepEqual(seen.value.providers.map(item => item.id), ['codex', 'claude', 'claude@work'])
    await unmount()
  })
}

test('providers: a lost connection reaches the caller, and the list stays', async (context) => {
  host(context, (call) => { if (call.method === 'POST') throw new Error('offline'); return instancesReply([]) })
  const { useProviders } = await fresh('providers-store')
  const { seen, unmount } = await mount(useProviders, {})
  await assert.rejects(seen.value.add({}), /offline/)
  assert.deepEqual(seen.value.providers.map(item => item.id), ['codex', 'claude'])
  await unmount()
})

test('providers: add and remove keep their identity between renders', async (context) => {
  host(context, () => instancesReply([]))
  const { useProviders } = await fresh('providers-store')
  const { seen, change, unmount } = await mount(useProviders, { round: 1 })
  const { add, remove } = seen.value
  await change({ round: 2 })
  assert.equal(seen.value.add, add)
  assert.equal(seen.value.remove, remove)
  await unmount()
})

// model-prefs-store

const NONE = { engines: {}, favorites: [] }
const SAVED = { engines: { claude: { hidden: ['old'], order: [], custom: [] } }, favorites: ['claude/fast'] }

test('model preferences: they start empty, before the host answers', async () => {
  const { currentModelPrefs } = await fresh('model-prefs-store')
  assert.deepEqual(currentModelPrefs(), NONE)
})

test('model preferences: the saved preferences load when a component opens', async (context) => {
  const calls = host(context, () => reply(SAVED))
  const { useModelPrefs, currentModelPrefs } = await fresh('model-prefs-store')
  const { seen, unmount } = await mount(useModelPrefs, {})
  assert.equal(calls[0].url, PREFS)
  assert.deepEqual(seen.value[0], SAVED)
  assert.deepEqual(currentModelPrefs(), SAVED)
  await unmount()
})

test('model preferences: they are requested one time per page', async (context) => {
  const calls = host(context, () => reply(SAVED))
  const { useModelPrefs } = await fresh('model-prefs-store')
  const first = await mount(useModelPrefs, {})
  const second = await mount(useModelPrefs, {})
  assert.equal(calls.length, 1)
  await first.unmount()
  await second.unmount()
})

test('model preferences: a failed load keeps the empty state and the next component tries again', async (context) => {
  const warn = context.mock.method(console, 'warn', () => {})
  const calls = host(context, (_call, number) => { if (number === 1) throw new Error('offline'); return reply(SAVED) })
  const { useModelPrefs } = await fresh('model-prefs-store')
  const first = await mount(useModelPrefs, {})
  assert.deepEqual(first.seen.value[0], NONE)
  assert.equal(warn.mock.callCount(), 1)
  await first.unmount()
  const second = await mount(useModelPrefs, {})
  assert.equal(calls.length, 2)
  assert.deepEqual(second.seen.value[0], SAVED)
  await second.unmount()
})

test('model preferences: a save shows at once in every component, before the host answers', async (context) => {
  const answer = deferred()
  const calls = host(context, call => call.method === 'POST' ? answer.promise : reply(NONE))
  const { useModelPrefs, currentModelPrefs } = await fresh('model-prefs-store')
  const first = await mount(useModelPrefs, {})
  const second = await mount(useModelPrefs, {})
  await act(() => { first.seen.value[1](SAVED) })
  assert.deepEqual(second.seen.value[0], SAVED)
  assert.deepEqual(currentModelPrefs(), SAVED)
  const post = calls.find(call => call.method === 'POST')
  assert.equal(post.url, PREFS)
  assert.deepEqual(post.body, SAVED)
  assert.equal(post.headers['content-type'], 'application/json')
  await act(async () => { answer.resolve(reply({ ok: true })); await answer.promise })
  await first.unmount()
  await second.unmount()
})

test('model preferences: a save that the host refuses warns and keeps the choice on screen', async (context) => {
  const warn = context.mock.method(console, 'warn', () => {})
  host(context, call => call.method === 'POST' ? reply({ error: 'invalid' }, 400) : reply(NONE))
  const { useModelPrefs } = await fresh('model-prefs-store')
  const { seen, unmount } = await mount(useModelPrefs, {})
  await act(() => { seen.value[1](SAVED) })
  await settle()
  assert.deepEqual(seen.value[0], SAVED)
  assert.equal(warn.mock.callCount(), 1)
  await unmount()
})

test('model preferences: a save with a lost connection warns and keeps the choice on screen', async (context) => {
  const warn = context.mock.method(console, 'warn', () => {})
  host(context, (call) => { if (call.method === 'POST') throw new Error('offline'); return reply(NONE) })
  const { useModelPrefs } = await fresh('model-prefs-store')
  const { seen, unmount } = await mount(useModelPrefs, {})
  await act(() => { seen.value[1](SAVED) })
  await settle()
  assert.deepEqual(seen.value[0], SAVED)
  assert.equal(warn.mock.callCount(), 1)
  await unmount()
})

test('model preferences: the save function keeps its identity between renders', async (context) => {
  host(context, () => reply(NONE))
  const { useModelPrefs } = await fresh('model-prefs-store')
  const { seen, change, unmount } = await mount(useModelPrefs, { round: 1 })
  const save = seen.value[1]
  await change({ round: 2 })
  assert.equal(seen.value[1], save)
  await unmount()
})

// dsh-catalog-store

const ROWS = [{ id: 'one/flash', name: 'Flash', description: 'One', efforts: [] }, { id: 'two/pro', name: 'Pro', description: 'Two', efforts: [] }]

test('harness catalog: the list is empty before the model seat reports it', async () => {
  const { useDshCatalog } = await fresh('dsh-catalog-store')
  const { seen, unmount } = await mount(useDshCatalog, {})
  assert.deepEqual(seen.value, [])
  await unmount()
})

test('harness catalog: every component gets the rows in their catalog order', async () => {
  const { useDshCatalog, publishDshCatalog } = await fresh('dsh-catalog-store')
  const first = await mount(useDshCatalog, {})
  const second = await mount(useDshCatalog, {})
  await act(() => { publishDshCatalog(ROWS) })
  assert.deepEqual(first.seen.value.map(row => row.id), ['one/flash', 'two/pro'])
  assert.deepEqual(second.seen.value.map(row => row.id), ['one/flash', 'two/pro'])
  await first.unmount()
  await second.unmount()
})

test('harness catalog: the same list again does not render again', async () => {
  const { useDshCatalog, publishDshCatalog } = await fresh('dsh-catalog-store')
  const { seen, unmount } = await mount(useDshCatalog, {})
  await act(() => { publishDshCatalog(ROWS) })
  const renders = seen.renders
  await act(() => { publishDshCatalog(ROWS) })
  assert.equal(seen.renders, renders)
  await unmount()
})

test('harness catalog: a new list replaces the old one', async () => {
  const { useDshCatalog, publishDshCatalog } = await fresh('dsh-catalog-store')
  const { seen, unmount } = await mount(useDshCatalog, {})
  await act(() => { publishDshCatalog(ROWS) })
  await act(() => { publishDshCatalog([ROWS[1]]) })
  assert.deepEqual(seen.value.map(row => row.id), ['two/pro'])
  await unmount()
})

test('harness catalog: a component that went away is not called', async () => {
  const { useDshCatalog, publishDshCatalog } = await fresh('dsh-catalog-store')
  const { seen, unmount } = await mount(useDshCatalog, {})
  await unmount()
  const renders = seen.renders
  await act(() => { publishDshCatalog(ROWS) })
  assert.equal(seen.renders, renders)
})
