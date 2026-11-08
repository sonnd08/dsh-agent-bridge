import test from 'node:test'
import assert from 'node:assert/strict'
import { addCustomModel, enginePrefs, moveModel, NO_MODEL_PREFS, normalizeCustomSlug, orderRows, parseModelPrefs, removeCustomModel, toggleAllHidden, toggleFavorite, toggleHidden } from '../src/model-prefs.ts'
import { engineCatalog, visibleEngineModels } from '../src/client/model-names.ts'

const row = id => ({ id })
const info = { models: [{ value: 'a', name: 'A', description: '', efforts: ['high'] }, { value: 'b', name: 'B', description: '', efforts: [] }], commands: [], mcp: [] }

test('model prefs: rows follow the stored order, and new rows follow them', () => {
  assert.deepEqual(orderRows(['a', 'b', 'c', 'd'].map(row), ['c', 'a']).map(item => item.id), ['c', 'a', 'b', 'd'])
})

test('model prefs: a row moves within its group', () => {
  const display = ['fav', 'a', 'b', 'hidden']
  const moved = moveModel(NO_MODEL_PREFS, 'codex', ['a', 'b'], display, 'b', -1)
  assert.deepEqual(enginePrefs(moved, 'codex').order, ['fav', 'b', 'a', 'hidden'])
})

test('model prefs: a row at the end of its group stays', () => {
  assert.equal(moveModel(NO_MODEL_PREFS, 'codex', ['a', 'b'], ['a', 'b'], 'a', -1), NO_MODEL_PREFS)
  assert.equal(moveModel(NO_MODEL_PREFS, 'codex', ['a', 'b'], ['a', 'b'], 'b', 1), NO_MODEL_PREFS)
})

test('model prefs: hide and show one model', () => {
  const hidden = toggleHidden(NO_MODEL_PREFS, 'claude', 'a')
  assert.deepEqual(enginePrefs(hidden, 'claude').hidden, ['a'])
  assert.deepEqual(enginePrefs(toggleHidden(hidden, 'claude', 'a'), 'claude').hidden, [])
})

test('model prefs: disable all hides everything, then a second use shows everything', () => {
  const some = toggleHidden(NO_MODEL_PREFS, 'claude', 'a')
  const all = toggleAllHidden(some, 'claude', ['a', 'b'])
  assert.deepEqual(enginePrefs(all, 'claude').hidden, ['a', 'b'])
  assert.deepEqual(enginePrefs(toggleAllHidden(all, 'claude', ['a', 'b']), 'claude').hidden, [])
})

test('model prefs: favorites toggle', () => {
  const on = toggleFavorite(NO_MODEL_PREFS, 'codex/a')
  assert.deepEqual(on.favorites, ['codex/a'])
  assert.deepEqual(toggleFavorite(on, 'codex/a').favorites, [])
})

test('model prefs: a custom id is cleaned and rejected when it is not valid', () => {
  assert.equal(normalizeCustomSlug('  claude-opus-4-8 '), 'claude-opus-4-8')
  assert.equal(normalizeCustomSlug('   '), undefined)
  assert.equal(normalizeCustomSlug('two words'), undefined)
  assert.equal(normalizeCustomSlug('x'.repeat(300)), undefined)
})

test('model prefs: removing a custom model also removes its order and favorite', () => {
  let prefs = addCustomModel(NO_MODEL_PREFS, 'claude', 'x')
  assert.equal(addCustomModel(prefs, 'claude', 'x'), prefs)
  prefs = toggleFavorite(moveModel(prefs, 'claude', ['x', 'a'], ['x', 'a'], 'x', 1), 'claude/x')
  const removed = removeCustomModel(prefs, 'claude', 'x')
  assert.deepEqual(enginePrefs(removed, 'claude').custom, [])
  assert.deepEqual(enginePrefs(removed, 'claude').order, ['a'])
  assert.deepEqual(removed.favorites, [])
})

test('model prefs: the wire format is validated', () => {
  const good = { engines: { claude: { hidden: ['a'], order: [], custom: [] } }, favorites: ['claude/a'] }
  assert.deepEqual(parseModelPrefs(good), good)
  assert.equal(parseModelPrefs(null), undefined)
  assert.equal(parseModelPrefs({ engines: {}, favorites: 'a' }), undefined)
  assert.equal(parseModelPrefs({ engines: { claude: { hidden: [1], order: [], custom: [] } }, favorites: [] }), undefined)
  assert.deepEqual(parseModelPrefs({ engines: { other: {} }, favorites: [] }), { engines: {}, favorites: [] })
})

test('model prefs: the selector shows custom models and leaves out hidden ones', () => {
  let prefs = addCustomModel(NO_MODEL_PREFS, 'codex', 'my-model')
  prefs = toggleHidden(prefs, 'codex', 'a')
  assert.deepEqual(engineCatalog('codex', info, prefs).map(item => [item.id, item.custom === true]), [['a', false], ['b', false], ['my-model', true]])
  assert.deepEqual(visibleEngineModels('codex', info, prefs).map(item => item.id), ['b', 'my-model'])
})

test('model prefs: a custom id equal to a listed model is not a second row', () => {
  assert.deepEqual(engineCatalog('codex', info, addCustomModel(NO_MODEL_PREFS, 'codex', 'a')).map(item => item.id), ['a', 'b'])
})

test('model prefs: a hidden custom id is not possible, because the row can only be removed', () => {
  assert.deepEqual(visibleEngineModels('codex', info, toggleHidden(addCustomModel(NO_MODEL_PREFS, 'codex', 'x'), 'codex', 'x')).map(item => item.id), ['a', 'b', 'x'])
})
