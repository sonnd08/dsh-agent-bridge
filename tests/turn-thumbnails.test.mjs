import test from 'node:test'
import assert from 'node:assert/strict'

const { render, act, byTestId, allByTestId, click, t, React } = await import('./support/dom.mjs')
const { EngineTurnImages } = await import('../src/client/EngineTurnImages.tsx')
const { ThumbStrip } = await import('../src/client/ThumbStrip.tsx')
const { ToolRunRow } = await import('../src/client/ToolCard.tsx')
const { ENGINE_IMAGES_KEY, engineImagesDefinition: definition, localImageUrl, thumbnailsOf } = await import('../src/client/engine-turn-images.ts')

test.afterEach(() => { document.body.replaceChildren() })
const flush = () => act(async () => { await new Promise(resolve => { setImmediate(resolve) }) })
const start = { type: 'turn/start', data: { turn: 3 } }
const call = (callId, name = 'engine_tool') => ({ type: 'tool/call', data: { turn: 3, callId, name } })
const result = (callId, ...ids) => ({ type: 'tool/result', surfaceOp: 'append', data: { turn: 3, message: { source: { callId }, content: [{ type: 'text', text: 'x' }, ...ids.map(attachmentId => ({ type: 'image', attachment: { attachmentId } }))] } } })
const fold = (...events) => events.reduce((state, event) => definition.update({ state }, { event }), definition.start(undefined, { event: start }))

test('definition: starts on a turn and reads tool events of that turn only', () => {
  assert.deepEqual(definition.match(start), { id: '3', role: 'start' })
  assert.deepEqual(definition.match(call('a')), { id: '3', role: 'update' })
  assert.deepEqual(definition.match(result('a')), { id: '3', role: 'update' })
  assert.equal(definition.match({ type: 'step/start', data: { turn: 3 } }), null)
  assert.equal(definition.match({ ...result('a'), surfaceOp: undefined }), null)
})

test('definition: collects the images of engine tool results in order', () => {
  assert.deepEqual(fold(call('a'), result('a', '1'), call('b'), result('b', '2', '3')).images.map(image => image.attachmentId), ['1', '2', '3'])
})

test('definition: leaves out the images of other DSH tools and of unknown calls', () => {
  assert.deepEqual(fold(call('a', 'read_image'), result('a', '1'), result('zz', '2')).images, [])
})

test('definition: publishes data only when the turn has images, and keeps the same value if nothing changed', () => {
  assert.equal(definition.buildLocationData({ state: fold() }, 'turn'), null)
  const state = fold(call('a'), result('a', '1'))
  assert.equal(definition.buildLocationData({ state }, 'step'), null)
  const value = definition.buildLocationData({ state }, 'turn')
  assert.equal(value.key, ENGINE_IMAGES_KEY)
  assert.equal(value.turn, 3)
  assert.equal(definition.buildLocationData({ state }, 'turn', value), value)
})

test('thumbnails: keeps the newest three and counts the others', () => {
  assert.deepEqual(thumbnailsOf([1, 2, 3, 4, 5]), { shown: [3, 4, 5], more: 2 })
  assert.deepEqual(thumbnailsOf([1]), { shown: [1], more: 0 })
})

test('local image: gives the DSH file address of an absolute path', () => {
  assert.equal(localImageUrl('http://localhost:1/x/', '/a%20b/c.jpg?v=1'), 'http://localhost:1/x/api/file?path=%2Fa%20b%2Fc.jpg')
  assert.equal(localImageUrl('http://localhost:1/', 'C:\\a\\c.jpg'), 'http://localhost:1/api/file?path=C%3A%5Ca%5Cc.jpg')
})

test('local image: refuses a relative path, a web address, a network path and a malformed escape', () => {
  for (const value of ['a/c.jpg', 'https://example.test/a.jpg', '//server/a.jpg', '/a%zz.jpg']) assert.equal(localImageUrl('http://localhost:1/', value), undefined, value)
})

const strip = (urls, extra = {}) => React.createElement(ThumbStrip, { urls, t, ...extra })

test('strip: shows nothing with no image', async () => {
  await render(strip([]))
  assert.equal(byTestId('ext-thumb-strip'), null)
})

test('strip: shows three thumbnails and the count of the others', async () => {
  await render(strip(['a', 'b', 'c', 'd']))
  assert.deepEqual(allByTestId('ext-thumb').map(image => image.getAttribute('src')), ['b', 'c', 'd'])
  assert.equal(byTestId('ext-thumb-more').textContent, '+1')
})

test('strip: a click shows the full image, a second click closes it, and the row click does not run', async () => {
  let rowClicks = 0
  await render(React.createElement('div', { onClick: () => { rowClicks += 1 } }, strip(['a'])))
  await click(allByTestId('ext-thumb')[0].parentElement)
  assert.equal(byTestId('ext-zoom').querySelector('img').getAttribute('src'), 'a')
  assert.equal(rowClicks, 0)
  await click(byTestId('ext-zoom'))
  assert.equal(byTestId('ext-zoom'), null)
})

const loadImage = Object.assign(attachment => Promise.resolve(`blob:${attachment.attachmentId}`), {})
const turnOf = (images, turn = 3) => ({ turn, data: { get: key => key === ENGINE_IMAGES_KEY && images.length > 0 ? { images } : undefined } })
const chat = (turnImages, headerTurn = 3) => React.createElement('div', { 'data-testid': 'chat' },
  React.createElement('div', { 'data-testid': 'header-row' }, headerTurn === null ? null : React.createElement('button', { 'data-turn-process': headerTurn })),
  React.createElement('div', { 'data-testid': 'tail' }, turnImages))
const images = (props = {}) => React.createElement(EngineTurnImages, { turn: turnOf([{ attachmentId: 'a' }]), loadImage, t, ...props })

test('turn images: show on the header row of their turn, so they stay visible when folded', async () => {
  await render(chat(images()))
  await flush()
  const row = byTestId('header-row')
  assert.equal(row.querySelector('[data-testid="ext-thumb"]').getAttribute('src'), 'blob:a')
  assert.equal(row.style.position, 'relative')
  assert.equal(row.querySelector('[data-testid="ext-thumb-strip"]').style.top, '0px')
  assert.equal(byTestId('tail').querySelector('[data-testid="ext-thumb"]'), null)
})

test('turn images: stay in the turn when the turn has no header', async (context) => {
  context.mock.method(globalThis, 'requestAnimationFrame', () => 1)
  await render(chat(images(), null))
  await flush()
  assert.ok(byTestId('tail').querySelector('[data-testid="ext-thumb"]'))
})

test('turn images: use the header of the same turn number in their own chat', async () => {
  await render(React.createElement('div', null,
    React.createElement('div', { 'data-testid': 'other' }, React.createElement('div', null, React.createElement('button', { 'data-turn-process': 3 }))),
    chat(images())))
  await flush()
  assert.equal(byTestId('other').querySelector('[data-testid="ext-thumb"]'), null)
  assert.ok(byTestId('header-row').querySelector('[data-testid="ext-thumb"]'))
})

test('turn images: a turn with no image draws nothing', async () => {
  await render(chat(images({ turn: turnOf([]) })))
  await flush()
  assert.equal(byTestId('ext-thumb-strip'), null)
  assert.equal(byTestId('header-row').style.position, '')
})

const toolItem = (...urls) => ({ kind: 'tool', use: { type: 'tool_use', name: 'computer', input: '' }, result: { type: 'tool_result', text: '', images: urls } })
const run = (...items) => React.createElement(ToolRunRow, { run: { kind: 'run', id: 'r', items }, t, running: false, active: false })

test('panel: a folded tool group shows its images beside the row', async () => {
  await render(run(toolItem('a'), toolItem('b')))
  assert.deepEqual(allByTestId('ext-thumb').map(image => image.getAttribute('src')), ['a', 'b'])
})

test('panel: a tool group with no image has no thumbnails', async () => {
  await render(run(toolItem()))
  assert.equal(byTestId('ext-thumb-strip'), null)
})
