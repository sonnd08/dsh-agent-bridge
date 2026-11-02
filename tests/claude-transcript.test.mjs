import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toTranscript } from '../src/claude.ts'

const user = (uuid, content) => ({ type: 'user', uuid, message: { content } })
const notification = '<task-notification>\n<task-id>b4</task-id>\n<status>completed</status>\n<summary>Background command done</summary>\n</task-notification>'

test('a background-task notification is not shown as something the user said', () => {
  const shown = toTranscript([user('a', 'hello'), user('n', notification), user('p', `  ${notification}\n`)])
  assert.deepEqual(shown.map(message => message.id), ['a'])
})

test('words the user added to a notification stay, and so does a user message that only mentions the tag', () => {
  const mixed = `${notification} why did this appear?`
  const mention = 'what does <task-notification> mean?'
  assert.deepEqual(toTranscript([user('m', mixed), user('t', mention)]).map(message => message.id), ['m', 't'])
})

test('an assistant message quoting a notification stays', () => {
  const shown = toTranscript([{ type: 'assistant', uuid: 'x', message: { content: [{ type: 'text', text: notification }] } }])
  assert.equal(shown.length, 1)
})

test('an empty thinking block is dropped and a summary is kept', () => {
  const shown = toTranscript([{ type: 'assistant', uuid: 'x', message: { content: [
    { type: 'thinking', thinking: '', signature: 's' },
    { type: 'thinking', thinking: 'first check the seats', signature: 's' },
    { type: 'text', text: 'done' },
  ] } }])
  assert.deepEqual(shown[0].blocks, [{ type: 'thinking', text: 'first check the seats' }, { type: 'text', text: 'done' }])
})
