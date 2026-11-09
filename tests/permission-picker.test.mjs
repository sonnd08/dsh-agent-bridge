import test from 'node:test'
import assert from 'node:assert/strict'

const { render, click, hover, byTestId, allByTestId, t, React } = await import('./support/dom.mjs')
const { PermissionPopover } = await import('../src/client/PermissionPicker.tsx')

const OPTIONS = [
  { value: 'read-only', label: 'Read Only', description: 'Reads files.' },
  { value: 'workspace-write', label: 'Workspace Write', description: 'Edits the folder.' },
  { value: 'auto', label: 'Auto' },
  { value: 'danger-full-access', label: 'Full access', description: 'A long description of the risk.' },
]
const popover = (props = {}) => React.createElement(PermissionPopover, { options: OPTIONS, value: 'read-only', onChange: () => {}, riskValues: ['danger-full-access', 'auto'], t, ...props })
const level = value => allByTestId('ext-provider-access-level').find(item => item.dataset.value === value)
const shown = () => byTestId('ext-provider-access-detail')

test('permission popup: it opens from the chip and lists the levels in the given order', async () => {
  const view = await render(popover())
  assert.equal(byTestId('ext-provider-access-popup'), null)
  await click(byTestId('ext-provider-access-chip'))
  assert.deepEqual(allByTestId('ext-provider-access-level').map(item => item.dataset.value), OPTIONS.map(item => item.value))
  await view.unmount()
})

test('permission popup: a pointer over a level shows its text', async () => {
  const view = await render(popover())
  await click(byTestId('ext-provider-access-chip'))
  assert.match(shown().textContent, /Read Only/)
  await hover(level('danger-full-access'))
  assert.match(shown().textContent, /Full access/)
  await view.unmount()
})

test('permission popup: the page keeps the text of every level, so the height stays the same on hover', async () => {
  const view = await render(popover())
  await click(byTestId('ext-provider-access-chip'))
  const before = [...document.querySelectorAll('.accessDetail > div')]
  assert.equal(before.length, OPTIONS.length)
  await hover(level('auto'))
  const after = [...document.querySelectorAll('.accessDetail > div')]
  assert.deepEqual(after.map(item => item.textContent), before.map(item => item.textContent))
  assert.equal(after.filter(item => item.className === 'accessDetailShown').length, 1)
  await view.unmount()
})

test('permission popup: a level with no description has its own name only', async () => {
  const view = await render(popover())
  await click(byTestId('ext-provider-access-chip'))
  await hover(level('auto'))
  assert.equal(shown().textContent, 'Auto')
  await view.unmount()
})

test('permission popup: a safe level changes at once and closes the popup', async () => {
  const picked = []
  const view = await render(popover({ onChange: value => picked.push(value) }))
  await click(byTestId('ext-provider-access-chip'))
  await click(level('workspace-write'))
  assert.deepEqual(picked, ['workspace-write'])
  assert.equal(byTestId('ext-provider-access-popup'), null)
  await view.unmount()
})

test('permission popup: a risky level asks first and does not change', async () => {
  const picked = []
  const view = await render(popover({ onChange: value => picked.push(value) }))
  await click(byTestId('ext-provider-access-chip'))
  await click(level('danger-full-access'))
  assert.deepEqual(picked, [])
  assert.match(document.body.textContent, /composer\.fullTitle/)
  await view.unmount()
})

test('permission popup: the current level does nothing', async () => {
  const picked = []
  const view = await render(popover({ onChange: value => picked.push(value) }))
  await click(byTestId('ext-provider-access-chip'))
  await click(level('read-only'))
  assert.deepEqual(picked, [])
  await view.unmount()
})

test('permission popup: a locked chip does not open', async () => {
  const view = await render(popover({ locked: true }))
  assert.equal(byTestId('ext-provider-access-chip').disabled, true)
  await view.unmount()
})
