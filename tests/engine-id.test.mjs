import test from 'node:test'
import assert from 'node:assert/strict'
import { dropCachedInfo, infoCachePrefix, infoEngine, parseId, prefixed } from '../src/engine-id.ts'

test('session id: each engine prefix gives that engine and its own id', () => {
  assert.deepEqual(parseId('claude:abc'), { engine: 'claude', raw: 'abc' })
  assert.deepEqual(parseId('codex:abc'), { engine: 'codex', raw: 'abc' })
  assert.deepEqual(parseId('pi:abc'), { engine: 'pi', raw: 'abc' })
})

test('session id: an added instance is split from the id of the engine', () => {
  assert.deepEqual(parseId('codex:@work:abc'), { engine: 'codex', raw: 'abc', instance: 'work' })
  assert.deepEqual(parseId('claude:@a-b_1:abc:def'), { engine: 'claude', raw: 'abc:def', instance: 'a-b_1' })
})

test('session id: an id of DSH or an unknown engine is not an external session', () => {
  assert.equal(parseId(''), undefined)
  assert.equal(parseId('session-123'), undefined)
  assert.equal(parseId('other:abc'), undefined)
  assert.equal(parseId('claude'), undefined)
})

test('session id: an instance mark with no closing colon is part of the id', () => {
  assert.deepEqual(parseId('codex:@work'), { engine: 'codex', raw: '@work' })
})

test('session id: a built id parses to the same parts', () => {
  for (const [engine, raw, instance] of [['claude', 'one', undefined], ['codex', 'two', 'work'], ['pi', 'three', undefined], ['claude', 'four', 'home-2']]) {
    const parts = parseId(prefixed(engine, raw, instance))
    assert.deepEqual(parts, instance === undefined ? { engine, raw } : { engine, raw, instance })
  }
})

test('info route: Codex and Pi are named, and all else is Claude', () => {
  assert.equal(infoEngine('codex'), 'codex')
  assert.equal(infoEngine('pi'), 'pi')
  assert.equal(infoEngine('claude'), 'claude')
  assert.equal(infoEngine(''), 'claude')
  assert.equal(infoEngine('CODEX'), 'claude')
  assert.equal(infoEngine('unknown'), 'claude')
})

const cacheOf = (...keys) => new Map(keys.map(key => [key, { at: 1 }]))

test('sign-in: success removes every folder of that provider from the cache', () => {
  const cache = cacheOf('claude::/a', 'claude::/b')
  dropCachedInfo(cache, 'claude', undefined)
  assert.deepEqual([...cache.keys()], [])
})

test('sign-in: other engines and instances keep their answers', () => {
  const cache = cacheOf('claude::/a', 'claude:work:/a', 'codex::/a', 'pi::/a')
  dropCachedInfo(cache, 'claude', undefined)
  assert.deepEqual([...cache.keys()], ['claude:work:/a', 'codex::/a', 'pi::/a'])
})

test('sign-in: an instance removes only its own answers', () => {
  const cache = cacheOf('codex:work:/a', 'codex:work2:/a', 'codex::/a', 'claude:work:/a')
  dropCachedInfo(cache, 'codex', 'work')
  assert.deepEqual([...cache.keys()], ['codex:work2:/a', 'codex::/a', 'claude:work:/a'])
})

test('sign-in: an empty cache stays empty', () => {
  const cache = new Map()
  dropCachedInfo(cache, 'claude', undefined)
  assert.equal(cache.size, 0)
})

test('info cache: a folder is the rest of the key', () => {
  assert.equal(`${infoCachePrefix('codex', 'work')}/a:b`, 'codex:work:/a:b')
  assert.equal(`${infoCachePrefix('claude', undefined)}/a`, 'claude::/a')
})
