import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHeapWatch } from '../src/diagnostics.ts'

const until = async (condition) => {
  const deadline = Date.now() + 60_000
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

test('passing the threshold writes one snapshot and logs the routes in flight', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ee-heap-'))
  const watch = startHeapWatch(dir, 1)
  const done = watch.enter('session')
  watch.enter('session')
  watch.enter('sessions')()
  try {
    await until(() => readdirSync(dir).some(name => name.endsWith('.heapsnapshot')) && readFileSync(join(dir, 'heap.log'), 'utf8').includes('tookMs'))
    await new Promise(resolve => setTimeout(resolve, 600))
    assert.equal(readdirSync(dir).filter(name => name.endsWith('.heapsnapshot')).length, 1, 'one snapshot per process')
    const lines = readFileSync(join(dir, 'heap.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(lines.find(line => line.snapshot === 'started').inFlight, { session: 2 })
    done()
    await new Promise(resolve => setTimeout(resolve, 400))
  } finally {
    watch.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a folder that cannot be written stops the watch without an uncaught error, and routes keep counting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ee-heap-'))
  const blocked = join(dir, 'a-file')
  writeFileSync(blocked, '')
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => { warnings.push(args) }
  const watch = startHeapWatch(join(blocked, 'heap'), 1)
  try {
    watch.enter('session')()
    await until(() => warnings.length === 1)
    await new Promise(resolve => setTimeout(resolve, 600))
    assert.equal(warnings.length, 1, 'the watch stops after the first failure')
    assert.match(String(warnings[0][0]), /heap watch stopped/)
    watch.enter('session')()
  } finally {
    console.warn = warn
    watch.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
