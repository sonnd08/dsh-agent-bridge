import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstRecordedCwd, listClaudeRows } from '../src/claude.ts'

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

test('session folder: a folder with non-ASCII text that crosses two reads is found', async () => {
  const text = `${' '.repeat((1 << 20) - 5)}${line({ cwd: '/work/dự-án' })}`
  await withFile(text, async file => { assert.equal(await firstRecordedCwd(file), '/work/dự-án') })
})

test('session folder: a folder with an escaped quote is decoded', async () => {
  await withFile(line({ cwd: '/work/a"b' }), async file => { assert.equal(await firstRecordedCwd(file), '/work/a"b') })
})

test('session folder: an empty file gives an empty folder', async () => {
  await withFile('', async file => { assert.equal(await firstRecordedCwd(file), '') })
})

test('session folder: a missing file is an error', async () => {
  await assert.rejects(firstRecordedCwd('/no/such/session.jsonl'), /ENOENT/)
})

const longFile = (cwd) => {
  const filler = line({ type: 'x', text: 'a'.repeat(120_000) })
  const record = { type: 'user', sessionId: 'x', uuid: 'u', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'a question' } }
  return line(record) + filler + (cwd === undefined ? '' : line({ ...record, cwd })) + filler
}

async function withHome(id, text, check) {
  const home = await mkdtemp(join(tmpdir(), 'bridge-home-'))
  try {
    const folder = join(home, 'projects', '-work-app')
    await mkdir(folder, { recursive: true })
    const file = join(folder, `${id}.jsonl`)
    await writeFile(file, text)
    await check(home, file)
  } finally {
    await rm(home, { recursive: true })
  }
}

test('session list: a long session gets its folder from the middle of the file', async () => {
  await withHome('11111111-2222-4333-8444-000000000001', longFile('/deep/folder'), async (home) => {
    assert.equal((await listClaudeRows(10, home))[0].cwd, '/deep/folder')
  })
})

test('session list: a folder that the SDK reports is used as it is', async () => {
  const record = { type: 'user', sessionId: 'x', uuid: 'u', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'a question' }, cwd: '/near/start' }
  await withHome('11111111-2222-4333-8444-000000000002', line(record), async (home) => {
    assert.equal((await listClaudeRows(10, home))[0].cwd, '/near/start')
  })
})

test('session list: a found folder is kept, so that the file is not read again', async () => {
  await withHome('11111111-2222-4333-8444-000000000003', longFile('/kept/folder'), async (home, file) => {
    assert.equal((await listClaudeRows(10, home))[0].cwd, '/kept/folder')
    await writeFile(file, longFile(undefined))
    assert.equal((await listClaudeRows(10, home))[0].cwd, '/kept/folder')
  })
})

test('session list: a session with no folder has an empty folder, and it is read again later', async () => {
  await withHome('11111111-2222-4333-8444-000000000004', longFile(undefined), async (home, file) => {
    assert.equal((await listClaudeRows(10, home))[0].cwd, '')
    await writeFile(file, longFile('/later/folder'))
    assert.equal((await listClaudeRows(10, home))[0].cwd, '/later/folder')
  })
})
