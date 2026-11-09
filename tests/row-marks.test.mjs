import test from 'node:test'
import assert from 'node:assert/strict'

const { render, act, React } = await import('./support/dom.mjs')
const { connectRowMarks, EngineMark, graftWorkspaceBrowser } = await import('../src/client/graft.tsx')

/** A stand-in for the DSH session list: `set` publishes a new list. */
function fakeList(initial = {}) {
  let byId = initial
  const listeners = new Set()
  return {
    getSnapshot: () => ({ byId }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next) { byId = next; for (const listener of listeners) listener() },
    listeners,
  }
}
const selecting = provider => ({ projectionValues: { modelSelection: { next: { provider } } } })
const mark = sessionId => React.createElement(EngineMark, { sessionId })
const engineIn = view => view.host.querySelector('span').dataset.engine

let disconnect
function connect(list) {
  disconnect = connectRowMarks(list)
}
test.afterEach(async () => {
  if (disconnect !== undefined) await act(() => { disconnect() })
  disconnect = undefined
})

test('row mark: a chat shows the DeepSeek mark until a session list is connected', async () => {
  const view = await render(mark('session-1'))
  assert.equal(engineIn(view), 'dsh')
  await view.unmount()
})

for (const [id, engine] of [['ext:claude:a', 'claude'], ['ext:codex:b', 'codex'], ['ext:pi:c', 'pi'], ['ext:claude:@work:d', 'claude'], ['ext:plain', 'external'], ['ext::leading', 'external']]) {
  test(`row mark: the external row ${id} shows the ${engine} mark`, async () => {
    const view = await render(mark(id))
    assert.equal(engineIn(view), engine)
    await view.unmount()
  })
}

for (const [route, engine] of [['claude-code', 'claude'], ['codex-cli', 'codex'], ['claude@work', 'claude'], ['codex@work', 'codex'], ['deepseek', 'dsh'], ['claude-code-extra', 'dsh'], ['codex', 'dsh'], ['', 'dsh']]) {
  test(`row mark: a chat on the route "${route}" shows the ${engine} mark`, async () => {
    connect(fakeList({ 'session-1': selecting(route) }))
    const view = await render(mark('session-1'))
    assert.equal(engineIn(view), engine)
    await view.unmount()
  })
}

for (const [name, summary] of [['a chat with no selected model', { projectionValues: { modelSelection: { next: null } } }], ['a chat with no selection value', { projectionValues: {} }], ['a chat with no projection values', {}], ['a chat that is not in the list', undefined]]) {
  test(`row mark: ${name} shows the DeepSeek mark`, async () => {
    connect(fakeList(summary === undefined ? {} : { 'session-1': summary }))
    const view = await render(mark('session-1'))
    assert.equal(engineIn(view), 'dsh')
    await view.unmount()
  })
}

test('row mark: an external row keeps the mark of its engine whatever the list says', async () => {
  connect(fakeList({ 'ext:claude:a': selecting('codex-cli') }))
  const view = await render(mark('ext:claude:a'))
  assert.equal(engineIn(view), 'claude')
  await view.unmount()
})

test('row mark: each row follows the model of its own chat', async () => {
  connect(fakeList({ one: selecting('claude-code'), two: selecting('codex-cli'), three: selecting('deepseek') }))
  const views = []
  for (const id of ['one', 'two', 'three']) views.push(await render(mark(id)))
  assert.deepEqual(views.map(engineIn), ['claude', 'codex', 'dsh'])
  for (const view of views) await view.unmount()
})

test('row mark: a model change in the list changes the icon at once', async () => {
  const list = fakeList({ 'session-1': selecting('codex-cli') })
  connect(list)
  const view = await render(mark('session-1'))
  assert.equal(engineIn(view), 'codex')
  await act(() => { list.set({ 'session-1': selecting('claude-code') }) })
  assert.equal(engineIn(view), 'claude')
  await act(() => { list.set({ 'session-1': selecting('deepseek') }) })
  assert.equal(engineIn(view), 'dsh')
  await view.unmount()
})

test('row mark: a chat that leaves the list goes back to the DeepSeek mark', async () => {
  const list = fakeList({ 'session-1': selecting('claude-code') })
  connect(list)
  const view = await render(mark('session-1'))
  await act(() => { list.set({}) })
  assert.equal(engineIn(view), 'dsh')
  await view.unmount()
})

test('row mark: a list change of another chat leaves the row as it is', async () => {
  const list = fakeList({ one: selecting('claude-code'), two: selecting('codex-cli') })
  connect(list)
  const view = await render(mark('one'))
  await act(() => { list.set({ one: selecting('claude-code'), two: selecting('deepseek') }) })
  assert.equal(engineIn(view), 'claude')
  await view.unmount()
})

test('row mark: a row on screen updates when the list connects', async () => {
  const view = await render(mark('session-1'))
  assert.equal(engineIn(view), 'dsh')
  await act(() => { connect(fakeList({ 'session-1': selecting('claude-code') })) })
  assert.equal(engineIn(view), 'claude')
  await view.unmount()
})

test('row mark: a row that gets another chat id shows the mark of that chat', async () => {
  connect(fakeList({ one: selecting('claude-code'), two: selecting('codex-cli') }))
  const view = await render(mark('one'))
  await view.update(mark('two'))
  assert.equal(engineIn(view), 'codex')
  await view.unmount()
})

test('row mark: disconnect returns the rows to the DeepSeek mark and stops listening', async () => {
  const list = fakeList({ 'session-1': selecting('claude-code') })
  connect(list)
  const view = await render(mark('session-1'))
  assert.equal(list.listeners.size, 1)
  await act(() => { disconnect() })
  disconnect = undefined
  assert.equal(list.listeners.size, 0)
  assert.equal(engineIn(view), 'dsh')
  await act(() => { list.set({ 'session-1': selecting('codex-cli') }) })
  assert.equal(engineIn(view), 'dsh', 'a list that is gone changes nothing')
  await view.unmount()
})

test('row mark: a later connection replaces the list after the first one is disconnected', async () => {
  const first = fakeList({ 'session-1': selecting('claude-code') })
  const second = fakeList({ 'session-1': selecting('codex-cli') })
  connect(first)
  const view = await render(mark('session-1'))
  await act(() => { disconnect() })
  await act(() => { connect(second) })
  assert.equal(engineIn(view), 'codex')
  await view.unmount()
})

test('row mark: a row gone from the page does not hold on to the list', async () => {
  const list = fakeList({ 'session-1': selecting('claude-code') })
  connect(list)
  const view = await render(mark('session-1'))
  await view.unmount()
  await act(() => { list.set({ 'session-1': selecting('codex-cli') }) })
  const again = await render(mark('session-1'))
  assert.equal(engineIn(again), 'codex')
  await again.unmount()
})

test('row mark: the mark is hidden from screen readers', async () => {
  const view = await render(mark('session-1'))
  assert.equal(view.host.querySelector('span').getAttribute('aria-hidden'), 'true')
  await view.unmount()
})

test('row mark: the graft leaves the mark as it is, so external rows keep it', () => {
  const entry = { component: EngineMark, options: { id: 'engine-mark' } }
  const browser = { component: () => null, children: { 'sidebar.workspaces.session.row.action': {} } }
  const slots = {
    entries: key => ({ 'sidebar.workspaces': [browser], 'sidebar.session.row.leading': [entry] })[key] ?? [],
    subscribe: () => () => {},
  }
  const source = { snapshot: { getSnapshot: () => ({ rows: [] }), subscribe: () => () => {} }, open() {}, pin() {}, archive() {}, rename: async () => {}, panelId: 'invented-panel' }
  const undo = graftWorkspaceBrowser(slots, source)
  assert.equal(entry.component, EngineMark)
  undo()
})

test('row marks: disconnecting an old list does not clear the new one', async () => {
  const oldList = fakeList()
  const newList = fakeList({ 'native-a': selecting('codex-cli') })
  const disconnectOld = connectRowMarks(oldList)
  connect(newList)
  const view = await render(mark('native-a'))
  await act(() => { disconnectOld() })
  assert.equal(engineIn(view), 'codex')
  await view.unmount()
})
