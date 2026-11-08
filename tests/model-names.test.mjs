import test from 'node:test'
import assert from 'node:assert/strict'
import { effortName, engineLabels, engineModels, fastTierOf, modelTitle, speedFor } from '../src/client/model-names.ts'

const claude = {
  models: [
    { value: 'default', name: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', efforts: ['high'] },
    { value: 'opus', name: 'Opus', description: 'Opus 5.5 · Most capable', efforts: ['low', 'xhigh'] },
    { value: 'haiku', name: 'Haiku', description: 'Haiku 5.5 · Fastest', efforts: [] },
  ],
  commands: [], mcp: [], defaults: { model: 'Opus', effort: 'high' },
}
const codex = { models: [{ value: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', description: 'Frontier model · for coding', efforts: ['high'], isDefault: true }], commands: [], mcp: [] }
const NONE = { model: '', effort: '' }

test('model names: a Claude row shows the full name and version', () => {
  assert.equal(modelTitle('claude', claude.models[1]), 'Claude Opus 5.5')
})

test('model names: a description without a version keeps the listed name', () => {
  assert.equal(modelTitle('claude', { value: 'x', name: 'Opus', description: 'Most capable', efforts: [] }), 'Opus')
  assert.equal(modelTitle('claude', { value: 'x', name: 'Opus', description: 'Other · text', efforts: [] }), 'Opus')
})

test('model names: other providers keep the listed name', () => {
  assert.equal(modelTitle('codex', codex.models[0]), 'GPT-6.1 Sol')
})

test('model names: the Default entry is not a row', () => {
  assert.deepEqual(engineModels('claude', claude).map(row => row.id), ['opus', 'haiku'])
  assert.deepEqual(engineModels('claude', claude)[0].efforts, [{ id: 'low', name: 'Low' }, { id: 'xhigh', name: 'Extra High' }])
})

test('model names: no pick selects and names the model the engine uses', () => {
  assert.deepEqual(engineLabels('claude', claude, NONE), { modelId: 'opus', label: 'Claude Opus 5.5', effort: 'High', effortId: '' })
  assert.deepEqual(engineLabels('codex', codex, NONE), { modelId: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', effort: '', effortId: '' })
})

test('model names: a saved pick of the Default entry reads as no pick', () => {
  assert.equal(engineLabels('claude', claude, { model: 'default', effort: '' }).label, 'Claude Opus 5.5')
})

test('model names: a picked model and effort are shown', () => {
  assert.deepEqual(engineLabels('claude', claude, { model: 'haiku', effort: 'low' }), { modelId: 'haiku', label: 'Claude Haiku 5.5', effort: 'Low', effortId: 'low' })
})

test('model names: an unlisted model shows its id, and loading shows nothing yet', () => {
  assert.equal(engineLabels('claude', claude, { model: 'claude-x', effort: '' }).label, 'claude-x')
  assert.deepEqual(engineLabels('claude', undefined, NONE), { modelId: '', label: '', effort: '', effortId: '' })
})

test('model names: reasoning levels read as words', () => {
  assert.equal(effortName('medium'), 'Medium')
})

test('model names: only a model with a fast tier can be fast', () => {
  const info = { models: [{ value: 'a', name: 'A', description: '', efforts: [], fastTier: 'priority' }, { value: 'b', name: 'B', description: '', efforts: [] }], commands: [], mcp: [] }
  assert.equal(fastTierOf(info, 'a'), 'priority')
  assert.equal(fastTierOf(info, 'b'), undefined)
  assert.equal(speedFor(info, 'a', 'fast'), 'priority')
  assert.equal(speedFor(info, 'b', 'fast'), '')
  assert.equal(speedFor(info, 'a', ''), '')
  assert.equal(speedFor(info, 'a', undefined), undefined)
})

test('model names: a model with no saved level uses Medium when it supports it', () => {
  const info = { models: [{ value: 'a', name: 'A', description: '', efforts: ['low', 'medium'] }], commands: [], mcp: [], defaults: { effort: 'high' } }
  assert.deepEqual(engineLabels('codex', info, { model: 'a', effort: '' }), { modelId: 'a', label: 'A', effort: 'Medium', effortId: 'medium' })
  assert.equal(engineLabels('codex', info, { model: 'a', effort: 'low' }).effortId, 'low')
})
