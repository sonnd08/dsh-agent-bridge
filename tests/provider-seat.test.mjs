import test from 'node:test'
import assert from 'node:assert/strict'

const { render, click, byTestId, allByTestId, t, act, React } = await import('./support/dom.mjs')
const { ProviderSeat, LoginDock } = await import('../src/client/NewChat.tsx')
const { useProviders } = await import('../src/client/providers-store.ts')
const { useModelPrefs } = await import('../src/client/model-prefs-store.ts')
const { useDshCatalog } = await import('../src/client/dsh-catalog-store.ts')

const NO_PREFS = { engines: {}, favorites: [] }
const LOW = { id: 'low', name: 'Low' }
const MEDIUM = { id: 'medium', name: 'Medium' }
const HIGH = { id: 'high', name: 'High' }

const GROUPS = [
  { id: 'third-party', name: 'Third', models: [{ id: 'lite', name: 'Lite' }] },
  { id: 'deepseek-official', name: 'Official', models: [{ id: 'flash', name: 'Flash', reasoning: { defaultEffort: 'high', efforts: [LOW, HIGH] } }] },
  { id: 'deepseek-account', name: 'Account', models: [{ id: 'pro', name: 'Pro' }] },
  { id: 'claude-code', name: 'Claude route', models: [{ id: 'sonnet', name: 'Sonnet', reasoning: { efforts: [LOW, MEDIUM, HIGH] } }, { id: 'plain', name: 'Plain' }] },
  { id: 'codex-cli', name: 'Codex route', models: [{ id: 'gpt-test', name: 'GPT Test', reasoning: { defaultEffort: 'low', efforts: [LOW, MEDIUM] } }, { id: 'odd', name: 'Odd', reasoning: { defaultEffort: 'deep', efforts: [{ id: 'quick', name: 'Quick' }, { id: 'deep', name: 'Deep' }] } }] },
]
const CLAUDE = { provider: 'claude-code', model: 'sonnet' }
const CODEX = { provider: 'codex-cli', model: 'gpt-test' }
const DEEPSEEK = { provider: 'deepseek-official', model: 'flash' }

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status })

// The stores keep their state at module level and NewChat imports them directly, so each test resets them through their own functions.
const site = { instances: [], logins: {}, prefsPosts: [], loginReads: [] }
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const path = String(url)
  if (path.includes('/instances')) return reply({ instances: site.instances })
  if (path.includes('/model-prefs')) {
    if (init.method === 'POST') { site.prefsPosts.push(JSON.parse(init.body)); return reply({ ok: true }) }
    return reply(NO_PREFS)
  }
  if (path.includes('/login')) {
    site.loginReads.push(path)
    const instance = new URL(path, 'http://localhost').searchParams.get('instance')
    return reply(site.logins[instance ?? new URL(path, 'http://localhost').searchParams.get('engine')] ?? {})
  }
  throw new Error(`unexpected request: ${path}`)
}
test.after(() => { globalThis.fetch = originalFetch })

let controls
let harnessRows = []
function Controls() {
  controls = { providers: useProviders(), prefs: useModelPrefs() }
  harnessRows = useDshCatalog()
  return null
}
const keeper = await render(React.createElement(Controls))
test.after(() => keeper.unmount())

const setInstances = async (instances) => {
  site.instances = instances
  await act(() => controls.providers.add({}))
}
const setPrefs = prefs => act(() => { controls.prefs[1](prefs) })

test.beforeEach(async () => {
  await setInstances([])
  await setPrefs(NO_PREFS)
  site.prefsPosts = []
  site.logins = {}
  site.loginReads = []
})

function catalogStore(initial) {
  let state = initial
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: next => act(() => { state = next; for (const listener of [...listeners]) listener() }),
  }
}

const catalogState = (current = null, groups = GROUPS, extra = {}) => ({ current, groups, status: 'ready', error: null, ...extra })

function makeServices(current, extra = {}) {
  const selected = []
  const catalog = catalogStore(catalogState(current))
  const services = {
    catalog,
    loadCatalog: () => { services.loads += 1 },
    loads: 0,
    selectModel: (selection) => { selected.push(selection) },
    codexEnabled: () => true,
    subscribeBridge: () => () => {},
    nativePermission: () => undefined,
    openSettings: undefined,
    ...extra,
  }
  return { services, selected, catalog }
}

const noProjection = () => undefined
const seat = (services, props = {}) => React.createElement(ProviderSeat, { services, useProjection: noProjection, t, ...props })
const trigger = () => byTestId('ext-provider-trigger')
const openPanel = () => click(trigger())
const rails = () => [...document.querySelectorAll('[data-testid^="ext-provider-rail-"]')].map(item => item.dataset.testid.replace('ext-provider-rail-', ''))
const rail = engine => byTestId(`ext-provider-rail-${engine}`)
const models = () => allByTestId('ext-provider-model').map(item => item.dataset.model)
const model = id => allByTestId('ext-provider-model').find(item => item.dataset.model === id)
const effort = id => allByTestId('ext-provider-effort').find(item => item.dataset.effort === id)

async function mountSeat(current = null, extra = {}, props = {}) {
  const made = makeServices(current, extra)
  const view = await render(seat(made.services, props))
  return { ...made, view }
}

test('model seat: the catalog is requested when the seat opens', async () => {
  const { services, view } = await mountSeat()
  assert.equal(services.loads, 1)
  await view.unmount()
})

test('model seat: the rails are DeepSeek and one per provider', async () => {
  const { view } = await mountSeat()
  await setInstances([{ id: 'work', engine: 'claude', label: 'Work account', accent: '#123456' }])
  await openPanel()
  assert.deepEqual(rails(), ['favorites', 'dsh', 'codex', 'claude', 'claude@work'])
  assert.equal(rail('claude@work').title, 'Work account')
  assert.equal(rail('dsh').title, 'picker.dsh')
  await view.unmount()
})

test('model seat: the DeepSeek rail holds the harness providers, account first and the engine routes left out', async () => {
  const { view } = await mountSeat(DEEPSEEK)
  await openPanel()
  assert.deepEqual(models(), ['deepseek-account/pro', 'deepseek-official/flash', 'third-party/lite'])
  await view.unmount()
})

test('model seat: a provider rail lists the models of its route, by their own id', async () => {
  const { view } = await mountSeat(CLAUDE)
  await openPanel()
  assert.deepEqual(models(), ['sonnet', 'plain'])
  await click(rail('codex'))
  assert.deepEqual(models(), ['gpt-test', 'odd'])
  await view.unmount()
})

test('model seat: an added instance uses its own id as the route', async () => {
  const groups = [{ id: 'claude@work', name: 'Work route', models: [{ id: 'haiku', name: 'Haiku' }] }]
  const { catalog, view } = await mountSeat()
  await setInstances([{ id: 'work', engine: 'claude', label: 'Work account' }])
  await catalog.set(catalogState({ provider: 'claude@work', model: 'haiku' }, groups))
  assert.equal(trigger().dataset.engineSelected, 'claude@work')
  await openPanel()
  assert.deepEqual(models(), ['haiku'])
  await view.unmount()
})

test('model seat: a provider that the catalog does not hold has an empty rail', async () => {
  const { catalog, view } = await mountSeat()
  await catalog.set(catalogState(null, GROUPS.filter(group => group.id !== 'codex-cli')))
  await openPanel()
  await click(rail('codex'))
  assert.deepEqual(models(), [])
  assert.match(byTestId('ext-provider-panel').textContent, /picker\.empty/)
  await view.unmount()
})

test('model seat: the trigger names the model and level of a Claude chat', async () => {
  const { view } = await mountSeat({ ...CLAUDE, reasoningEffort: 'high' })
  assert.equal(trigger().dataset.engineSelected, 'claude')
  assert.match(trigger().textContent, /Sonnet/)
  assert.match(trigger().textContent, /High/)
  await view.unmount()
})

test('model seat: a chat on Codex shows the Codex model and the default level of the model', async () => {
  const { view } = await mountSeat(CODEX)
  assert.equal(trigger().dataset.engineSelected, 'codex')
  assert.match(trigger().textContent, /GPT Test/)
  assert.match(trigger().textContent, /Low/)
  await view.unmount()
})

test('model seat: a chat on Codex opens with the Codex rail and marks its model', async () => {
  const { view } = await mountSeat(CODEX)
  await openPanel()
  assert.equal(rail('codex').className, 'railActive')
  assert.notEqual(model('gpt-test').querySelector('svg'), null)
  assert.equal(model('odd').querySelector('svg'), null)
  await view.unmount()
})

test('model seat: a chat on a harness model shows the DeepSeek provider', async () => {
  const { view } = await mountSeat(DEEPSEEK)
  assert.equal(trigger().dataset.engineSelected, 'dsh')
  assert.match(trigger().textContent, /Flash/)
  await view.unmount()
})

test('model seat: with no selection the trigger shows the title', async () => {
  const { view } = await mountSeat()
  assert.match(trigger().textContent, /picker\.title/)
  assert.equal(trigger().dataset.engineSelected, 'dsh')
  await view.unmount()
})

test('model seat: a model that is not in the catalog shows its id', async () => {
  const { view } = await mountSeat({ provider: 'codex-cli', model: 'unlisted-model' })
  assert.match(trigger().textContent, /unlisted-model/)
  await view.unmount()
})

test('model seat: the label follows the store when another model is selected', async () => {
  const { catalog, view } = await mountSeat(CLAUDE)
  assert.match(trigger().textContent, /Sonnet/)
  await catalog.set(catalogState(CODEX))
  assert.match(trigger().textContent, /GPT Test/)
  assert.equal(trigger().dataset.engineSelected, 'codex')
  await view.unmount()
})

test('model seat: the label changes from the id to the name when the catalog arrives', async () => {
  const { catalog, view } = await mountSeat()
  await catalog.set(catalogState(CODEX, []))
  assert.match(trigger().textContent, /gpt-test/)
  await catalog.set(catalogState(CODEX))
  assert.match(trigger().textContent, /GPT Test/)
  await view.unmount()
})

test('model seat: a pick of a provider model sends its route and Medium when nothing else applies', async () => {
  const { selected, view } = await mountSeat()
  await openPanel()
  await click(rail('claude'))
  await click(model('sonnet'))
  assert.deepEqual(selected, [{ provider: 'claude-code', model: 'sonnet', reasoningEffort: 'medium' }])
  await view.unmount()
})

test('model seat: a pick keeps the current level if the new model supports it', async () => {
  const { selected, view } = await mountSeat({ ...CLAUDE, reasoningEffort: 'low' })
  await openPanel()
  await click(rail('codex'))
  await click(model('gpt-test'))
  assert.deepEqual(selected, [{ provider: 'codex-cli', model: 'gpt-test', reasoningEffort: 'low' }])
  await view.unmount()
})

test('model seat: a pick uses Medium if the new model does not have the current level', async () => {
  const { selected, view } = await mountSeat({ ...CLAUDE, reasoningEffort: 'high' })
  await openPanel()
  await click(rail('codex'))
  await click(model('gpt-test'))
  assert.deepEqual(selected, [{ provider: 'codex-cli', model: 'gpt-test', reasoningEffort: 'medium' }])
  await view.unmount()
})

test('model seat: a pick restores the saved level of the model', async () => {
  await setPrefs({ ...NO_PREFS, efforts: { 'claude/sonnet': 'high' } })
  const { selected, view } = await mountSeat(CODEX)
  await openPanel()
  await click(rail('claude'))
  await click(model('sonnet'))
  assert.deepEqual(selected, [{ provider: 'claude-code', model: 'sonnet', reasoningEffort: 'high' }])
  await view.unmount()
})

test('model seat: a saved level that the model no longer has is not sent', async () => {
  await setPrefs({ ...NO_PREFS, efforts: { 'claude/sonnet': 'removed' } })
  const { selected, view } = await mountSeat()
  await openPanel()
  await click(rail('claude'))
  await click(model('sonnet'))
  assert.deepEqual(selected, [{ provider: 'claude-code', model: 'sonnet', reasoningEffort: 'medium' }])
  await view.unmount()
})

test('model seat: a click on a level sends that level and saves it for the model', async () => {
  const { selected, view } = await mountSeat(CLAUDE)
  await openPanel()
  await click(effort('high'))
  assert.deepEqual(selected, [{ provider: 'claude-code', model: 'sonnet', reasoningEffort: 'high' }])
  assert.equal(site.prefsPosts.at(-1).efforts['claude/sonnet'], 'high')
  await view.unmount()
})

test('model seat: the level of the model that the user leaves is saved', async () => {
  const { view } = await mountSeat({ ...CLAUDE, reasoningEffort: 'low' })
  await openPanel()
  await click(rail('codex'))
  await click(model('gpt-test'))
  assert.equal(site.prefsPosts.at(-1).efforts['claude/sonnet'], 'low')
  await view.unmount()
})

test('model seat: a model with its own default level gets it when no other level applies', async () => {
  const { selected, view } = await mountSeat()
  await openPanel()
  await click(rail('codex'))
  await click(model('odd'))
  assert.deepEqual(selected, [{ provider: 'codex-cli', model: 'odd', reasoningEffort: 'deep' }])
  await view.unmount()
})

test('model seat: a model with no levels is picked with no level', async () => {
  const { selected, view } = await mountSeat({ ...CLAUDE, reasoningEffort: 'high' })
  await openPanel()
  await click(model('plain'))
  assert.deepEqual(selected, [{ provider: 'claude-code', model: 'plain' }])
  await view.unmount()
})

test('model seat: a pick from the DeepSeek rail sends the harness provider and the plain model id', async () => {
  const { selected, view } = await mountSeat(CLAUDE)
  await openPanel()
  await click(rail('dsh'))
  await click(model('deepseek-official/flash'))
  assert.deepEqual(selected, [{ provider: 'deepseek-official', model: 'flash', reasoningEffort: 'high' }])
  await view.unmount()
})

test('model seat: a pick from the DeepSeek rail with no levels has no level', async () => {
  const { selected, view } = await mountSeat(CLAUDE)
  await openPanel()
  await click(rail('dsh'))
  await click(model('deepseek-account/pro'))
  assert.deepEqual(selected, [{ provider: 'deepseek-account', model: 'pro' }])
  await view.unmount()
})

test('model seat: a pick with nothing to remember saves no preferences', async () => {
  const { view } = await mountSeat()
  await openPanel()
  await click(rail('dsh'))
  await click(model('deepseek-account/pro'))
  assert.deepEqual(site.prefsPosts, [])
  await view.unmount()
})

test('model seat: a disabled engine is not offered', async () => {
  await setPrefs({ ...NO_PREFS, disabled: ['claude'] })
  const { view } = await mountSeat()
  await openPanel()
  assert.deepEqual(rails(), ['favorites', 'dsh', 'codex'])
  await view.unmount()
})

test('model seat: a disabled instance is not offered and the other engines stay', async () => {
  const { view } = await mountSeat()
  await setInstances([{ id: 'work', engine: 'claude', label: 'Work account' }, { id: 'home', engine: 'claude', label: 'Home account' }])
  await setPrefs({ ...NO_PREFS, disabled: ['claude@work'] })
  await openPanel()
  assert.deepEqual(rails(), ['favorites', 'dsh', 'codex', 'claude', 'claude@home'])
  await view.unmount()
})

test('model seat: a rail goes away while the panel is open when its engine is disabled', async () => {
  const { view } = await mountSeat()
  await openPanel()
  assert.ok(rails().includes('claude'))
  await setPrefs({ ...NO_PREFS, disabled: ['claude'] })
  assert.equal(rails().includes('claude'), false)
  await view.unmount()
})

test('model seat: a disabled engine still names the model of a chat that uses it', async () => {
  await setPrefs({ ...NO_PREFS, disabled: ['claude'] })
  const { view } = await mountSeat(CLAUDE)
  assert.match(trigger().textContent, /Sonnet/)
  assert.equal(trigger().dataset.engineSelected, 'claude')
  await view.unmount()
})

test('model seat: Codex is not offered when the plugin has it turned off', async () => {
  const { view } = await mountSeat(null, { codexEnabled: () => false })
  await openPanel()
  assert.deepEqual(rails(), ['favorites', 'dsh', 'claude'])
  await view.unmount()
})

test('model seat: the Codex rail appears when the plugin learns that it is on', async () => {
  let enabled = false
  const listeners = new Set()
  const { view } = await mountSeat(null, {
    codexEnabled: () => enabled,
    subscribeBridge: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  await openPanel()
  assert.equal(rails().includes('codex'), false)
  await act(() => { enabled = true; for (const listener of listeners) listener() })
  assert.equal(rails().includes('codex'), true)
  await view.unmount()
})

test('model seat: a hidden DeepSeek model is not offered, and the stored order applies', async () => {
  await setPrefs({ ...NO_PREFS, engines: { dsh: { hidden: ['third-party/lite'], order: ['deepseek-official/flash'], custom: [] } } })
  const { view } = await mountSeat(DEEPSEEK)
  await openPanel()
  assert.deepEqual(models(), ['deepseek-official/flash', 'deepseek-account/pro'])
  await view.unmount()
})

test('model seat: the loading text shows while the catalog loads', async () => {
  const { catalog, view } = await mountSeat()
  await catalog.set(catalogState(null, [], { status: 'loading' }))
  await openPanel()
  assert.match(byTestId('ext-provider-panel').textContent, /picker\.loading/)
  await view.unmount()
})

test('model seat: a catalog error shows on the rail', async () => {
  const { catalog, view } = await mountSeat()
  await catalog.set(catalogState(null, [], { status: 'failed', error: 'The catalog did not load.' }))
  await openPanel()
  await click(rail('claude'))
  assert.match(byTestId('ext-provider-panel').textContent, /The catalog did not load\./)
  await view.unmount()
})

test('model seat: with no catalog service it still shows the rails and the title', async () => {
  const { view } = await mountSeat(null, { catalog: undefined })
  assert.match(trigger().textContent, /picker\.title/)
  await openPanel()
  assert.deepEqual(rails(), ['favorites', 'dsh', 'codex', 'claude'])
  await view.unmount()
})

test('model seat: the harness models go to the settings page without the engine routes', async () => {
  const { view } = await mountSeat()
  assert.deepEqual(harnessRows.map(row => [row.id, row.description]), [
    ['deepseek-account/pro', 'Account'],
    ['deepseek-official/flash', 'Official'],
    ['third-party/lite', 'Third'],
  ])
  await view.unmount()
})

test('model seat: an empty catalog does not erase the list that the settings page has', async () => {
  const { catalog, view } = await mountSeat()
  const before = harnessRows
  await catalog.set(catalogState(null, []))
  assert.equal(harnessRows, before)
  await view.unmount()
})

test('model seat: a star saves the favorite under the rail key', async () => {
  const { view } = await mountSeat(CLAUDE)
  await openPanel()
  await click(model('plain').parentElement.querySelector('[aria-pressed]'))
  assert.deepEqual(site.prefsPosts.at(-1).favorites, ['claude/plain'])
  assert.equal(model('plain').parentElement.querySelector('[aria-pressed]').getAttribute('aria-pressed'), 'true')
  await view.unmount()
})

test('model seat: the gear opens the settings when the plugin offers them', async () => {
  let opens = 0
  const { view } = await mountSeat(null, { openSettings: () => { opens += 1 } })
  await openPanel()
  await click(byTestId('ext-provider-settings'))
  assert.equal(opens, 1)
  await view.unmount()
})

test('model seat: a locked seat cannot open and its chip is disabled', async () => {
  const native = nativePermission()
  const { view } = await mountSeat(CLAUDE, { nativePermission: () => native }, { locked: true, useProjection: selection('read-only') })
  assert.equal(trigger().disabled, true)
  assert.equal(byTestId('ext-provider-access-chip').disabled, true)
  await view.unmount()
})

// The harness permission presets.

function nativePermission(options = PRESETS, select = async () => true) {
  const selected = []
  const snapshot = { value: options === null ? null : { options } }
  return {
    catalog: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    select: (preset) => { selected.push(preset); return select(preset) },
    selected,
  }
}
function selection(currentValue) { return () => ({ currentValue }) }

const PRESETS = [
  { value: 'danger-full-access', name: 'danger-full-access' },
  { value: 'read-only', name: 'read-only' },
  { value: 'auto', name: 'Auto review' },
  { value: 'workspace-write', name: 'workspace-write', description: 'Text from the catalog.' },
]
const level = value => allByTestId('ext-provider-access-level').find(item => item.dataset.value === value)

async function mountAccess(current = 'read-only', options = PRESETS, select) {
  const native = nativePermission(options, select)
  const made = await mountSeat(CLAUDE, { nativePermission: () => native }, { useProjection: selection(current) })
  return { ...made, native }
}

test('access chip: the levels are Read Only, Workspace Write, Auto and Full access', async () => {
  const { view } = await mountAccess()
  await click(byTestId('ext-provider-access-chip'))
  assert.deepEqual(allByTestId('ext-provider-access-level').map(item => item.dataset.value), ['read-only', 'workspace-write', 'auto', 'danger-full-access'])
  await view.unmount()
})

test('access chip: the bridge names replace the raw ids, and an unknown preset keeps its own name', async () => {
  const { view } = await mountAccess()
  await click(byTestId('ext-provider-access-chip'))
  assert.equal(level('read-only').title, 'composer.permissionReadOnly')
  assert.equal(level('workspace-write').title, 'composer.permissionWorkspace')
  assert.equal(level('danger-full-access').title, 'composer.permissionFull')
  assert.equal(level('auto').title, 'Auto review')
  await view.unmount()
})

test('access chip: the catalog description wins, and the bridge text fills the gap', async () => {
  const { view } = await mountAccess('workspace-write')
  await click(byTestId('ext-provider-access-chip'))
  assert.match(byTestId('ext-provider-access-detail').textContent, /Text from the catalog\./)
  const details = [...document.querySelectorAll('.accessDetail > div')].map(item => item.textContent)
  assert.match(details[0], /picker\.accessReadOnly/)
  assert.match(details[3], /picker\.accessFull/)
  assert.equal(details[2], 'Auto review')
  await view.unmount()
})

test('access chip: it shows the current level', async () => {
  const { view } = await mountAccess('workspace-write')
  const chip = byTestId('ext-provider-access-chip')
  assert.equal(chip.dataset.value, 'workspace-write')
  assert.match(chip.textContent, /composer\.permissionWorkspace/)
  await view.unmount()
})

test('access chip: a safe level goes to the harness', async () => {
  const { native, view } = await mountAccess()
  await click(byTestId('ext-provider-access-chip'))
  await click(level('workspace-write'))
  assert.deepEqual(native.selected, ['workspace-write'])
  await view.unmount()
})

for (const risky of ['danger-full-access', 'auto']) {
  test(`access chip: ${risky} asks first`, async () => {
    const { native, view } = await mountAccess()
    await click(byTestId('ext-provider-access-chip'))
    await click(level(risky))
    assert.deepEqual(native.selected, [])
    assert.notEqual(document.querySelector('[role="alertdialog"],[role="dialog"]'), null)
    await view.unmount()
  })
}

test('access chip: a refused change warns and the seat stays usable', async (context) => {
  const warn = context.mock.method(console, 'warn', () => {})
  const { view } = await mountAccess('read-only', PRESETS, async () => { throw new Error('refused') })
  await click(byTestId('ext-provider-access-chip'))
  await click(level('workspace-write'))
  assert.equal(warn.mock.callCount(), 1)
  assert.notEqual(trigger(), null)
  await view.unmount()
})

test('access chip: no permission service means no chip and no footer control', async () => {
  const { view } = await mountSeat(CLAUDE, {}, { useProjection: selection('read-only') })
  assert.equal(byTestId('ext-provider-access-chip'), null)
  await openPanel()
  assert.equal(byTestId('ext-provider-access'), null)
  await view.unmount()
})

test('access chip: a catalog that is not loaded means no chip', async () => {
  const { view } = await mountAccess('read-only', null)
  assert.equal(byTestId('ext-provider-access-chip'), null)
  await view.unmount()
})

test('access chip: a session with no selection means no chip', async () => {
  const native = nativePermission()
  const { view } = await mountSeat(CLAUDE, { nativePermission: () => native })
  assert.equal(byTestId('ext-provider-access-chip'), null)
  await view.unmount()
})

test('access chip: the selector footer has the access control too', async () => {
  const { view } = await mountAccess('read-only')
  await openPanel()
  assert.match(byTestId('ext-provider-access').textContent, /composer\.permissionReadOnly/)
  await view.unmount()
})

// LoginDock

let serial = 0
/** The sign-in store keeps its state at module level, so each test uses its own instance. */
const instanceRoute = () => {
  serial += 1
  return { id: `dock${String(serial)}`, route: `claude@dock${String(serial)}`, label: `Dock ${String(serial)}` }
}

async function mountDock(current, instance) {
  if (instance !== undefined) await setInstances([{ id: instance.id, engine: 'claude', label: instance.label }])
  const made = makeServices(current)
  const view = await render(React.createElement(LoginDock, { services: made.services, t }))
  return { ...made, view }
}
const bar = () => byTestId('ext-login-bar')

test('sign-in notice: a chat on a signed-out provider shows it with the name of the provider', async () => {
  const instance = instanceRoute()
  site.logins[instance.id] = { signedIn: false }
  const { view } = await mountDock({ provider: instance.route, model: 'haiku' }, instance)
  assert.equal(bar().dataset.state, 'needed')
  assert.match(bar().textContent, new RegExp(instance.label))
  await view.unmount()
})

test('sign-in notice: a chat on a signed-in provider shows nothing', async () => {
  const instance = instanceRoute()
  site.logins[instance.id] = { signedIn: true }
  const { view } = await mountDock({ provider: instance.route, model: 'haiku' }, instance)
  assert.equal(bar(), null)
  assert.equal(site.loginReads.length, 1)
  await view.unmount()
})

test('sign-in notice: a chat on DeepSeek shows nothing and asks nothing', async () => {
  const { view } = await mountDock(DEEPSEEK)
  assert.equal(bar(), null)
  assert.deepEqual(site.loginReads, [])
  assert.equal(view.host.textContent, '')
  await view.unmount()
})

test('sign-in notice: with no selection it shows nothing and asks nothing', async () => {
  const { view } = await mountDock(null)
  assert.equal(bar(), null)
  assert.deepEqual(site.loginReads, [])
  await view.unmount()
})

test('sign-in notice: with no catalog service it shows nothing', async () => {
  const made = makeServices(null, { catalog: undefined })
  const view = await render(React.createElement(LoginDock, { services: made.services, t }))
  assert.equal(bar(), null)
  await view.unmount()
})

test('sign-in notice: it appears when the chat changes to a signed-out provider, and goes when it changes back', async () => {
  const instance = instanceRoute()
  site.logins[instance.id] = { signedIn: false }
  const { catalog, view } = await mountDock(DEEPSEEK, instance)
  assert.equal(bar(), null)
  await catalog.set(catalogState({ provider: instance.route, model: 'haiku' }))
  assert.equal(bar().dataset.state, 'needed')
  await catalog.set(catalogState(DEEPSEEK))
  assert.equal(bar(), null)
  await view.unmount()
})

test('sign-in notice: only the provider of the chat counts, not another signed-out provider', async () => {
  const signedOut = instanceRoute()
  const signedIn = instanceRoute()
  site.logins[signedOut.id] = { signedIn: false }
  site.logins[signedIn.id] = { signedIn: true }
  await setInstances([{ id: signedOut.id, engine: 'claude', label: signedOut.label }, { id: signedIn.id, engine: 'claude', label: signedIn.label }])
  const { view } = await mountDock({ provider: signedIn.route, model: 'haiku' })
  assert.equal(bar(), null)
  await view.unmount()
})

test('sign-in notice: a default provider is found by its route', async () => {
  site.logins.codex = { signedIn: false }
  const { view } = await mountDock(CODEX)
  assert.equal(bar().dataset.state, 'needed')
  assert.match(bar().textContent, /Codex/)
  await view.unmount()
})
