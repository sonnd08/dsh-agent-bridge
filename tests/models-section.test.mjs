import test from 'node:test'
import assert from 'node:assert/strict'

const { render, click, act, byTestId, allByTestId, t, React } = await import('./support/dom.mjs')
const { INFO_PATH, INSTANCES_PATH, LOGIN_PATH, MODEL_PREFS_PATH } = await import('../src/protocol.ts')
const { ProvidersPanel } = await import('../src/client/ModelsSection.tsx')
const { useModelPrefs } = await import('../src/client/model-prefs-store.ts')
const { useProviders } = await import('../src/client/providers-store.ts')
const { publishDshCatalog } = await import('../src/client/dsh-catalog-store.ts')

test.afterEach(() => { document.body.replaceChildren() })

const NO_PREFS = { engines: {}, favorites: [] }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** What the fake host answers. The stores keep state for the whole file, so sign-in tests use their own instance id. */
const server = { info: {}, login: {}, instances: [], saved: [], instancePosts: [], loginPosts: [], infoRequests: 0, instancePost: undefined }
const providerOf = params => params.get('instance') === null ? params.get('engine') : `${params.get('engine')}@${params.get('instance')}`
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const [path, query = ''] = String(url).split('?')
  const params = new URLSearchParams(query)
  const body = init.body === undefined ? undefined : JSON.parse(init.body)
  if (path === INFO_PATH) {
    server.infoRequests += 1
    const answer = server.info[providerOf(params)] ?? info([])
    return answer.failure === undefined ? json(answer) : json({ error: answer.failure }, 500)
  }
  if (path === LOGIN_PATH && init.method === 'POST') { server.loginPosts.push(body); return json({ signedIn: false }) }
  if (path === LOGIN_PATH) return json(server.login[providerOf(params)] ?? {})
  if (path === MODEL_PREFS_PATH && init.method === 'POST') { server.saved.push(body); return json({}) }
  if (path === MODEL_PREFS_PATH) return json(NO_PREFS)
  if (path === INSTANCES_PATH && init.method === 'POST') {
    server.instancePosts.push(body)
    return server.instancePost === undefined ? json({ instances: server.instances }) : server.instancePost(body)
  }
  if (path === INSTANCES_PATH) return json({ instances: [] })
  throw new Error(`unexpected request: ${String(url)}`)
}

const settle = () => act(() => new Promise((resolve) => { setTimeout(resolve, 0) }))
function model(value, name = value) { return { value, name, description: '', efforts: [] } }
function info(models, account) { return { models, commands: [], mcp: [], ...account === undefined ? {} : { account } } }
const row = (id, status, extra = {}) => ({ id, status, verified: [], ...extra })
const instance = (id, engine = 'claude', extra = {}) => ({ id, engine, label: `Label ${id}`, home: `/invented/${id}`, ...extra })

let probe
function Probe() {
  const [, save] = useModelPrefs()
  const { add } = useProviders()
  probe = { save, add }
  return null
}
const probeView = await render(React.createElement(Probe))
await settle()

async function setPrefs(prefs) {
  await act(() => { probe.save(prefs) })
  await settle()
  server.saved.length = 0
}

async function setInstances(list) {
  server.instances = list
  await act(() => probe.add({}))
  await settle()
  server.instancePosts.length = 0
}

const setCatalog = rows => act(() => { publishDshCatalog(rows) })

test.beforeEach(async () => {
  Object.assign(server, { info: {}, login: {}, instancePost: undefined, infoRequests: 0 })
  await setPrefs(NO_PREFS)
  await setInstances([])
  await setCatalog([])
  server.loginPosts.length = 0
})

test.after(async () => {
  await probeView.unmount()
  globalThis.fetch = realFetch
})

let cases = 0
/** Render the panel for a folder no other test used, so the info cache gives this test's answers. */
async function mount({ rows = [], codexEnabled = true, cwd = `/invented/case-${cases += 1}` } = {}) {
  const view = await render(React.createElement(ProvidersPanel, { t, rows, getDefaultCwd: () => cwd, codexEnabled: () => codexEnabled }))
  await settle()
  return view
}

const setValue = (input, value) => act(() => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
})
const openTab = id => click(byTestId(`ext-models-engine-${id}`))
const statusOf = id => byTestId(`ext-models-engine-${id}`).querySelector('.engineStatus').textContent
const lastSaved = () => server.saved.at(-1)
const modelIds = () => allByTestId('ext-model-row').map(item => item.dataset.model)
const modelRow = id => allByTestId('ext-model-row').find(item => item.dataset.model === id)
const inRow = (element, testId) => element.querySelector(`[data-testid="${testId}"]`)
const favoriteKeys = () => allByTestId('ext-favorite-row').map(item => item.dataset.model)
const favoriteRow = key => allByTestId('ext-favorite-row').find(item => item.dataset.model === key)
const groups = () => [...document.querySelectorAll('.group')].map(item => item.textContent)
const alerts = () => [...document.querySelectorAll('[role="alert"]')].map(item => item.textContent)
const text = () => document.body.textContent

// The provider list

test('provider list: the rows are Favorites, DeepSeek Harness, the two engines and then the added instances', async () => {
  await setInstances([instance('list-a'), instance('list-b', 'codex')])
  const view = await mount()
  const ids = [...document.querySelectorAll('[data-testid^="ext-models-provider-"]')].map(item => item.dataset.testid.replace('ext-models-provider-', ''))
  assert.deepEqual(ids, ['favorites', 'dsh', 'codex', 'claude', 'claude@list-a', 'codex@list-b'])
  assert.match(byTestId('ext-models-engine-claude@list-a').textContent, /Label list-a/)
  await view.unmount()
})

test('provider list: it opens on the Favorites tab', async () => {
  const view = await mount()
  assert.equal(byTestId('ext-models-provider-favorites').className, 'engineActive')
  assert.equal(byTestId('ext-models-filter'), null)
  await view.unmount()
})

test('provider list: versions come from the about rows, and a row without a version shows none', async () => {
  const view = await mount({ rows: [row('dsh', 'verified', { version: '1.2.3' }), row('claude', 'verified', { version: '4.5.6' }), row('codex', 'unknown')] })
  assert.match(byTestId('ext-models-engine-dsh').textContent, /v1\.2\.3/)
  assert.match(byTestId('ext-models-engine-claude').textContent, /v4\.5\.6/)
  assert.equal(byTestId('ext-models-engine-codex').querySelector('code'), null)
  await view.unmount()
})

test('provider list: an instance with an accent has a colored dot and one without has none', async () => {
  await setInstances([instance('accent-a', 'claude', { accent: '#2fa866' }), instance('accent-b')])
  const view = await mount()
  assert.equal(byTestId('ext-models-engine-claude@accent-a').querySelector('.accentDot').style.background, 'rgb(47, 168, 102)')
  assert.equal(byTestId('ext-models-engine-claude@accent-b').querySelector('.accentDot'), null)
  await view.unmount()
})

test('provider list: the DeepSeek Harness row counts its models and has no enable switch', async () => {
  await setCatalog([{ id: 'route/one', name: 'One', description: '', efforts: [] }, { id: 'route/two', name: 'Two', description: '', efforts: [] }])
  const view = await mount()
  assert.equal(statusOf('dsh'), 'providers.favoriteCount {"n":2}')
  assert.equal(byTestId('ext-models-enable-dsh'), null)
  await view.unmount()
})

test('provider list: without about rows the plugin flag decides whether Codex shows', async () => {
  const off = await mount({ codexEnabled: false })
  assert.equal(byTestId('ext-models-provider-codex'), null)
  assert.notEqual(byTestId('ext-models-provider-claude'), null)
  await off.unmount()
  const on = await mount({ codexEnabled: true })
  assert.notEqual(byTestId('ext-models-provider-codex'), null)
  await on.unmount()
})

test('provider list: an about row that says Codex is off wins over the plugin flag', async () => {
  const view = await mount({ codexEnabled: true, rows: [row('codex', 'off')] })
  assert.equal(byTestId('ext-models-provider-codex'), null)
  await view.unmount()
})

test('provider list: an about row that says Codex runs wins over the plugin flag', async () => {
  const view = await mount({ codexEnabled: false, rows: [row('codex', 'verified')] })
  assert.notEqual(byTestId('ext-models-provider-codex'), null)
  await view.unmount()
})

test('provider list: about rows that do not name Codex hide it', async () => {
  const view = await mount({ rows: [row('claude', 'verified')] })
  assert.equal(byTestId('ext-models-provider-codex'), null)
  await view.unmount()
})

test('provider list: added Codex instances go away with Codex, and added Claude instances stay', async () => {
  await setInstances([instance('off-a', 'codex'), instance('off-b', 'claude')])
  const view = await mount({ codexEnabled: false })
  assert.equal(byTestId('ext-models-provider-codex@off-a'), null)
  assert.notEqual(byTestId('ext-models-provider-claude@off-b'), null)
  await view.unmount()
})

test('provider list: an empty working folder asks the engines for nothing', async () => {
  const view = await mount({ cwd: '' })
  assert.equal(server.infoRequests, 0)
  assert.equal(statusOf('claude'), 'providers.available')
  await view.unmount()
})

// The status line

const NOT_SIGNED_IN = 'providers.notSignedIn'
const NOT_READY = 'providers.notReady'
const AVAILABLE = 'providers.available'
const PLAN_PRO = 'providers.authenticated {"plan":"Pro"}'
const STATUS_CASES = [
  ['a Claude provider with no answers yet is available', 'claude', {}, undefined, AVAILABLE],
  ['the sign-in check saying no shows not signed in', 'claude', { signedIn: false }, info([]), NOT_SIGNED_IN],
  ['the sign-in check saying no applies to Codex too', 'codex', { signedIn: false }, info([]), NOT_SIGNED_IN],
  ['a sign-in check that says no wins over a load error', 'claude', { signedIn: false }, { failure: 'boom' }, NOT_SIGNED_IN],
  ['a load error shows not ready', 'claude', {}, { failure: 'boom' }, NOT_READY],
  ['a load error shows not ready for Codex', 'codex', {}, { failure: 'boom' }, NOT_READY],
  ['Claude with no sign-in answer can report no account', 'claude', {}, info([], { loggedIn: false }), NOT_SIGNED_IN],
  ['Codex with no sign-in answer and no account stays available, because Codex reports no account even when signed in', 'codex', {}, info([], { loggedIn: false }), AVAILABLE],
  ['the sign-in check saying yes wins over a Claude report of no account', 'claude', { signedIn: true }, info([], { loggedIn: false }), AVAILABLE],
  ['a plan from the sign-in check is shown with a capital letter', 'claude', { signedIn: true, plan: 'pro' }, info([]), PLAN_PRO],
  ['a plan from the account is used when the sign-in check has none', 'claude', { signedIn: true }, info([], { loggedIn: true, plan: 'pro' }), PLAN_PRO],
  ['the plan of the sign-in check wins over the plan of the account', 'claude', { signedIn: true, plan: 'pro' }, info([], { loggedIn: true, plan: 'free' }), PLAN_PRO],
  ['a Codex plan is shown', 'codex', { plan: 'pro' }, info([]), PLAN_PRO],
  ['a plan does not hide that the sign-in check says no', 'claude', { signedIn: false, plan: 'pro' }, info([]), NOT_SIGNED_IN],
]

for (const [index, [name, engine, login, answer, expected]] of STATUS_CASES.entries()) {
  test(`status line: ${name}`, async () => {
    const id = `status-${index}`
    const provider = `${engine}@${id}`
    server.login[provider] = login
    if (answer !== undefined) server.info[provider] = answer
    await setInstances([instance(id, engine)])
    const view = await mount()
    assert.equal(statusOf(provider), expected)
    await view.unmount()
  })
}

test('status line: an about row that says missing shows missing', async () => {
  const view = await mount({ rows: [row('codex', 'missing'), row('claude', 'verified')] })
  assert.equal(statusOf('codex'), 'about.status.missing')
  assert.equal(statusOf('claude'), AVAILABLE)
  await view.unmount()
})

// The Favorites tab

const CLAUDE_MODELS = [model('default', 'Default'), model('opus', 'Opus'), model('sonnet', 'Sonnet'), model('haiku', 'Haiku')]
const useClaude = () => { server.info.claude = info(CLAUDE_MODELS) }
const useCodex = () => { server.info.codex = info([model('alpha', 'Alpha')]) }

test('favorites tab: with none it says so and counts zero', async () => {
  const view = await mount()
  assert.equal(statusOf('favorites'), 'providers.favoriteCount {"n":0}')
  assert.match(text(), /picker\.noFavorites/)
  assert.deepEqual(favoriteKeys(), [])
  await view.unmount()
})

test('favorites tab: rows keep the saved order and take their names from each provider', async () => {
  useClaude()
  useCodex()
  await setCatalog([{ id: 'route/deep', name: 'Deep model', description: '', efforts: [] }])
  await setPrefs({ engines: {}, favorites: ['codex/alpha', 'dsh/route/deep', 'claude/opus'] })
  const view = await mount()
  assert.deepEqual(favoriteKeys(), ['codex/alpha', 'dsh/route/deep', 'claude/opus'])
  assert.equal(statusOf('favorites'), 'providers.favoriteCount {"n":3}')
  assert.equal(favoriteRow('claude/opus').querySelector('.name').textContent, 'Opus')
  assert.equal(favoriteRow('claude/opus').querySelector('.slug').textContent, 'opus')
  assert.equal(favoriteRow('dsh/route/deep').querySelector('.name').textContent, 'Deep model')
  assert.equal(favoriteRow('dsh/route/deep').querySelector('.slug').textContent, 'route/deep')
  assert.equal(favoriteRow('codex/alpha').querySelector('.engineMark').dataset.engine, 'codex')
  await view.unmount()
})

test('favorites tab: an added instance shows the mark of its engine', async () => {
  server.info['claude@mark-a'] = info([model('opus', 'Opus')])
  await setInstances([instance('mark-a')])
  await setPrefs({ engines: {}, favorites: ['claude@mark-a/opus'] })
  const view = await mount()
  assert.equal(favoriteRow('claude@mark-a/opus').querySelector('.engineMark').dataset.engine, 'claude')
  assert.equal(favoriteRow('claude@mark-a/opus').querySelector('.name').textContent, 'Opus')
  await view.unmount()
})

test('favorites tab: a model the provider no longer lists stays, by its id, and has no switch', async () => {
  await setPrefs({ engines: {}, favorites: ['claude/retired-model', 'dsh/route/retired-too', 'gone@x/model'] })
  const view = await mount()
  assert.equal(favoriteRow('claude/retired-model').querySelector('.name').textContent, 'retired-model')
  assert.equal(favoriteRow('dsh/route/retired-too').querySelector('.name').textContent, 'retired-too')
  assert.equal(favoriteRow('dsh/route/retired-too').querySelector('.slug').textContent, 'route/retired-too')
  for (const key of favoriteKeys()) assert.equal(inRow(favoriteRow(key), 'ext-favorite-toggle'), null, key)
  await view.unmount()
})

test('favorites tab: a custom model has no switch', async () => {
  await setPrefs({ engines: { claude: { hidden: [], order: [], custom: ['my-model'] } }, favorites: ['claude/my-model'] })
  const view = await mount()
  assert.equal(inRow(favoriteRow('claude/my-model'), 'ext-favorite-toggle'), null)
  await view.unmount()
})

test('favorites tab: a removed star keeps the row until the tab opens again, so the change can be undone', async () => {
  useClaude()
  await setPrefs({ engines: {}, favorites: ['claude/opus', 'claude/sonnet'] })
  const view = await mount()
  await click(inRow(favoriteRow('claude/opus'), 'ext-favorite-star'))
  assert.deepEqual(lastSaved().favorites, ['claude/sonnet'])
  assert.deepEqual(favoriteKeys(), ['claude/opus', 'claude/sonnet'], 'the row stays')
  assert.equal(inRow(favoriteRow('claude/opus'), 'ext-favorite-star').getAttribute('aria-pressed'), 'false')
  assert.equal(statusOf('favorites'), 'providers.favoriteCount {"n":1}')
  await click(inRow(favoriteRow('claude/opus'), 'ext-favorite-star'))
  assert.deepEqual(lastSaved().favorites, ['claude/opus', 'claude/sonnet'], 'the undo restores the place')
  await click(inRow(favoriteRow('claude/opus'), 'ext-favorite-star'))
  await openTab('favorites')
  assert.deepEqual(favoriteKeys(), ['claude/sonnet'], 'opening the tab again refreshes the rows')
  await view.unmount()
})

test('favorites tab: rows move up and down, and the ends cannot move further', async () => {
  useClaude()
  await setPrefs({ engines: {}, favorites: ['claude/opus', 'claude/sonnet', 'claude/haiku'] })
  const view = await mount()
  assert.equal(inRow(favoriteRow('claude/opus'), 'ext-favorite-up').disabled, true)
  assert.equal(inRow(favoriteRow('claude/opus'), 'ext-favorite-down').disabled, false)
  assert.equal(inRow(favoriteRow('claude/haiku'), 'ext-favorite-down').disabled, true)
  await click(inRow(favoriteRow('claude/opus'), 'ext-favorite-down'))
  assert.deepEqual(favoriteKeys(), ['claude/sonnet', 'claude/opus', 'claude/haiku'])
  assert.deepEqual(lastSaved().favorites, ['claude/sonnet', 'claude/opus', 'claude/haiku'])
  await click(inRow(favoriteRow('claude/haiku'), 'ext-favorite-up'))
  assert.deepEqual(favoriteKeys(), ['claude/sonnet', 'claude/haiku', 'claude/opus'])
  assert.deepEqual(lastSaved().favorites, ['claude/sonnet', 'claude/haiku', 'claude/opus'])
  await view.unmount()
})

test('favorites tab: a row without a star can still move, and only the starred rows are saved', async () => {
  useClaude()
  await setPrefs({ engines: {}, favorites: ['claude/opus', 'claude/sonnet', 'claude/haiku'] })
  const view = await mount()
  await click(inRow(favoriteRow('claude/sonnet'), 'ext-favorite-star'))
  await click(inRow(favoriteRow('claude/sonnet'), 'ext-favorite-up'))
  assert.deepEqual(favoriteKeys(), ['claude/sonnet', 'claude/opus', 'claude/haiku'])
  assert.deepEqual(lastSaved().favorites, ['claude/opus', 'claude/haiku'])
  await view.unmount()
})

test('favorites tab: a switch disables a model and the row stays on the tab', async () => {
  useClaude()
  await setPrefs({ engines: {}, favorites: ['claude/opus', 'claude/sonnet'] })
  const view = await mount()
  const toggle = () => inRow(favoriteRow('claude/opus'), 'ext-favorite-toggle')
  assert.equal(toggle().getAttribute('aria-checked'), 'true')
  await click(toggle())
  assert.deepEqual(lastSaved().engines.claude.hidden, ['opus'])
  assert.deepEqual(lastSaved().favorites, ['claude/opus', 'claude/sonnet'], 'it is still a favorite')
  assert.equal(toggle().getAttribute('aria-checked'), 'false')
  assert.equal(favoriteRow('claude/opus').className, 'rowHidden')
  await click(toggle())
  assert.deepEqual(lastSaved().engines.claude.hidden, [])
  assert.equal(toggle().getAttribute('aria-checked'), 'true')
  await view.unmount()
})

test('favorites tab: a star added on a provider page shows on the tab', async () => {
  useClaude()
  const view = await mount()
  await openTab('claude')
  await click(inRow(modelRow('opus'), 'ext-model-star'))
  await openTab('favorites')
  assert.deepEqual(favoriteKeys(), ['claude/opus'])
  await view.unmount()
})

// The model page of a provider

test('provider page: it lists the models without the entry that only names the default', async () => {
  useClaude()
  const view = await mount()
  await openTab('claude')
  assert.deepEqual(modelIds(), ['opus', 'sonnet', 'haiku'])
  assert.deepEqual(groups(), ['models.all'])
  assert.equal(modelRow('opus').querySelector('.name').textContent, 'Opus')
  assert.equal(byTestId('ext-models-count').textContent, 'models.count {"total":3,"favorites":0,"hidden":0}')
  await view.unmount()
})

test('provider page: a star moves a model into the Favorites group, and the count text changes', async () => {
  useClaude()
  const view = await mount()
  await openTab('claude')
  await click(inRow(modelRow('sonnet'), 'ext-model-star'))
  assert.deepEqual(lastSaved().favorites, ['claude/sonnet'])
  assert.deepEqual(groups(), ['picker.favorites', 'models.all'])
  assert.deepEqual(modelIds(), ['sonnet', 'opus', 'haiku'])
  assert.equal(inRow(modelRow('sonnet'), 'ext-model-star').getAttribute('aria-pressed'), 'true')
  assert.equal(byTestId('ext-models-count').textContent, 'models.countOne {"total":3,"favorites":1,"hidden":0}')
  await click(inRow(modelRow('sonnet'), 'ext-model-star'))
  assert.deepEqual(lastSaved().favorites, [])
  assert.deepEqual(modelIds(), ['opus', 'sonnet', 'haiku'])
  await view.unmount()
})

test('provider page: a star on an added instance uses the key of that instance', async () => {
  server.info['claude@star-a'] = info([model('opus', 'Opus')])
  await setInstances([instance('star-a')])
  const view = await mount()
  await openTab('claude@star-a')
  await click(inRow(modelRow('opus'), 'ext-model-star'))
  assert.deepEqual(lastSaved().favorites, ['claude@star-a/opus'])
  await view.unmount()
})

test('provider page: hide moves a model to the Hidden group, without arrows, and show brings it back', async () => {
  useClaude()
  const view = await mount()
  await openTab('claude')
  await click(inRow(modelRow('opus'), 'ext-model-toggle'))
  assert.deepEqual(lastSaved().engines.claude.hidden, ['opus'])
  assert.deepEqual(groups(), ['models.all', 'models.hidden'])
  assert.deepEqual(modelIds(), ['sonnet', 'haiku', 'opus'])
  assert.equal(inRow(modelRow('opus'), 'ext-model-toggle').getAttribute('aria-checked'), 'false')
  assert.equal(inRow(modelRow('opus'), 'ext-model-up'), null)
  assert.equal(inRow(modelRow('opus'), 'ext-model-down'), null)
  assert.equal(byTestId('ext-models-count').textContent, 'models.count {"total":3,"favorites":0,"hidden":1}')
  await click(inRow(modelRow('opus'), 'ext-model-toggle'))
  assert.deepEqual(lastSaved().engines.claude.hidden, [])
  assert.deepEqual(modelIds(), ['opus', 'sonnet', 'haiku'])
  await view.unmount()
})

test('provider page: a hidden favorite stays in the Favorites group, shown as off', async () => {
  useClaude()
  await setPrefs({ engines: { claude: { hidden: ['opus'], order: [], custom: [] } }, favorites: ['claude/opus'] })
  const view = await mount()
  await openTab('claude')
  assert.deepEqual(groups(), ['picker.favorites', 'models.all'])
  assert.equal(modelIds()[0], 'opus')
  assert.equal(inRow(modelRow('opus'), 'ext-model-toggle').getAttribute('aria-checked'), 'false')
  await view.unmount()
})

test('provider page: reorder moves a row within its group, saves the order, and the ends cannot move', async () => {
  useClaude()
  const view = await mount()
  await openTab('claude')
  assert.equal(inRow(modelRow('opus'), 'ext-model-up').disabled, true)
  assert.equal(inRow(modelRow('haiku'), 'ext-model-down').disabled, true)
  await click(inRow(modelRow('opus'), 'ext-model-down'))
  assert.deepEqual(modelIds(), ['sonnet', 'opus', 'haiku'])
  assert.deepEqual(lastSaved().engines.claude.order, ['sonnet', 'opus', 'haiku'])
  await click(inRow(modelRow('haiku'), 'ext-model-up'))
  assert.deepEqual(modelIds(), ['sonnet', 'haiku', 'opus'])
  await view.unmount()
})

test('provider page: a saved order is used when the page opens', async () => {
  useClaude()
  await setPrefs({ engines: { claude: { hidden: [], order: ['haiku', 'opus'], custom: [] } }, favorites: [] })
  const view = await mount()
  await openTab('claude')
  assert.deepEqual(modelIds(), ['haiku', 'opus', 'sonnet'])
  await view.unmount()
})

test('provider page: a favorite cannot move past the end of its group into the other group', async () => {
  useClaude()
  await setPrefs({ engines: {}, favorites: ['claude/sonnet'] })
  const view = await mount()
  await openTab('claude')
  assert.equal(inRow(modelRow('sonnet'), 'ext-model-up').disabled, true)
  assert.equal(inRow(modelRow('sonnet'), 'ext-model-down').disabled, true)
  assert.equal(inRow(modelRow('opus'), 'ext-model-up').disabled, true)
  await view.unmount()
})

test('provider page: disable all hides each listed model, and the button then enables them all', async () => {
  useClaude()
  const view = await mount()
  await openTab('claude')
  const toggleAll = byTestId('ext-models-toggle-all')
  assert.equal(toggleAll.textContent, 'models.disableAll')
  await click(toggleAll)
  assert.deepEqual([...lastSaved().engines.claude.hidden].sort(), ['haiku', 'opus', 'sonnet'])
  assert.equal(byTestId('ext-models-toggle-all').textContent, 'models.enableAll')
  assert.deepEqual(groups(), ['models.hidden'])
  await click(byTestId('ext-models-toggle-all'))
  assert.deepEqual(lastSaved().engines.claude.hidden, [])
  assert.equal(byTestId('ext-models-toggle-all').textContent, 'models.disableAll')
  await view.unmount()
})

test('provider page: disable all with one model already hidden hides the others', async () => {
  useClaude()
  await setPrefs({ engines: { claude: { hidden: ['opus'], order: [], custom: [] } }, favorites: [] })
  const view = await mount()
  await openTab('claude')
  assert.equal(byTestId('ext-models-toggle-all').textContent, 'models.disableAll')
  await click(byTestId('ext-models-toggle-all'))
  assert.deepEqual([...lastSaved().engines.claude.hidden].sort(), ['haiku', 'opus', 'sonnet'])
  await view.unmount()
})

test('provider page: disable all leaves custom models alone', async () => {
  server.info.claude = info([model('opus', 'Opus')])
  await setPrefs({ engines: { claude: { hidden: [], order: [], custom: ['my-model'] } }, favorites: [] })
  const view = await mount()
  await openTab('claude')
  await click(byTestId('ext-models-toggle-all'))
  assert.deepEqual(lastSaved().engines.claude.hidden, ['opus'])
  assert.equal(byTestId('ext-models-toggle-all').textContent, 'models.enableAll', 'a custom model does not stop the button from changing')
  assert.deepEqual(groups(), ['models.all', 'models.hidden'])
  await view.unmount()
})

test('provider page: disable all cannot be used when the provider lists no model', async () => {
  const view = await mount()
  await openTab('claude')
  assert.equal(byTestId('ext-models-toggle-all').disabled, true)
  await view.unmount()
})

test('provider page: a load error is shown on the page', async () => {
  server.info['claude@page-error'] = { failure: 'The engine did not start.' }
  await setInstances([instance('page-error')])
  const view = await mount()
  await openTab('claude@page-error')
  assert.deepEqual(alerts(), ['The engine did not start.'])
  await view.unmount()
})

test('provider page: the DeepSeek Harness page lists its catalog and offers no custom model', async () => {
  await setCatalog([{ id: 'route/one', name: 'One', description: '', efforts: [] }])
  const view = await mount()
  await openTab('dsh')
  assert.deepEqual(modelIds(), ['route/one'])
  assert.equal(byTestId('ext-models-add'), null)
  await click(inRow(modelRow('route/one'), 'ext-model-toggle'))
  assert.deepEqual(lastSaved().engines.dsh.hidden, ['route/one'])
  await view.unmount()
})

// Custom models

async function openAdd() {
  await openTab('claude')
  await click(byTestId('ext-models-add'))
}
const slug = () => byTestId('ext-models-slug')
const addSave = () => byTestId('ext-models-add-save')

test('custom model: the add button opens and closes the field, and closing removes the error', async () => {
  const view = await mount()
  await openTab('claude')
  assert.equal(slug(), null)
  await click(byTestId('ext-models-add'))
  assert.notEqual(slug(), null)
  await click(addSave())
  assert.deepEqual(alerts(), ['models.invalidSlug'])
  await click(byTestId('ext-models-add'))
  assert.equal(slug(), null)
  await click(byTestId('ext-models-add'))
  assert.deepEqual(alerts(), [])
  await view.unmount()
})

for (const [name, value] of [['empty', ''], ['only spaces', '   '], ['has a space inside', 'my model'], ['has a tab inside', 'my\tmodel'], ['too long', 'x'.repeat(257)]]) {
  test(`custom model: an id that is ${name} is refused and nothing is saved`, async () => {
    const view = await mount()
    await openAdd()
    await setValue(slug(), value)
    await click(addSave())
    assert.deepEqual(alerts(), ['models.invalidSlug'])
    assert.equal(server.saved.length, 0)
    assert.notEqual(slug(), null, 'the field stays open')
    await view.unmount()
  })
}

test('custom model: the longest allowed id is accepted', async () => {
  const view = await mount()
  await openAdd()
  await setValue(slug(), 'x'.repeat(256))
  await click(addSave())
  assert.deepEqual(alerts(), [])
  assert.deepEqual(lastSaved().engines.claude.custom, ['x'.repeat(256)])
  await view.unmount()
})

test('custom model: an id the provider lists is a duplicate', async () => {
  useClaude()
  const view = await mount()
  await openAdd()
  await setValue(slug(), 'opus')
  await click(addSave())
  assert.deepEqual(alerts(), ['models.duplicateSlug'])
  assert.equal(server.saved.length, 0)
  await view.unmount()
})

test('custom model: an id already added is a duplicate, also with spaces around it', async () => {
  await setPrefs({ engines: { claude: { hidden: [], order: [], custom: ['my-model'] } }, favorites: [] })
  const view = await mount()
  await openAdd()
  await setValue(slug(), '  my-model  ')
  await click(addSave())
  assert.deepEqual(alerts(), ['models.duplicateSlug'])
  assert.equal(server.saved.length, 0)
  await view.unmount()
})

test('custom model: typing removes the error', async () => {
  const view = await mount()
  await openAdd()
  await click(addSave())
  assert.deepEqual(alerts(), ['models.invalidSlug'])
  await setValue(slug(), 'a')
  assert.deepEqual(alerts(), [])
  await view.unmount()
})

test('custom model: a valid id is trimmed, saved and listed with a remove button instead of a switch', async () => {
  const view = await mount()
  await openAdd()
  await setValue(slug(), '  my-model  ')
  await click(addSave())
  assert.deepEqual(lastSaved().engines.claude.custom, ['my-model'])
  assert.equal(slug(), null, 'the field closes')
  assert.deepEqual(modelIds(), ['my-model'])
  assert.notEqual(inRow(modelRow('my-model'), 'ext-model-remove'), null)
  assert.equal(inRow(modelRow('my-model'), 'ext-model-toggle'), null)
  await click(byTestId('ext-models-add'))
  assert.equal(slug().value, '', 'the field is empty the next time')
  await view.unmount()
})

test('custom model: Enter in the field adds the model', async () => {
  const view = await mount()
  await openAdd()
  await setValue(slug(), 'typed-model')
  await act(() => { slug().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  assert.deepEqual(lastSaved().engines.claude.custom, ['typed-model'])
  await view.unmount()
})

test('custom model: another key in the field adds nothing', async () => {
  const view = await mount()
  await openAdd()
  await setValue(slug(), 'typed-model')
  await act(() => { slug().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true })) })
  assert.equal(server.saved.length, 0)
  await view.unmount()
})

test('custom model: remove deletes the row, its place and its star', async () => {
  await setPrefs({ engines: { claude: { hidden: [], order: ['my-model'], custom: ['my-model'] } }, favorites: ['claude/my-model'] })
  const view = await mount()
  await openTab('claude')
  await click(inRow(modelRow('my-model'), 'ext-model-remove'))
  assert.deepEqual(modelIds(), [])
  assert.deepEqual(lastSaved().engines.claude.custom, [])
  assert.deepEqual(lastSaved().engines.claude.order, [])
  assert.deepEqual(lastSaved().favorites, [])
  await view.unmount()
})

test('custom model: another tab closes the field', async () => {
  const view = await mount()
  await openAdd()
  await click(addSave())
  await openTab('codex')
  assert.equal(slug(), null)
  await click(byTestId('ext-models-add'))
  assert.deepEqual(alerts(), [], 'the error of the other provider is gone')
  await view.unmount()
})

// The filter

const filter = () => byTestId('ext-models-filter')

test('filter: it matches the name and the id, in any case, and ignores spaces around the text', async () => {
  server.info.claude = info([model('fast-1', 'Quick Model'), model('slow-2', 'Careful Model')])
  const view = await mount()
  await openTab('claude')
  await setValue(filter(), 'QUICK')
  assert.deepEqual(modelIds(), ['fast-1'])
  await setValue(filter(), '  slow-  ')
  assert.deepEqual(modelIds(), ['slow-2'])
  await setValue(filter(), '')
  assert.deepEqual(modelIds(), ['fast-1', 'slow-2'])
  await view.unmount()
})

test('filter: with no match the group headings go away and the count stays', async () => {
  useClaude()
  const view = await mount()
  await openTab('claude')
  await setValue(filter(), 'nothing-matches')
  assert.deepEqual(modelIds(), [])
  assert.deepEqual(groups(), [])
  assert.equal(byTestId('ext-models-count').textContent, 'models.count {"total":3,"favorites":0,"hidden":0}')
  await view.unmount()
})

test('filter: only the groups with a match stay', async () => {
  useClaude()
  await setPrefs({ engines: { claude: { hidden: ['haiku'], order: [], custom: [] } }, favorites: ['claude/opus'] })
  const view = await mount()
  await openTab('claude')
  assert.deepEqual(groups(), ['picker.favorites', 'models.all', 'models.hidden'])
  await setValue(filter(), 'haiku')
  assert.deepEqual(groups(), ['models.hidden'])
  await view.unmount()
})

test('filter: a filtered row still moves within its whole group', async () => {
  useClaude()
  const view = await mount()
  await openTab('claude')
  await setValue(filter(), 'sonnet')
  assert.equal(inRow(modelRow('sonnet'), 'ext-model-up').disabled, false, 'the row has a neighbor that the filter hides')
  await view.unmount()
})

test('filter: another tab clears it', async () => {
  useClaude()
  const view = await mount()
  await openTab('claude')
  await setValue(filter(), 'opus')
  await openTab('codex')
  assert.equal(filter().value, '')
  await view.unmount()
})

// The enable switch of a provider

test('enable switch: a provider starts on, and the switch turns it off and on', async () => {
  const view = await mount()
  const toggle = () => byTestId('ext-models-enable-claude')
  assert.equal(toggle().getAttribute('aria-checked'), 'true')
  await click(toggle())
  assert.deepEqual(lastSaved().disabled, ['claude'])
  assert.equal(toggle().getAttribute('aria-checked'), 'false')
  await click(toggle())
  assert.deepEqual(lastSaved().disabled, [])
  assert.equal(toggle().getAttribute('aria-checked'), 'true')
  await view.unmount()
})

test('enable switch: each provider has its own state, and the row names it', async () => {
  await setInstances([instance('switch-a')])
  await setPrefs({ engines: {}, favorites: [], disabled: ['claude@switch-a'] })
  const view = await mount()
  assert.equal(byTestId('ext-models-enable-claude@switch-a').getAttribute('aria-checked'), 'false')
  assert.equal(byTestId('ext-models-enable-claude@switch-a').getAttribute('aria-label'), 'Label switch-a')
  assert.equal(byTestId('ext-models-enable-claude').getAttribute('aria-checked'), 'true')
  await view.unmount()
})

test('enable switch: it does not open the provider page', async () => {
  const view = await mount()
  await click(byTestId('ext-models-enable-claude'))
  assert.equal(byTestId('ext-models-provider-favorites').className, 'engineActive')
  await view.unmount()
})

test('enable switch: a provider that is off still has its model page', async () => {
  useClaude()
  await setPrefs({ engines: {}, favorites: [], disabled: ['claude'] })
  const view = await mount()
  await openTab('claude')
  assert.deepEqual(modelIds(), ['opus', 'sonnet', 'haiku'])
  await view.unmount()
})

// The sign-in notice

test('sign-in notice: a provider page that is not signed in shows it, and the list pages do not', async () => {
  server.login['claude@notice-a'] = { signedIn: false }
  await setInstances([instance('notice-a')])
  const view = await mount()
  assert.equal(byTestId('ext-login-bar'), null, 'not on Favorites')
  await openTab('dsh')
  assert.equal(byTestId('ext-login-bar'), null, 'not on DeepSeek Harness')
  await openTab('claude@notice-a')
  assert.equal(byTestId('ext-login-bar').dataset.state, 'needed')
  assert.match(byTestId('ext-login-bar').textContent, /login\.needed \{"name":"Label notice-a"\}/)
  await view.unmount()
})

test('sign-in notice: a signed-in provider page has no notice', async () => {
  server.login['claude@notice-b'] = { signedIn: true }
  await setInstances([instance('notice-b')])
  const view = await mount()
  await openTab('claude@notice-b')
  assert.equal(byTestId('ext-login-bar'), null)
  await view.unmount()
})

test('sign-in notice: a provider with an unknown state has no notice', async () => {
  await setInstances([instance('notice-c')])
  const view = await mount()
  await openTab('claude@notice-c')
  assert.equal(byTestId('ext-login-bar'), null)
  await view.unmount()
})

test('sign-in notice: Sign in starts the login of that instance', async () => {
  server.login['codex@notice-d'] = { signedIn: false }
  await setInstances([instance('notice-d', 'codex')])
  const view = await mount()
  await openTab('codex@notice-d')
  await click(byTestId('ext-login-start'))
  await settle()
  assert.deepEqual(server.loginPosts, [{ engine: 'codex', action: 'start', instance: 'notice-d' }])
  await view.unmount()
})

// An added instance

const loginText = () => document.querySelector('.loginCommand')?.textContent

test('added instance: the login command of Codex names its home and binary', async () => {
  await setInstances([instance('cmd-a', 'codex', { home: '/invented/codex-home', binaryPath: '/invented/bin/codex' })])
  const view = await mount()
  await openTab('codex@cmd-a')
  assert.equal(loginText(), 'CODEX_HOME=/invented/codex-home /invented/bin/codex login')
  await view.unmount()
})

test('added instance: the login command of Claude names its home and binary', async () => {
  await setInstances([instance('cmd-b', 'claude', { home: '/invented/claude-home', binaryPath: '/invented/bin/claude' })])
  const view = await mount()
  await openTab('claude@cmd-b')
  assert.equal(loginText(), 'CLAUDE_CONFIG_DIR=/invented/claude-home /invented/bin/claude auth login')
  await view.unmount()
})

test('added instance: with no binary path the command uses the plain engine name', async () => {
  await setInstances([instance('cmd-c', 'codex', { home: '/invented/c' }), instance('cmd-d', 'claude', { home: '/invented/d' })])
  const view = await mount()
  await openTab('codex@cmd-c')
  assert.equal(loginText(), 'CODEX_HOME=/invented/c codex login')
  await openTab('claude@cmd-d')
  assert.equal(loginText(), 'CLAUDE_CONFIG_DIR=/invented/d claude auth login')
  await view.unmount()
})

test('added instance: the default providers have no login command and no remove button', async () => {
  const view = await mount()
  await openTab('claude')
  assert.equal(loginText(), undefined)
  assert.equal(byTestId('ext-provider-remove'), null)
  await view.unmount()
})

test('added instance: remove asks the host, drops the row and goes back to Favorites', async () => {
  await setInstances([instance('rm-a')])
  server.instancePost = (body) => { server.instances = []; assert.deepEqual(body, { action: 'remove', id: 'rm-a' }); return json({ instances: [] }) }
  const view = await mount()
  await openTab('claude@rm-a')
  await click(byTestId('ext-provider-remove'))
  await settle()
  assert.deepEqual(server.instancePosts, [{ action: 'remove', id: 'rm-a' }])
  assert.equal(byTestId('ext-models-provider-claude@rm-a'), null)
  assert.equal(byTestId('ext-models-provider-favorites').className, 'engineActive')
  await view.unmount()
})

test('added instance: a refused remove keeps the provider and its page', async () => {
  await setInstances([instance('rm-b')])
  server.instancePost = () => json({ error: 'It is in use.' }, 400)
  const view = await mount()
  await openTab('claude@rm-b')
  await click(byTestId('ext-provider-remove'))
  await settle()
  assert.notEqual(byTestId('ext-models-provider-claude@rm-b'), null)
  assert.equal(byTestId('ext-models-provider-claude@rm-b').className, 'engineActive')
  await view.unmount()
})

// Add provider

test('add provider: both add buttons open the dialog, and it closes again', async () => {
  const view = await mount()
  for (const button of ['ext-provider-add', 'ext-provider-add-title']) {
    assert.equal(byTestId('ext-add-provider'), null)
    await click(byTestId(button))
    assert.notEqual(byTestId('ext-add-provider'), null)
    await click(document.querySelector('button[aria-label="manage.cancel"]'))
  }
  assert.equal(byTestId('ext-add-provider'), null)
  await view.unmount()
})

test('add provider: the suggested id skips the instances that exist', async () => {
  await setInstances([instance('codex_2', 'codex')])
  const view = await mount()
  await click(byTestId('ext-provider-add'))
  await click(byTestId('ext-add-provider-next'))
  assert.equal(byTestId('ext-add-provider-id').value, 'codex_3')
  await view.unmount()
})

test('add provider: a new instance is added to the list and the dialog closes', async () => {
  server.instancePost = (body) => { server.instances = [{ ...body.instance, label: 'Added' }]; return json({ instances: server.instances }) }
  const view = await mount()
  await click(byTestId('ext-provider-add'))
  await click(byTestId('ext-add-provider-next'))
  await click(byTestId('ext-add-provider-next'))
  await setValue(byTestId('ext-add-provider-home'), '/invented/new-home')
  await click(byTestId('ext-add-provider-save'))
  await settle()
  assert.equal(server.instancePosts[0].action, 'add')
  assert.equal(byTestId('ext-add-provider'), null)
  assert.match(byTestId('ext-models-engine-codex@codex_2').textContent, /Added/)
  await view.unmount()
})

test('add provider: a refusal of the host stays in the dialog', async () => {
  server.instancePost = () => json({ error: 'That folder cannot be used.' }, 400)
  const view = await mount()
  await click(byTestId('ext-provider-add'))
  await click(byTestId('ext-add-provider-next'))
  await click(byTestId('ext-add-provider-next'))
  await setValue(byTestId('ext-add-provider-home'), '/invented/bad-home')
  await click(byTestId('ext-add-provider-save'))
  await settle()
  assert.notEqual(byTestId('ext-add-provider'), null)
  assert.deepEqual(alerts(), ['That folder cannot be used.'])
  await view.unmount()
})

// This test runs last: the sign-in store never forgets a known state of the default Claude provider.
test('status line: a missing executable wins over the sign-in check and over a load error', async () => {
  server.login.claude = { signedIn: false }
  server.info.claude = { failure: 'boom' }
  const { refreshLogin } = await import('../src/client/login-store.ts')
  await act(() => refreshLogin('claude', true))
  const view = await mount({ rows: [row('claude', 'missing')] })
  assert.equal(statusOf('claude'), 'about.status.missing')
  await view.unmount()
})

test('added instance: the reason of a refused remove is on the provider page', async () => {
  await setInstances([instance('rm-reason')])
  server.instancePost = () => json({ error: 'It is in use.' }, 400)
  const view = await mount()
  await openTab('claude@rm-reason')
  await click(byTestId('ext-provider-remove'))
  await settle()
  assert.equal(byTestId('ext-provider-remove-error').textContent, 'It is in use.')
  await view.unmount()
})

test('added instance: a network failure on remove is shown and is not an unhandled rejection', async () => {
  await setInstances([instance('rm-network')])
  server.instancePost = () => { throw new Error('network down') }
  const view = await mount()
  await openTab('claude@rm-network')
  await click(byTestId('ext-provider-remove'))
  await settle()
  assert.equal(byTestId('ext-provider-remove-error').textContent, 'network down')
  await view.unmount()
})

test('add provider: the suggested id is free also when a Codex instance is hidden because Codex is off', async () => {
  await setInstances([instance('codex_2', 'codex')])
  const view = await mount({ codexEnabled: false })
  await click(byTestId('ext-provider-add'))
  await click(byTestId('ext-add-provider-codex'))
  await click(byTestId('ext-add-provider-next'))
  assert.equal(byTestId('ext-add-provider-id').value, 'codex_3')
  await view.unmount()
})
