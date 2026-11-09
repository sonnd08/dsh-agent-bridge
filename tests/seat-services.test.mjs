import test from 'node:test'
import assert from 'node:assert/strict'
import { servicesPerDirectory } from '../src/client/seat-services.ts'

const make = () => {
  const current = new Map()
  let built = 0
  const servicesFor = servicesPerDirectory(
    (id) => { const directory = current.get(id); if (directory === undefined) throw new Error('not ready'); return directory },
    (id, directory) => { built += 1; return { id, directory } },
  )
  return { current, servicesFor, built: () => built }
}

test('seat services: the same directory gives the same services, so the renderer keeps one store', () => {
  const { current, servicesFor, built } = make()
  current.set('a', { store: 1 })
  assert.equal(servicesFor('a'), servicesFor('a'))
  assert.equal(built(), 1)
})

test('seat services: a session that opens again uses its new directory, so the model label updates', () => {
  const { current, servicesFor } = make()
  const first = { store: 'disposed' }
  const second = { store: 'live' }
  current.set('a', first)
  assert.equal(servicesFor('a').directory, first)
  current.set('a', second)
  assert.equal(servicesFor('a').directory, second)
})

test('seat services: two sessions do not share services', () => {
  const { current, servicesFor } = make()
  current.set('a', {})
  current.set('b', {})
  assert.notEqual(servicesFor('a'), servicesFor('b'))
})

test('seat services: a session that is not ready gets services with no directory, and they are not kept', (context) => {
  context.mock.method(console, 'warn', () => {})
  const { current, servicesFor } = make()
  assert.equal(servicesFor('a').directory, undefined)
  const directory = {}
  current.set('a', directory)
  assert.equal(servicesFor('a').directory, directory)
})
