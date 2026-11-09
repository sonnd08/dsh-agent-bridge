import test from 'node:test'
import assert from 'node:assert/strict'

const { render, click, act, byTestId, t, React } = await import('./support/dom.mjs')
const { PermissionPicker, bridgeAccessOptions } = await import('../src/client/PermissionPicker.tsx')

test.afterEach(() => { document.body.replaceChildren() })

const picker = (props = {}) => React.createElement(PermissionPicker, { value: '', onChange: () => {}, t, ...props })
const trigger = () => byTestId('ext-permission-trigger')
const rows = () => [...document.querySelectorAll('[role="menuitem"]')]
const rowNamed = label => rows().find(item => item.textContent.includes(label))
const buttonNamed = label => [...document.querySelectorAll('button')].find(item => item.textContent === label)
const checkbox = () => document.querySelector('input[type="checkbox"]')
const dialogShown = title => document.body.textContent.includes(title)

/** Open the menu and pick the row with this label. */
async function pick(label) {
  await click(trigger())
  await click(rowNamed(label))
}

test('bridge access options: the four levels in order, the first means the plugin settings', () => {
  const options = bridgeAccessOptions(t)
  assert.deepEqual(options.map(option => option.value), ['', 'readOnly', 'workspaceWrite', 'fullAccess'])
  assert.deepEqual(options.map(option => option.label), ['composer.permissionDefault', 'composer.permissionReadOnly', 'composer.permissionWorkspace', 'composer.permissionFull'])
  assert.deepEqual(options.map(option => option.description), ['picker.accessDefault', 'picker.accessReadOnly', 'picker.accessWorkspace', 'picker.accessFull'])
})

test('bridge access options: every level has an icon, so the row never starts with a letter', () => {
  for (const option of bridgeAccessOptions(t)) assert.ok(React.isValidElement(option.icon), option.value)
})

test('permission menu: the trigger names the current level and the menu stays closed', async () => {
  const view = await render(picker({ value: 'workspaceWrite' }))
  assert.equal(trigger().dataset.value, 'workspaceWrite')
  assert.match(trigger().textContent, /composer\.permissionWorkspace/)
  assert.equal(trigger().getAttribute('aria-label'), 'composer.permissionMode {"name":"composer.permissionWorkspace"}')
  assert.equal(rows().length, 0)
  await view.unmount()
})

test('permission menu: the trigger opens and closes the list of levels', async () => {
  const view = await render(picker())
  await click(trigger())
  assert.deepEqual(rows().map(item => item.textContent), ['composer.permissionDefault', 'composer.permissionReadOnly', 'composer.permissionWorkspace', 'composer.permissionFull'])
  await click(trigger())
  assert.equal(rows().length, 0)
  await view.unmount()
})

test('permission menu: the current level is the one marked in the list', async () => {
  const view = await render(picker({ value: 'workspaceWrite' }))
  await click(trigger())
  assert.deepEqual(rows().filter(item => item.classList.contains('selected')).map(item => item.textContent), ['composer.permissionWorkspace'])
  await view.unmount()
})

test('permission menu: the empty value marks the plugin settings row', async () => {
  const view = await render(picker({ value: '' }))
  await click(trigger())
  assert.deepEqual(rows().filter(item => item.classList.contains('selected')).map(item => item.textContent), ['composer.permissionDefault'])
  await view.unmount()
})

test('permission menu: a safe level applies at once and closes the list', async () => {
  const picked = []
  const view = await render(picker({ onChange: value => picked.push(value) }))
  await pick('composer.permissionReadOnly')
  assert.deepEqual(picked, ['readOnly'])
  assert.equal(rows().length, 0)
  assert.equal(dialogShown('composer.fullTitle'), false)
  await view.unmount()
})

test('permission menu: the plugin settings row sends the empty value', async () => {
  const picked = []
  const view = await render(picker({ value: 'readOnly', onChange: value => picked.push(value) }))
  await pick('composer.permissionDefault')
  assert.deepEqual(picked, [''])
  await view.unmount()
})

test('permission menu: picking the current level closes the list and changes nothing', async () => {
  const picked = []
  const view = await render(picker({ value: 'readOnly', onChange: value => picked.push(value) }))
  await pick('composer.permissionReadOnly')
  assert.deepEqual(picked, [])
  assert.equal(rows().length, 0)
  await view.unmount()
})

test('permission menu: picking the current risky level asks nothing', async () => {
  const picked = []
  const view = await render(picker({ value: 'fullAccess', onChange: value => picked.push(value) }))
  await pick('composer.permissionFull')
  assert.deepEqual(picked, [])
  assert.equal(dialogShown('composer.fullTitle'), false)
  await view.unmount()
})

test('permission menu: full access asks first and does not change the level', async () => {
  const picked = []
  const view = await render(picker({ onChange: value => picked.push(value) }))
  await pick('composer.permissionFull')
  assert.deepEqual(picked, [])
  assert.equal(dialogShown('composer.fullTitle'), true)
  assert.equal(dialogShown('composer.fullDescription'), true)
  assert.equal(trigger().dataset.value, '')
  await view.unmount()
})

test('permission menu: the risk dialog cannot be confirmed before it is acknowledged', async () => {
  const picked = []
  const view = await render(picker({ onChange: value => picked.push(value) }))
  await pick('composer.permissionFull')
  assert.equal(buttonNamed('composer.fullEnable').disabled, true)
  await click(buttonNamed('composer.fullEnable'))
  assert.deepEqual(picked, [])
  await view.unmount()
})

test('permission menu: acknowledge and confirm applies the level once and closes the dialog', async () => {
  const picked = []
  const view = await render(picker({ onChange: value => picked.push(value) }))
  await pick('composer.permissionFull')
  await click(checkbox())
  assert.equal(buttonNamed('composer.fullEnable').disabled, false)
  await click(buttonNamed('composer.fullEnable'))
  assert.deepEqual(picked, ['fullAccess'])
  assert.equal(dialogShown('composer.fullTitle'), false)
  await view.unmount()
})

test('permission menu: cancel keeps the level, also after an acknowledgement', async () => {
  const picked = []
  const view = await render(picker({ onChange: value => picked.push(value) }))
  await pick('composer.permissionFull')
  await click(checkbox())
  await click(buttonNamed('composer.fullCancel'))
  assert.deepEqual(picked, [])
  assert.equal(dialogShown('composer.fullTitle'), false)
  await view.unmount()
})

test('permission menu: the close button of the dialog works as cancel', async () => {
  const picked = []
  const view = await render(picker({ onChange: value => picked.push(value) }))
  await pick('composer.permissionFull')
  await click(document.querySelector('button[aria-label="composer.fullClose"]'))
  assert.deepEqual(picked, [])
  assert.equal(dialogShown('composer.fullTitle'), false)
  await view.unmount()
})

test('permission menu: an acknowledgement does not carry over to the next time the dialog opens', async () => {
  const view = await render(picker())
  await pick('composer.permissionFull')
  await click(checkbox())
  assert.equal(checkbox().checked, true)
  await click(buttonNamed('composer.fullCancel'))
  await pick('composer.permissionFull')
  assert.equal(checkbox().checked, false)
  assert.equal(buttonNamed('composer.fullEnable').disabled, true)
  await view.unmount()
})

test('permission menu: a risky level that is not full access names itself in the dialog', async () => {
  const picked = []
  const options = [{ value: 'read', label: 'Read' }, { value: 'wide', label: 'Wide', description: 'Reaches other folders.' }]
  const view = await render(picker({ value: 'read', options, riskValues: ['wide'], onChange: value => picked.push(value) }))
  await pick('Wide')
  assert.equal(dialogShown('picker.riskTitle {"name":"Wide"}'), true)
  assert.equal(dialogShown('Reaches other folders.'), true)
  assert.equal(dialogShown('composer.fullTitle'), false)
  await click(checkbox())
  await click(buttonNamed('picker.riskEnable'))
  assert.deepEqual(picked, ['wide'])
  await view.unmount()
})

test('permission menu: the engine full access value uses the full access text', async () => {
  const options = [{ value: 'read', label: 'Read' }, { value: 'danger-full-access', label: 'Danger' }]
  const view = await render(picker({ value: 'read', options, riskValues: ['danger-full-access'] }))
  await pick('Danger')
  assert.equal(dialogShown('composer.fullTitle'), true)
  assert.equal(dialogShown('composer.fullDescription'), true)
  await view.unmount()
})

test('permission menu: a level outside riskValues applies at once, even if it is full access', async () => {
  const picked = []
  const view = await render(picker({ riskValues: [], onChange: value => picked.push(value) }))
  await pick('composer.permissionFull')
  assert.deepEqual(picked, ['fullAccess'])
  assert.equal(dialogShown('composer.fullTitle'), false)
  await view.unmount()
})

test('permission menu: a value that is not a level shows the first level', async () => {
  const view = await render(picker({ value: 'retired-level' }))
  assert.match(trigger().textContent, /composer\.permissionDefault/)
  assert.equal(trigger().dataset.value, 'retired-level')
  await view.unmount()
})

test('permission menu: with no levels the trigger shows the raw value', async () => {
  const view = await render(picker({ value: 'raw-level', options: [] }))
  assert.match(trigger().textContent, /raw-level/)
  await click(trigger())
  assert.equal(rows().length, 0)
  await view.unmount()
})

test('permission menu: a level without an icon draws no icon in the trigger', async () => {
  const view = await render(picker({ value: 'plain', options: [{ value: 'plain', label: 'Plain' }] }))
  assert.equal(trigger().querySelector('.permissionIcon'), null)
  await view.unmount()
  const withIcon = await render(picker({ value: 'readOnly' }))
  assert.notEqual(trigger().querySelector('.permissionIcon'), null)
  await withIcon.unmount()
})

test('permission menu: Escape closes the list and changes nothing', async () => {
  const picked = []
  const view = await render(picker({ onChange: value => picked.push(value) }))
  await click(trigger())
  await act(() => { trigger().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.equal(rows().length, 0)
  assert.deepEqual(picked, [])
  await view.unmount()
})
