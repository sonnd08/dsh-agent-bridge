import test from 'node:test'
import assert from 'node:assert/strict'

const { render, click, hover, byTestId, allByTestId, t, act, React } = await import('./support/dom.mjs')
const { ProviderPicker } = await import('../src/client/ProviderPicker.tsx')

// The picker remembers its rail in browser storage. The page of the unit tests has one, but Node does not expose it as a global.
Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true, writable: true })
const RAIL_KEY = 'agent-bridge:selector-rail'

const LEVELS = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }]
const GROUPS = [
  { engine: 'dsh', label: 'DeepSeek', models: [{ id: 'one/flash', name: 'Flash', efforts: [] }, { id: 'one/pro', name: 'Pro Max', efforts: LEVELS.slice(0, 2) }] },
  { engine: 'claude', label: 'Claude Code', models: [{ id: 'sonnet', name: 'Sonnet', description: 'Balanced', efforts: LEVELS }, { id: 'opus', name: 'Opus', efforts: LEVELS }] },
  { engine: 'codex@spare', label: 'Spare', accent: '#654321', models: [{ id: 'gpt-test', name: 'GPT Test', efforts: LEVELS }] },
]
const CURRENT = { engine: 'claude', modelId: 'sonnet', effort: 'high' }

const picker = (props = {}) => React.createElement(ProviderPicker, { groups: GROUPS, current: CURRENT, label: 'Sonnet', effortLabel: 'High', favorites: [], onToggleFavorite: () => {}, onPick: () => {}, t, ...props })

test.beforeEach(() => { window.localStorage.clear() })

const trigger = () => byTestId('ext-provider-trigger')
const panel = () => byTestId('ext-provider-panel')
const rail = engine => byTestId(`ext-provider-rail-${engine}`)
const models = () => allByTestId('ext-provider-model').map(item => item.dataset.model)
const model = id => allByTestId('ext-provider-model').find(item => item.dataset.model === id)
const efforts = () => allByTestId('ext-provider-effort').map(item => item.dataset.effort)
const effort = id => allByTestId('ext-provider-effort').find(item => item.dataset.effort === id)
const effortMarked = id => effort(id).querySelector('svg') !== null
const rowStar = id => model(id).parentElement.querySelector('[aria-pressed]')
const key = (name, init = {}) => act(() => { document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })) })
const pointerDown = target => act(() => { target.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })) })
const search = text => act(() => {
  const input = byTestId('ext-provider-search')
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
})

async function opened(props) {
  const view = await render(picker(props))
  await click(trigger())
  return view
}

test('picker trigger: it shows the model, the level and the provider, and starts closed', async () => {
  const view = await render(picker())
  assert.match(trigger().textContent, /Sonnet/)
  assert.match(trigger().textContent, /High/)
  assert.equal(trigger().dataset.engineSelected, 'claude')
  assert.equal(trigger().getAttribute('aria-expanded'), 'false')
  assert.equal(panel(), null)
  await view.unmount()
})

test('picker trigger: an empty level shows no level text', async () => {
  const view = await render(picker({ effortLabel: '' }))
  assert.equal(trigger().querySelector('.triggerEffort'), null)
  await view.unmount()
})

test('picker trigger: a click opens the panel and a second click closes it', async () => {
  const view = await render(picker())
  await click(trigger())
  assert.notEqual(panel(), null)
  assert.equal(trigger().getAttribute('aria-expanded'), 'true')
  assert.equal(document.activeElement, byTestId('ext-provider-search'))
  await click(trigger())
  assert.equal(panel(), null)
  await view.unmount()
})

test('picker trigger: a locked selector is disabled and does not open', async () => {
  const view = await render(picker({ locked: true }))
  assert.equal(trigger().disabled, true)
  await click(trigger())
  assert.equal(panel(), null)
  await view.unmount()
})

test('picker trigger: the access chip shows beside the selector, also when the panel is closed', async () => {
  const view = await render(picker({ accessChip: React.createElement('span', { 'data-testid': 'chip' }, 'Access') }))
  assert.notEqual(byTestId('chip'), null)
  assert.equal(panel(), null)
  await view.unmount()
})

test('picker rails: Favorites comes first, then one rail per provider with its name', async () => {
  const view = await opened()
  const rails = [...panel().querySelectorAll('nav button')]
  assert.deepEqual(rails.map(item => item.dataset.testid), ['ext-provider-rail-favorites', 'ext-provider-rail-dsh', 'ext-provider-rail-claude', 'ext-provider-rail-codex@spare'])
  assert.equal(rail('claude').title, 'Claude Code')
  assert.equal(rail('claude').getAttribute('aria-label'), 'Claude Code')
  await view.unmount()
})

test('picker rails: an instance shows the mark of its engine and its accent color', async () => {
  const view = await opened()
  assert.equal(rail('codex@spare').querySelector('.mark').dataset.engine, 'codex')
  assert.notEqual(rail('codex@spare').querySelector('.accentDot').style.background, '')
  assert.equal(rail('claude').querySelector('.accentDot'), null)
  await view.unmount()
})

test('picker rails: it opens on the provider in use', async () => {
  const view = await opened()
  assert.equal(rail('claude').className, 'railActive')
  assert.deepEqual(models(), ['sonnet', 'opus'])
  await view.unmount()
})

test('picker rails: a click shows the models of that provider only', async () => {
  const view = await opened()
  await click(rail('dsh'))
  assert.deepEqual(models(), ['one/flash', 'one/pro'])
  assert.equal(rail('dsh').className, 'railActive')
  await view.unmount()
})

test('picker rails: it opens on the rail that the user chose last', async () => {
  const view = await opened()
  await click(rail('codex@spare'))
  assert.equal(window.localStorage.getItem(RAIL_KEY), 'codex@spare')
  await click(trigger())
  await click(trigger())
  assert.deepEqual(models(), ['gpt-test'])
  await view.unmount()
})

test('picker rails: it can open on Favorites', async () => {
  window.localStorage.setItem(RAIL_KEY, 'favorites')
  const view = await opened({ favorites: ['dsh/one/flash'] })
  assert.equal(rail('favorites').className, 'railActive')
  assert.deepEqual(models(), ['one/flash'])
  await view.unmount()
})

test('picker rails: a remembered provider that is gone opens the provider in use', async () => {
  window.localStorage.setItem(RAIL_KEY, 'claude@removed')
  const view = await opened()
  assert.deepEqual(models(), ['sonnet', 'opus'])
  await view.unmount()
})

test('picker rails: with no browser storage it still opens and the rails still change', async () => {
  const stored = globalThis.localStorage
  const broken = { getItem() { throw new Error('storage is off') }, setItem() { throw new Error('storage is off') } }
  Object.defineProperty(globalThis, 'localStorage', { value: broken, configurable: true, writable: true })
  try {
    const view = await opened()
    assert.deepEqual(models(), ['sonnet', 'opus'])
    await click(rail('dsh'))
    assert.deepEqual(models(), ['one/flash', 'one/pro'])
    await view.unmount()
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: stored, configurable: true, writable: true })
  }
})

test('picker models: a click picks the model with no level and closes the panel', async () => {
  const picked = []
  const view = await opened({ onPick: (...args) => picked.push(args) })
  await click(model('opus'))
  assert.deepEqual(picked, [['claude', 'opus', undefined]])
  assert.equal(panel(), null)
  await view.unmount()
})

test('picker models: the row of the model in use has a check mark, and the others have none', async () => {
  const view = await opened()
  assert.notEqual(model('sonnet').querySelector('svg'), null)
  assert.equal(model('opus').querySelector('svg'), null)
  await view.unmount()
})

test('picker models: a row shows the description as its title', async () => {
  const view = await opened()
  assert.equal(model('sonnet').title, 'Balanced')
  await view.unmount()
})

test('picker models: only the first 9 rows have a shortcut', async () => {
  const many = Array.from({ length: 11 }, (_item, index) => ({ id: `m${String(index)}`, name: `Model ${String(index)}`, efforts: [] }))
  const view = await opened({ groups: [{ engine: 'claude', label: 'Claude Code', models: many }] })
  assert.deepEqual([...document.querySelectorAll('kbd')].map(item => item.textContent), ['⌘1', '⌘2', '⌘3', '⌘4', '⌘5', '⌘6', '⌘7', '⌘8', '⌘9'])
  await view.unmount()
})

test('picker models: a search matches the name, ignores case and spaces, and stays in the rail', async () => {
  const view = await opened()
  await click(rail('dsh'))
  await search('  PRO ')
  assert.deepEqual(models(), ['one/pro'])
  await view.unmount()
})

test('picker models: a search with no match says so', async () => {
  const view = await opened()
  await search('nothing like this')
  assert.deepEqual(models(), [])
  assert.match(panel().textContent, /picker\.empty/)
  await view.unmount()
})

test('picker models: the search is empty after the panel closes', async () => {
  const view = await opened()
  await search('opus')
  await click(trigger())
  await click(trigger())
  assert.equal(byTestId('ext-provider-search').value, '')
  assert.deepEqual(models(), ['sonnet', 'opus'])
  await view.unmount()
})

test('picker models: an empty provider shows its status while it loads', async () => {
  const groups = [{ engine: 'claude', label: 'Claude Code', models: [], status: 'Loading the list' }]
  const view = await opened({ groups })
  assert.match(panel().textContent, /Loading the list/)
  assert.doesNotMatch(panel().textContent, /picker\.empty/)
  await view.unmount()
})

test('picker models: an empty provider with no status says that it is empty', async () => {
  const view = await opened({ groups: [{ engine: 'claude', label: 'Claude Code', models: [] }] })
  assert.match(panel().textContent, /picker\.empty/)
  await view.unmount()
})

test('picker keys: Escape closes the panel and picks nothing', async () => {
  const picked = []
  const view = await opened({ onPick: (...args) => picked.push(args) })
  await key('Escape')
  assert.equal(panel(), null)
  assert.deepEqual(picked, [])
  await view.unmount()
})

for (const modifier of ['metaKey', 'ctrlKey']) {
  test(`picker keys: ${modifier} with a digit picks that row`, async () => {
    const picked = []
    const view = await opened({ onPick: (...args) => picked.push(args) })
    await key('2', { [modifier]: true })
    assert.deepEqual(picked, [['claude', 'opus', undefined]])
    assert.equal(panel(), null)
    await view.unmount()
  })
}

test('picker keys: a digit counts the rows that the search leaves', async () => {
  const picked = []
  const view = await opened({ onPick: (...args) => picked.push(args) })
  await search('opus')
  await key('1', { metaKey: true })
  assert.deepEqual(picked, [['claude', 'opus', undefined]])
  await view.unmount()
})

test('picker keys: a digit with no modifier does not pick', async () => {
  const picked = []
  const view = await opened({ onPick: (...args) => picked.push(args) })
  await key('1')
  assert.deepEqual(picked, [])
  assert.notEqual(panel(), null)
  await view.unmount()
})

test('picker keys: a digit past the last row, and the digit 0, do not pick', async () => {
  const picked = []
  const view = await opened({ onPick: (...args) => picked.push(args) })
  await key('9', { metaKey: true })
  await key('0', { metaKey: true })
  assert.deepEqual(picked, [])
  assert.notEqual(panel(), null)
  await view.unmount()
})

test('picker keys: the keys do nothing while the panel is closed', async () => {
  const picked = []
  const view = await render(picker({ onPick: (...args) => picked.push(args) }))
  await key('1', { metaKey: true })
  assert.deepEqual(picked, [])
  await view.unmount()
})

test('picker pointer: a press outside closes the panel', async () => {
  const view = await opened()
  await pointerDown(document.body)
  assert.equal(panel(), null)
  await view.unmount()
})

test('picker pointer: a press inside the panel keeps it open', async () => {
  const view = await opened()
  await pointerDown(byTestId('ext-provider-search'))
  assert.notEqual(panel(), null)
  await view.unmount()
})

for (const role of ['menu', 'dialog', 'alertdialog']) {
  test(`picker pointer: a press in a popup with role ${role} keeps the panel open`, async () => {
    const view = await opened()
    const popup = document.createElement('div')
    popup.setAttribute('role', role)
    document.body.append(popup)
    await pointerDown(popup)
    assert.notEqual(panel(), null)
    popup.remove()
    await view.unmount()
  })
}

test('picker favorites: the rail lists the favorites of all providers in the saved order', async () => {
  const view = await opened({ favorites: ['codex@spare/gpt-test', 'dsh/one/flash', 'claude/opus'] })
  await click(rail('favorites'))
  assert.deepEqual(models(), ['gpt-test', 'one/flash', 'opus'])
  await view.unmount()
})

test('picker favorites: a favorite whose model is gone is not listed', async () => {
  const view = await opened({ favorites: ['claude/removed', 'claude/opus'] })
  await click(rail('favorites'))
  assert.deepEqual(models(), ['opus'])
  await view.unmount()
})

test('picker favorites: with no favorites the rail says so', async () => {
  const view = await opened()
  await click(rail('favorites'))
  assert.match(panel().textContent, /picker\.noFavorites/)
  await view.unmount()
})

test('picker favorites: a loading status of a provider does not replace the Favorites text', async () => {
  const groups = [{ engine: 'claude', label: 'Claude Code', models: [], status: 'Loading the list' }]
  const view = await opened({ groups })
  await click(rail('favorites'))
  assert.match(panel().textContent, /picker\.noFavorites/)
  assert.doesNotMatch(panel().textContent, /Loading the list/)
  await view.unmount()
})

test('picker favorites: the star reports the row key and keeps the panel open', async () => {
  const toggled = []
  const picked = []
  const view = await opened({ onToggleFavorite: value => toggled.push(value), onPick: (...args) => picked.push(args) })
  await click(rowStar('opus'))
  assert.deepEqual(toggled, ['claude/opus'])
  assert.deepEqual(picked, [])
  assert.notEqual(panel(), null)
  await view.unmount()
})

test('picker favorites: the star shows whether the row is a favorite', async () => {
  const view = await opened({ favorites: ['claude/opus'] })
  assert.equal(rowStar('opus').getAttribute('aria-pressed'), 'true')
  assert.equal(rowStar('opus').className, 'starOn')
  assert.equal(rowStar('sonnet').getAttribute('aria-pressed'), 'false')
  await view.unmount()
})

test('picker favorites: a pick from the rail names the provider of the row', async () => {
  const picked = []
  const view = await opened({ favorites: ['dsh/one/flash'], onPick: (...args) => picked.push(args) })
  await click(rail('favorites'))
  await click(model('one/flash'))
  assert.deepEqual(picked, [['dsh', 'one/flash', undefined]])
  await view.unmount()
})

test('picker reasoning: the column shows the levels of the model in use, with its name', async () => {
  const view = await opened()
  assert.deepEqual(efforts(), ['low', 'medium', 'high'])
  assert.match(panel().querySelector('.effortsHeader').textContent, /picker\.reasoning.*Sonnet/)
  await view.unmount()
})

test('picker reasoning: the level in use is marked and Medium is named the default', async () => {
  const view = await opened()
  assert.equal(effortMarked('high'), true)
  assert.equal(effortMarked('low'), false)
  assert.match(effort('medium').textContent, /picker\.default/)
  assert.doesNotMatch(effort('high').textContent, /picker\.default/)
  await view.unmount()
})

test('picker reasoning: the column follows the row under the pointer, and returns when it leaves', async () => {
  const view = await opened({ groups: [GROUPS[0]], current: { engine: 'dsh', modelId: 'one/flash', effort: '' } })
  assert.deepEqual(efforts(), [])
  await hover(model('one/pro'))
  assert.deepEqual(efforts(), ['low', 'medium'])
  await act(() => { panel().querySelector('ul').dispatchEvent(new window.MouseEvent('pointerout', { bubbles: true })) })
  assert.deepEqual(efforts(), [])
  await view.unmount()
})

test('picker reasoning: a row under the pointer marks its saved level', async () => {
  const view = await opened({ savedEfforts: { 'claude/opus': 'low' } })
  await hover(model('opus'))
  assert.equal(effortMarked('low'), true)
  assert.equal(effortMarked('high'), false)
  await view.unmount()
})

test('picker reasoning: a row under the pointer with no saved level marks none', async () => {
  const view = await opened()
  await hover(model('opus'))
  assert.deepEqual(['low', 'medium', 'high'].map(effortMarked), [false, false, false])
  await view.unmount()
})

test('picker reasoning: the selected row uses its current level, not its saved level', async () => {
  const view = await opened({ savedEfforts: { 'claude/sonnet': 'low' } })
  assert.equal(effortMarked('high'), true)
  assert.equal(effortMarked('low'), false)
  await view.unmount()
})

test('picker reasoning: a level picks that model with that level and closes the panel', async () => {
  const picked = []
  const view = await opened({ onPick: (...args) => picked.push(args) })
  await hover(model('opus'))
  await click(effort('low'))
  assert.deepEqual(picked, [['claude', 'opus', 'low']])
  assert.equal(panel(), null)
  await view.unmount()
})

test('picker reasoning: a model with no levels says so', async () => {
  const view = await opened()
  await click(rail('dsh'))
  assert.match(panel().querySelector('.efforts').textContent, /picker\.noReasoning/)
  await view.unmount()
})

test('picker reasoning: an empty rail shows no levels and no note', async () => {
  const view = await opened({ groups: [{ engine: 'claude', label: 'Claude Code', models: [] }] })
  assert.deepEqual(efforts(), [])
  assert.doesNotMatch(panel().querySelector('.efforts').textContent, /picker\.noReasoning/)
  await view.unmount()
})

test('picker settings: the gear closes the panel and opens the settings', async () => {
  let opens = 0
  const view = await opened({ onOpenSettings: () => { opens += 1 } })
  assert.equal(byTestId('ext-provider-settings').getAttribute('aria-label'), 'picker.settings')
  await click(byTestId('ext-provider-settings'))
  assert.equal(opens, 1)
  assert.equal(panel(), null)
  await view.unmount()
})

test('picker settings: with no settings page there is no gear and no footer', async () => {
  const view = await opened()
  assert.equal(byTestId('ext-provider-settings'), null)
  assert.equal(panel().querySelector('footer'), null)
  await view.unmount()
})

test('picker footer: the access control shows when it is given', async () => {
  const view = await opened({ access: React.createElement('span', null, 'Level') })
  assert.match(byTestId('ext-provider-access').textContent, /Level/)
  await view.unmount()
})

test('picker footer: Standard and Fast report the choice and keep the panel open', async () => {
  const chosen = []
  const view = await opened({ speed: { available: true, fast: false, onChange: value => chosen.push(value) } })
  assert.equal(byTestId('ext-provider-standard').getAttribute('aria-pressed'), 'true')
  assert.equal(byTestId('ext-provider-fast').getAttribute('aria-pressed'), 'false')
  await click(byTestId('ext-provider-fast'))
  await click(byTestId('ext-provider-standard'))
  assert.deepEqual(chosen, [true, false])
  assert.notEqual(panel(), null)
  await view.unmount()
})

test('picker footer: Fast is disabled for a model without it', async () => {
  const chosen = []
  const view = await opened({ speed: { available: false, fast: false, onChange: value => chosen.push(value) } })
  assert.equal(byTestId('ext-provider-fast').disabled, true)
  await click(byTestId('ext-provider-fast'))
  assert.deepEqual(chosen, [])
  await view.unmount()
})

test('picker footer: the trigger has the Fast mark only when Fast is on', async () => {
  const off = await render(picker({ speed: { available: true, fast: false, onChange: () => {} } }))
  assert.equal(byTestId('ext-provider-fast-on'), null)
  await off.unmount()
  const on = await render(picker({ speed: { available: true, fast: true, onChange: () => {} } }))
  assert.notEqual(byTestId('ext-provider-fast-on'), null)
  await on.unmount()
})
