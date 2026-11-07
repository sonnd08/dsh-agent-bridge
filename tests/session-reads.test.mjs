import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSingleFlight } from '../src/single-flight.ts'
import { createTranscriptController } from '../src/client/transcript.ts'

const tick = () => new Promise(resolve => { setImmediate(resolve) })

test('concurrent reads of one session share a single load, and a later read loads again', async () => {
  const reads = createSingleFlight()
  let loads = 0
  let finish
  const load = () => { loads += 1; return new Promise(resolve => { finish = resolve }) }
  const pending = Array.from({ length: 20 }, () => reads.run('claude:big', load))
  assert.equal(loads, 1)
  finish({ messages: ['m1'] })
  const results = await Promise.all(pending)
  assert.ok(results.every(result => result === results[0]))
  void reads.run('claude:big', load)
  assert.equal(loads, 2, 'a read after the shared one settles reads the file again')
  finish({ messages: [] })
})

test('a failed shared read rejects every caller and is not reused', async () => {
  const reads = createSingleFlight()
  let loads = 0
  const fail = () => { loads += 1; return Promise.reject(new Error('gone')) }
  const results = await Promise.allSettled([reads.run('k', fail), reads.run('k', fail)])
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected'])
  await assert.rejects(reads.run('k', fail))
  assert.equal(loads, 2)
})

test('a burst of new messages during a running turn keeps one transcript request in flight', async (t) => {
  const requests = []
  const sources = []
  t.mock.method(globalThis, 'fetch', (url) => new Promise((resolve) => {
    requests.push({ url: String(url), resolve })
  }))
  globalThis.EventSource = class {
    constructor(url) { this.url = url; sources.push(this) }
    close() {}
  }
  t.after(() => { delete globalThis.EventSource })
  const answer = (messages) => ({ ok: true, json: async () => ({ messages }) })

  const transcript = createTranscriptController({ onTurnStarted() {}, onTurnEnded() {}, onCreated() {} })
  transcript.open('claude:big')
  assert.equal(requests.length, 1, 'opening a session reads it once')
  const live = sources.find(source => source.url.includes('live'))
  for (let index = 0; index < 20; index += 1) live.onmessage({ data: JSON.stringify({ kind: 'message' }) })
  assert.equal(requests.length, 1, 'messages written while the transcript is being read add no request')

  requests[0].resolve(answer([{ id: 'a' }]))
  await tick()
  assert.equal(requests.length, 2, 'the burst collapses into one more read after the first one')
  requests[1].resolve(answer([{ id: 'a' }, { id: 'b' }]))
  await tick()
  await tick()
  assert.equal(requests.length, 2, 'no read follows once nothing new was asked for')
  assert.deepEqual(transcript.getSnapshot().messages.map(message => message.id), ['a', 'b'])
  transcript.close()
})
