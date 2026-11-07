import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseVersion, readAbout, VERIFIED } from '../src/about.ts'
import { aboutRows } from '../src/client/about.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const settings = { claudeExecutable: '/bin/claude', codexExecutable: '/bin/codex', piExecutable: 'pi', codexEnabled: true, piEnabled: false }

test('version lines of the three CLIs are read as plain versions', () => {
  assert.equal(parseVersion('2.1.319 (Claude Code)\n'), '2.1.319')
  assert.equal(parseVersion('codex-cli 0.165.0\n'), '0.165.0')
  assert.equal(parseVersion('1.4.0\n'), '1.4.0')
  assert.equal(parseVersion('v0.2.2-rc.1'), '0.2.2-rc.1')
})

test('the tab shows the plugin, dsh and each engine with whether its version was verified', async () => {
  const outputs = { '/bin/claude': `${VERIFIED.claude[0]} (Claude Code)\n`, '/bin/codex': 'codex-cli 9.9.9\n' }
  const run = async (executable) => {
    if (executable in outputs) return outputs[executable]
    throw new Error(`spawn ${executable} ENOENT\nmore detail`)
  }
  const about = await readAbout(settings, { DSH_CLIENT_VERSION: '0.2.2-rc.1' }, run)
  assert.equal(about.plugin, pkg.version)
  assert.equal(about.sdk, pkg.dependencies['@anthropic-ai/claude-agent-sdk'])
  const rows = aboutRows(about)
  assert.deepEqual(rows.map(row => [row.id, row.version, row.status]), [
    ['dsh', '0.2.2-rc.1', 'verified'],
    ['claude', VERIFIED.claude[0], 'verified'],
    ['codex', '9.9.9', 'unverified'],
    ['pi', undefined, 'off'],
  ])
  assert.equal(rows[1].executable, '/bin/claude')
  assert.equal(rows[3].error, 'spawn pi ENOENT', 'only the first line of a start error is shown')
  assert.deepEqual(rows[2].verified, VERIFIED.codex)
})

test('an enabled engine that cannot start reads as not found, and an unreported dsh version as unknown', async () => {
  const about = await readAbout({ ...settings, piEnabled: true }, {}, async () => { throw new Error('spawn ENOENT') })
  const rows = aboutRows(about)
  assert.equal(about.dsh, undefined)
  assert.deepEqual(rows.map(row => row.status), ['unknown', 'missing', 'missing', 'missing'])
})

test('dsh web, which sets no version variable, reports the version of the dsh-desktop-host package it started from', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { dshVersion } = await import('../src/about.ts')
  const root = mkdtempSync(`${tmpdir()}/about-`)
  const host = `${root}/node_modules/@deepseek-ai/dsh-desktop-host`
  mkdirSync(`${host}/lib`, { recursive: true })
  writeFileSync(`${host}/package.json`, JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host', version: '0.2.2-rc.1' }))
  assert.equal(dshVersion({}, ['node', `${host}/lib/cli.js`, 'web']), '0.2.2-rc.1')
  assert.equal(dshVersion({ DSH_CLIENT_VERSION: '0.3.0' }, ['node', `${host}/lib/cli.js`]), '0.3.0', 'the variable wins')
  assert.equal(dshVersion({}, ['node', '/elsewhere/server.js']), undefined)
  assert.equal(dshVersion({}, ['node', `${root}/dsh-desktop-host-missing/lib/cli.js`]), undefined)
})
