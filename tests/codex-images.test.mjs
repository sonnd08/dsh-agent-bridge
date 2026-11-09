import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dynamicToolResult, fileImageResult, imageFileUrl, mcpToolResult, userBlocks } from '../src/codex-images.ts'
import { CodexTurnReader } from '../src/native-codex.ts'

const folder = mkdtempSync(join(tmpdir(), 'bridge-codex-images-'))
test.after(() => { rmSync(folder, { recursive: true, force: true }) })
const file = (name, text = 'ABC') => { const path = join(folder, name); writeFileSync(path, text); return path }
const data = 'data:image/png;base64,QUJD'

test('file: an image file becomes a data URL with the type of its extension', () => {
  assert.equal(imageFileUrl(file('a.png')), data)
  assert.equal(imageFileUrl(file('b.JPG')), 'data:image/jpeg;base64,QUJD')
})

test('file: a file that is not an image is left out, and a missing file does not throw', (context) => {
  context.mock.method(console, 'warn', () => {})
  assert.equal(imageFileUrl(file('a.txt')), undefined)
  assert.equal(imageFileUrl(join(folder, 'gone.png')), undefined)
})

test('user message: an inline image and a local image become image blocks before the text', () => {
  const blocks = userBlocks([{ type: 'text', text: 'see' }, { type: 'image', url: data }, { type: 'localImage', path: file('c.png') }])
  assert.deepEqual(blocks, [{ type: 'image', src: data }, { type: 'image', src: data }, { type: 'text', text: 'see' }])
})

test('user message: an image that cannot load stays as a short note', (context) => {
  context.mock.method(console, 'warn', () => {})
  assert.deepEqual(userBlocks([{ type: 'text', text: 'see' }, { type: 'image', url: 'https://example.test/a.png' }, { type: 'localImage', path: join(folder, 'gone.png') }]), [{ type: 'text', text: 'see\n[image]\n[localImage]' }])
})

test('user message: content that is not a list has empty text', () => {
  assert.deepEqual(userBlocks(undefined), [{ type: 'text', text: '' }])
})

test('MCP result: gives the text and the images, with no bytes in the text', () => {
  const result = mcpToolResult({ status: 'completed', result: { content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }, { type: 'text', text: 'b' }] } })
  assert.deepEqual(result, { text: 'a\nb', images: ['data:image/jpeg;base64,QUJD'], isError: false })
})

test('MCP result: an image with no type is a PNG', () => {
  assert.deepEqual(mcpToolResult({ result: { content: [{ type: 'image', data: 'QUJD' }] } }).images, [data])
})

test('MCP result: an error gives its message, and a failed status is an error', () => {
  assert.deepEqual(mcpToolResult({ status: 'failed', error: { message: 'boom' } }), { text: 'boom', images: [], isError: true })
  assert.equal(mcpToolResult({ status: 'failed' }).isError, true)
})

test('MCP result: a result with no content list stays readable', () => {
  assert.equal(mcpToolResult({ result: { rows: 2 } }).text, '{"rows":2}')
})

test('dynamic result: gives the text and only inline images', () => {
  const result = dynamicToolResult({ success: true, contentItems: [{ type: 'inputText', text: 'a' }, { type: 'inputImage', imageUrl: data }, { type: 'inputImage', imageUrl: 'https://example.test/a.png' }] })
  assert.deepEqual(result, { text: 'a', images: [data], isError: false })
})

test('dynamic result: a failed call is an error, and no content is valid', () => {
  assert.deepEqual(dynamicToolResult({ success: false }), { text: '', images: [], isError: true })
})

test('viewed file: gives the path and the image, and a missing path is valid', () => {
  const path = file('d.png')
  assert.deepEqual(fileImageResult(path), { text: path, images: [data], isError: false })
  assert.deepEqual(fileImageResult(null), { text: '', images: [], isError: false })
})

test('live turn: an MCP result settles with its image, and the text has no base64', () => {
  const settled = []
  const reader = new CodexTurnReader({ push: () => {}, settle: (...args) => settled.push(args), approve: () => Promise.resolve(true), onThread: () => {} }, () => {})
  const item = { id: 'm', type: 'mcpToolCall', tool: 'js', status: 'completed', arguments: {}, result: { content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }] } }
  reader.read({ method: 'item/started', params: { item } })
  reader.read({ method: 'item/completed', params: { item } })
  assert.deepEqual(settled, [['m', { text: '', isError: false, images: [data] }]])
})
