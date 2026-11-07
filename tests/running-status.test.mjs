import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatElapsed } from '../src/client/elapsed.ts'

const en = { 'duration.hour': 'h ', 'duration.minute': 'm ', 'duration.second': 's' }
const zh = { 'duration.hour': '小时', 'duration.minute': '分', 'duration.second': '秒' }
const tOf = dict => key => dict[key]

test('elapsed time uses the DSH running-status units and never shows zero', () => {
  assert.equal(formatElapsed(0, tOf(en)), '1s')
  assert.equal(formatElapsed(12_400, tOf(en)), '12s')
  assert.equal(formatElapsed(65_000, tOf(en)), '1m 5s')
  assert.equal(formatElapsed(3_600_000, tOf(en)), '1h 0m 0s')
  assert.equal(formatElapsed(65_000, tOf(zh)), '1分5秒')
})
