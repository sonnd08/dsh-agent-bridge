import test from 'node:test'
import assert from 'node:assert/strict'
import { codexDriver } from '../src/native-codex.ts'

const sink = () => ({ push() {}, settle() {}, approve: async () => true, onThread() {} })

const driverWith = (engine) => codexDriver({ route: 'codex', listModels: async () => [], engine: () => engine, home: () => '/tmp/none' })

const fakeEngine = (overrides = {}) => {
  const calls = []
  return {
    calls,
    prepareThread: async () => 'thread-1',
    watch: () => () => {},
    start: async () => 'thread-1',
    answer() {},
    interrupt: async (id) => { calls.push(['interrupt', id]); return true },
    cleanTerminals: async (id) => { calls.push(['clean', id]) },
    ...overrides,
  }
}

const begin = engine => driverWith(engine).begin({ cwd: '/tmp/none', prompt: 'go', model: 'm', sink: sink() })

test('codex stop: Stop ends the turn first and then ends the shell commands', async () => {
  const engine = fakeEngine()
  await (await begin(engine)).interrupt()
  assert.deepEqual(engine.calls, [['interrupt', 'thread-1'], ['clean', 'thread-1']])
})

test('codex stop: no running turn means that no command is stopped', async () => {
  const engine = fakeEngine({ interrupt: async () => false })
  await (await begin(engine)).interrupt()
  assert.deepEqual(engine.calls, [])
})

test('codex stop: a Codex that refuses the clean request gives the error to the caller', async () => {
  const engine = fakeEngine({ cleanTerminals: async () => { throw new Error('method not found') } })
  await assert.rejects((await begin(engine)).interrupt(), /method not found/)
})
