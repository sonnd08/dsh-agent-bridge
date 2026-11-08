import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastUsedModel } from '../src/used-model.ts'
import { choiceFromUsed } from '../src/client/model-names.ts'

async function usedIn(engine, records) {
  const folder = await mkdtemp(join(tmpdir(), 'bridge-used-'))
  try {
    const file = join(folder, 'session.jsonl')
    await writeFile(file, records)
    return await lastUsedModel(engine, file)
  } finally {
    await rm(folder, { recursive: true })
  }
}

const lines = records => records.map(record => JSON.stringify(record)).join('\n')
const claude = (model, effort, extra = {}) => ({ type: 'assistant', effort, message: { model }, ...extra })

test('used model: Claude gives the last real turn', async () => {
  assert.deepEqual(await usedIn('claude', lines([claude('claude-haiku-5-5', 'low'), claude('claude-opus-5-5', 'high'), claude('<synthetic>', 'high'), claude('claude-sonnet-5', 'low', { isSidechain: true }), { type: 'user' }])), { model: 'claude-opus-5-5', effort: 'high' })
})

test('used model: Codex gives the last turn context', async () => {
  const context = (model, effort) => ({ type: 'turn_context', payload: { model, effort } })
  assert.deepEqual(await usedIn('codex', lines([context('codex-model-a', 'low'), context('codex-model-b', null), { type: 'event_msg' }])), { model: 'codex-model-b' })
})

test('used model: a record far before the end is found, and a broken last line is skipped', async () => {
  const text = `${lines([claude('claude-opus-5-5', 'high'), { type: 'user', text: 'x'.repeat(1 << 19) }])}\n{"type":"assistant","mess`
  assert.deepEqual(await usedIn('claude', text), { model: 'claude-opus-5-5', effort: 'high' })
})

test('used model: it gives the time of the turn', async () => {
  const used = await usedIn('claude', lines([{ ...claude('claude-opus-5-5', 'high'), timestamp: '2026-11-09T04:00:00.000Z' }]))
  assert.equal(used.at, Date.parse('2026-11-09T04:00:00.000Z'))
})

test('used model: a file with no turn gives nothing', async () => {
  assert.equal(await usedIn('claude', lines([{ type: 'user' }])), undefined)
})

test('used model: a recorded id becomes the value that the selector lists', () => {
  const info = { models: [{ value: 'default', efforts: [] }, { value: 'opus', efforts: ['low', 'high'] }, { value: 'haiku', efforts: ['low'] }, { value: 'codex-model-b', efforts: ['medium'] }] }
  assert.deepEqual(choiceFromUsed({ model: 'claude-opus-5-5', effort: 'high' }, info), { model: 'opus', effort: 'high' })
  assert.deepEqual(choiceFromUsed({ model: 'claude-haiku-5-5', effort: 'high' }, info), { model: 'haiku', effort: '' })
  assert.deepEqual(choiceFromUsed({ model: 'codex-model-b', effort: 'medium' }, info), { model: 'codex-model-b', effort: 'medium' })
  assert.deepEqual(choiceFromUsed({ model: 'unknown-model' }, info), { model: 'unknown-model', effort: '' })
  assert.deepEqual(choiceFromUsed({ model: 'claude-opus-5-5', effort: 'high' }, undefined), { model: 'claude-opus-5-5', effort: 'high' })
})
