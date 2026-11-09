import test from 'node:test'
import assert from 'node:assert/strict'

const { render, act, byTestId, allByTestId, click, t, React } = await import('./support/dom.mjs')
const { EngineToolRow } = await import('../src/client/EngineToolRow.tsx')
const { engineToolView } = await import('../src/client/engine-tool-item.ts')

const argsRaw = JSON.stringify({ tool: 'Bash', input: { command: 'ls -la' } })
const settled = (change = {}) => ({ kind: 'tool-result', call: { name: 'engine_tool', argsRaw }, content: [{ type: 'text', text: 'out' }], isError: false, ...change })
const loader = (urls = { a: 'blob:a' }) => Object.assign(attachment => urls[attachment.attachmentId] === undefined ? Promise.reject(new Error('gone')) : Promise.resolve(urls[attachment.attachmentId]), {})
const row = (props = {}) => React.createElement(EngineToolRow, { phase: 'result', block: settled(), callId: 'c', loadImage: loader(), t, ...props })
test.afterEach(() => { document.body.replaceChildren() })
const flush = () => act(async () => { await new Promise(resolve => { setImmediate(resolve) }) })

test('view: reads the real tool name and input from a started call', () => {
  const view = engineToolView({ callId: 'c', argsRaw }, 'unnamed')
  assert.equal(view.use.name, 'Bash')
  assert.deepEqual(view.use.args, { command: 'ls -la' })
  assert.equal(view.use.id, 'c')
  assert.equal(view.result, undefined)
})

test('view: joins the result text, and collects the images', () => {
  const view = engineToolView(settled({ callId: 'c', content: [{ type: 'text', text: 'a' }, { type: 'image', attachment: { attachmentId: 'i' } }, { type: 'text', text: 'b' }], isError: true }), 'unnamed')
  assert.deepEqual(view.result, { type: 'tool_result', text: 'a\nb', forId: 'c', isError: true })
  assert.deepEqual(view.attachments, [{ attachmentId: 'i' }])
})

test('view: a call outside the loaded window, or with broken arguments, has a safe name', () => {
  assert.equal(engineToolView(settled({ call: null }), 'unnamed').use.name, 'unnamed')
  assert.equal(engineToolView({ argsRaw: '{broken' }, 'unnamed').use.name, 'unnamed')
})

test('view: a text input is a summary with no structured arguments, and a long input is cut', () => {
  const text = engineToolView({ argsRaw: JSON.stringify({ tool: 'X', input: 'plain' }) }, 'u').use
  assert.equal(text.input, 'plain')
  assert.equal('args' in text, false)
  assert.equal(engineToolView({ argsRaw: JSON.stringify({ tool: 'X', input: 'y'.repeat(500) }) }, 'u').use.input.length, 401)
})

test('row: shows the real tool in a finished state', async () => {
  await render(row())
  const card = byTestId('ext-tool-use')
  assert.equal(card.dataset.tool, 'Bash')
  assert.equal(card.dataset.state, 'done')
})

test('row: a failed call is shown as failed', async () => {
  await render(row({ block: settled({ isError: true }) }))
  assert.equal(byTestId('ext-tool-use').dataset.state, 'error')
})

test('row: a call that still runs is shown as ongoing', async () => {
  await render(row({ phase: 'start', block: { argsRaw } }))
  assert.equal(byTestId('ext-tool-use').dataset.state, 'ongoing')
})

test('row: shows nothing while DSH prepares the arguments', async () => {
  await render(row({ phase: 'preparing', block: {} }))
  assert.equal(byTestId('ext-tool-use'), null)
})

test('row: shows a tool image, and a click makes it large', async () => {
  await render(row({ block: settled({ content: [{ type: 'text', text: 'shot' }, { type: 'image', attachment: { attachmentId: 'a' } }] }) }))
  await flush()
  const image = byTestId('ext-image')
  assert.equal(image.getAttribute('src'), 'blob:a')
  await click(image)
  assert.ok(byTestId('ext-zoom'))
})

test('row: uses an address that the loader already knows, with no new load', async () => {
  let loads = 0
  const loadImage = Object.assign(() => { loads += 1; return Promise.resolve('blob:new') }, { peek: () => 'blob:known' })
  await render(row({ loadImage, block: settled({ content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }) }))
  await flush()
  assert.equal(byTestId('ext-image').getAttribute('src'), 'blob:known')
  assert.equal(loads, 0)
})

test('row: an image that does not load is left out, and the row stays', async (context) => {
  context.mock.method(console, 'warn', () => {})
  await render(row({ loadImage: loader({}), block: settled({ content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }) }))
  await flush()
  assert.equal(allByTestId('ext-image').length, 0)
  assert.ok(byTestId('ext-tool-use'))
})
