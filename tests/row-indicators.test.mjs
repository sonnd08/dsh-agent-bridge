import test from 'node:test'
import assert from 'node:assert/strict'

const { render, act, byTestId, allByTestId, t, React } = await import('./support/dom.mjs')
const { RowIndicators, publishRowIndicators } = await import('../src/client/RowIndicators.tsx')

test.afterEach(() => { document.body.replaceChildren() })

const row = sessionId => React.createElement(RowIndicators, { sessionId, t })
const publish = entries => act(() => { publishRowIndicators(new Map(Object.entries(entries))) })

test.beforeEach(() => publish({}))

test('row indicators: a row with no published state draws nothing', async () => {
  const view = await render(row('ext:claude:a'))
  assert.equal(view.host.innerHTML, '')
  await view.unmount()
})

test('row indicators: a row that is read and has no branch state draws nothing', async () => {
  await publish({ 'ext:claude:a': { unread: false, branch: 'none' } })
  const view = await render(row('ext:claude:a'))
  assert.equal(view.host.innerHTML, '')
  await view.unmount()
})

test('row indicators: an unread row shows the dot and no branch icon', async () => {
  await publish({ 'ext:claude:a': { unread: true, branch: 'none' } })
  const view = await render(row('ext:claude:a'))
  const dot = byTestId('ext-unread')
  assert.equal(dot.getAttribute('aria-label'), 'row.unread')
  assert.equal(dot.getAttribute('title'), 'row.unread')
  assert.deepEqual(['merged', 'open', 'unmerged'].map(state => byTestId(`ext-branch-${state}`)), [null, null, null])
  await view.unmount()
})

for (const [branch, label] of [['merged', 'row.merged'], ['open', 'row.prOpen'], ['unmerged', 'row.unmerged']]) {
  test(`row indicators: the ${branch} branch state has its own icon and text, with no dot on a read row`, async () => {
    await publish({ 'ext:codex:b': { unread: false, branch } })
    const view = await render(row('ext:codex:b'))
    const icon = byTestId(`ext-branch-${branch}`)
    assert.equal(icon.getAttribute('aria-label'), label)
    assert.equal(icon.getAttribute('title'), label)
    assert.equal(icon.getAttribute('role'), 'img')
    assert.equal(byTestId('ext-unread'), null)
    await view.unmount()
  })
}

test('row indicators: the three branch states draw different icons', async () => {
  const paths = []
  for (const branch of ['merged', 'open', 'unmerged']) {
    await publish({ a: { unread: false, branch } })
    const view = await render(row('a'))
    paths.push(view.host.querySelector('path').getAttribute('d'))
    await view.unmount()
  }
  assert.equal(new Set(paths).size, 3)
})

test('row indicators: a row can show the branch icon and the dot together', async () => {
  await publish({ a: { unread: true, branch: 'open' } })
  const view = await render(row('a'))
  assert.notEqual(byTestId('ext-unread'), null)
  assert.notEqual(byTestId('ext-branch-open'), null)
  await view.unmount()
})

test('row indicators: each row reads only its own state', async () => {
  await publish({ a: { unread: true, branch: 'none' }, b: { unread: false, branch: 'merged' } })
  const first = await render(row('a'))
  const second = await render(row('b'))
  const third = await render(row('c'))
  assert.notEqual(first.host.querySelector('[data-testid="ext-unread"]'), null)
  assert.equal(first.host.querySelector('[data-testid="ext-branch-merged"]'), null)
  assert.equal(second.host.querySelector('[data-testid="ext-unread"]'), null)
  assert.notEqual(second.host.querySelector('[data-testid="ext-branch-merged"]'), null)
  assert.equal(third.host.innerHTML, '')
  await third.unmount()
  await second.unmount()
  await first.unmount()
})

test('row indicators: a new published list updates a row on screen', async () => {
  const view = await render(row('a'))
  assert.equal(allByTestId('ext-unread').length, 0)
  await publish({ a: { unread: true, branch: 'unmerged' } })
  assert.equal(allByTestId('ext-unread').length, 1)
  assert.notEqual(byTestId('ext-branch-unmerged'), null)
  await publish({ a: { unread: false, branch: 'merged' } })
  assert.equal(allByTestId('ext-unread').length, 0, 'opening the row clears the dot')
  assert.equal(byTestId('ext-branch-unmerged'), null)
  assert.notEqual(byTestId('ext-branch-merged'), null)
  await publish({})
  assert.equal(view.host.innerHTML, '', 'a row that left the list loses its indicators')
  await view.unmount()
})

test('row indicators: a row that gets another session id shows the state of that session', async () => {
  await publish({ a: { unread: true, branch: 'none' }, b: { unread: false, branch: 'open' } })
  const view = await render(row('a'))
  assert.notEqual(byTestId('ext-unread'), null)
  await view.update(row('b'))
  assert.equal(byTestId('ext-unread'), null)
  assert.notEqual(byTestId('ext-branch-open'), null)
  await view.unmount()
})

test('row indicators: a list published after a row is gone is harmless', async () => {
  const view = await render(row('a'))
  await view.unmount()
  await publish({ a: { unread: true, branch: 'open' } })
  assert.equal(byTestId('ext-unread'), null)
})
