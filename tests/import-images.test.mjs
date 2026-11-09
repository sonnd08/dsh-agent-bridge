import test from 'node:test'
import assert from 'node:assert/strict'
import { parseImageData, saveImages } from '../src/import-images.ts'
import { sendReplay } from '../src/client/replay-prompt.ts'

const png = 'data:image/png;base64,QUJD'

test('parse: gives the type and the bytes of a supported image', () => {
  assert.deepEqual(parseImageData(png), { mediaType: 'image/png', data: 'QUJD' })
})

test('parse: refuses a type that the store does not accept, and text that is not an image', () => {
  assert.equal(parseImageData('data:image/svg+xml;base64,QUJD'), undefined)
  assert.equal(parseImageData('/tmp/a.png'), undefined)
  assert.equal(parseImageData('data:image/png,QUJD'), undefined)
})

test('save: writes the decoded bytes one time for a repeated image', async () => {
  const seen = []
  const map = await saveImages([png, png], (image) => { seen.push(image); return Promise.resolve({ attachmentId: 'a' }) })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].mediaType, 'image/png')
  assert.equal(Buffer.from(seen[0].data).toString(), 'ABC')
  assert.deepEqual(map.get(png), { attachmentId: 'a' })
})

test('save: a refused image is left out, and the next images are still saved', async (context) => {
  context.mock.method(console, 'warn', () => {})
  const good = 'data:image/jpeg;base64,REVG'
  const map = await saveImages([png, 'bad', good], image => image.mediaType === 'image/png' ? Promise.reject(new Error('too large')) : Promise.resolve({ attachmentId: 'b' }))
  assert.deepEqual([...map.keys()], [good])
})

const image = { mediaType: 'image/png', data: 'QUJD' }

test('replay prompt: sends the text and then the images', async () => {
  const sent = []
  await sendReplay((content) => { sent.push(content); return Promise.resolve({ ok: true }) }, 'see', [image])
  assert.deepEqual(sent, [[{ type: 'text', text: 'see' }, { type: 'image', mediaType: 'image/png', data: 'QUJD' }]])
})

test('replay prompt: a message with only an image has no empty text part', async () => {
  const sent = []
  await sendReplay((content) => { sent.push(content); return Promise.resolve({ ok: true }) }, '', [image])
  assert.deepEqual(sent, [[{ type: 'image', mediaType: 'image/png', data: 'QUJD' }]])
})

test('replay prompt: if DSH refuses the images, the text goes alone', async () => {
  const sent = []
  const answer = await sendReplay((content) => { sent.push(content); return Promise.resolve({ ok: sent.length > 1 }) }, 'see', [image])
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], [{ type: 'text', text: 'see' }])
  assert.equal(answer.ok, true)
})

test('replay prompt: a refused text is not sent again', async () => {
  let sends = 0
  const answer = await sendReplay(() => { sends += 1; return Promise.resolve({ ok: false }) }, 'see')
  assert.equal(sends, 1)
  assert.equal(answer.ok, false)
})

test('replay prompt: a refused image with no text is not sent again', async () => {
  let sends = 0
  await sendReplay(() => { sends += 1; return Promise.resolve({ ok: false }) }, '', [image])
  assert.equal(sends, 1)
})
