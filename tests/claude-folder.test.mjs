import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstRecordedCwd } from '../src/claude.ts'

async function withFile(text, check) {
  const folder = await mkdtemp(join(tmpdir(), 'bridge-folder-'))
  try {
    const file = join(folder, 'session.jsonl')
    await writeFile(file, text)
    await check(file)
  } finally {
    await rm(folder, { recursive: true })
  }
}

const line = value => `${JSON.stringify(value)}\n`

test('session folder: it is found far from the two ends of a long file', async () => {
  const text = line({ type: 'x', text: 'a'.repeat(200_000) }) + line({ type: 'user', cwd: '/work/dự-án' }) + line({ type: 'x', text: 'b'.repeat(200_000) })
  await withFile(text, async file => { assert.equal(await firstRecordedCwd(file), '/work/dự-án') })
})

test('session folder: a field that crosses two reads is found', async () => {
  const start = '{"cwd":"/work/app"}'
  const text = `${' '.repeat((1 << 20) - 5)}${start}\n`
  await withFile(text, async file => { assert.equal(await firstRecordedCwd(file), '/work/app') })
})

test('session folder: a stored text that names cwd is not a field', async () => {
  const text = line({ type: 'tool', output: '{"cwd":"/wrong"}' }) + line({ type: 'user', cwd: '/right' })
  await withFile(text, async file => { assert.equal(await firstRecordedCwd(file), '/right') })
})

test('session folder: a file with no field gives an empty folder', async () => {
  await withFile(line({ type: 'x' }), async file => { assert.equal(await firstRecordedCwd(file), '') })
})
