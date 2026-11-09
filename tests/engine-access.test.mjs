import test from 'node:test'
import assert from 'node:assert/strict'
import { accessOf, accessQuestion, authorizeEngineCall, readsTrustedFile } from '../src/engine-access.ts'

const bash = { tool: 'Bash', input: { command: 'touch a.txt' } }
const edit = path => ({ tool: 'Edit', input: { file_path: path } })
const codexChange = paths => ({ tool: 'fileChange', input: { paths } })

test('engine access: Full access runs every call', () => {
  assert.equal(accessOf('danger-full-access', 'never', bash, '/work'), 'allow')
  assert.equal(accessOf('danger-full-access', 'never', edit('/etc/hosts'), '/work'), 'allow')
})

test('engine access: Read Only asks for commands and for every file change', () => {
  assert.equal(accessOf('read-only', 'ask', bash, '/work'), 'ask')
  assert.equal(accessOf('read-only', 'ask', edit('/work/a'), '/work'), 'ask')
  assert.equal(accessOf('read-only', 'ask', codexChange(['/work/a']), '/work'), 'ask')
})

test('engine access: Workspace Write allows a file change in the folder and asks for commands', () => {
  assert.equal(accessOf('workspace-write', 'ask', edit('/work/src/a.ts'), '/work'), 'allow')
  assert.equal(accessOf('workspace-write', 'ask', edit('src/a.ts'), '/work'), 'allow')
  assert.equal(accessOf('workspace-write', 'ask', { tool: 'NotebookEdit', input: { notebook_path: '/work/n.ipynb' } }, '/work'), 'allow')
  assert.equal(accessOf('workspace-write', 'ask', codexChange(['/work/a', '/work/b']), '/work'), 'allow')
  assert.equal(accessOf('workspace-write', 'ask', bash, '/work'), 'ask')
  assert.equal(accessOf('workspace-write', 'ask', { tool: 'command', input: { command: 'rm x' } }, '/work'), 'ask')
})

test('engine access: Workspace Write asks for a change outside the folder', () => {
  assert.equal(accessOf('workspace-write', 'ask', edit('/other/a'), '/work'), 'ask')
  assert.equal(accessOf('workspace-write', 'ask', edit('../a'), '/work'), 'ask')
  assert.equal(accessOf('workspace-write', 'ask', edit('/work-two/a'), '/work'), 'ask')
  assert.equal(accessOf('workspace-write', 'ask', codexChange(['/work/a', '/other/b']), '/work'), 'ask')
})

test('engine access: a call with no usable path asks', () => {
  assert.equal(accessOf('workspace-write', 'ask', { tool: 'Edit', input: {} }, '/work'), 'ask')
  assert.equal(accessOf('workspace-write', 'ask', { tool: 'Edit' }, '/work'), 'ask')
  assert.equal(accessOf('workspace-write', 'ask', codexChange([]), '/work'), 'ask')
  assert.equal(accessOf('workspace-write', 'ask', { tool: 'fileChange', input: { paths: 'x' } }, '/work'), 'ask')
})

test('engine access: an unknown permission level asks', () => {
  assert.equal(accessOf(undefined, 'ask', edit('/work/a'), '/work'), 'ask')
  assert.equal(accessOf('something-new', 'ask', edit('/work/a'), '/work'), 'ask')
})

test('engine access: the question names the command, the files or the tool', () => {
  assert.match(accessQuestion(bash), /touch a\.txt/)
  assert.match(accessQuestion(codexChange(['/a', '/b'])), /\/a, \/b/)
  assert.match(accessQuestion({ tool: 'WebFetch', input: {} }), /WebFetch/)
})

const services = (mode, answer) => {
  const asked = []
  return { asked, trustedFolder: '/handoffs', modeOf: () => mode, policyOf: () => mode === 'danger-full-access' ? 'never' : 'ask', ask: async (reason) => { asked.push(reason); if (answer instanceof Error) throw answer; return answer } }
}

test('engine access: an allowed call does not ask', async () => {
  const deps = services('danger-full-access', 'rejected')
  assert.equal(await authorizeEngineCall(deps, bash, '/work'), true)
  assert.deepEqual(deps.asked, [])
})

test('engine access: only an approval lets an asked call run', async () => {
  for (const [answer, expected] of [['allowed-once', true], ['rejected', false], ['cancelled', false], ['unavailable', false]]) {
    const deps = services('read-only', answer)
    assert.equal(await authorizeEngineCall(deps, bash, '/work'), expected, answer)
    assert.equal(deps.asked.length, 1)
  }
})

test('engine access: a failed approval refuses the call', async (context) => {
  context.mock.method(console, 'warn', () => {})
  assert.equal(await authorizeEngineCall(services('read-only', new Error('no open turn')), bash, '/work'), false)
})

test('engine access: the Auto level sends every call to the reviewer', () => {
  assert.equal(accessOf('danger-full-access', 'ask', bash, '/work'), 'ask')
  assert.equal(accessOf('danger-full-access', undefined, bash, '/work'), 'ask')
})

test('engine access: a failed read of the permission level refuses the call', async (context) => {
  context.mock.method(console, 'warn', () => {})
  const deps = { trustedFolder: '/handoffs', modeOf: () => { throw new Error('no session') }, policyOf: () => 'ask', ask: async () => 'allowed-once' }
  assert.equal(await authorizeEngineCall(deps, bash, '/work'), false)
})

const command = text => ({ tool: 'command', input: { command: text } })

test('engine access: a plain read of a handoff file runs with no question', () => {
  assert.equal(readsTrustedFile(command("/bin/zsh -lc 'tail -n +3 /handoffs/a.md'"), '/handoffs'), true)
  assert.equal(readsTrustedFile(command("/bin/bash -lc 'cat /handoffs/a.md'"), '/handoffs'), true)
  assert.equal(readsTrustedFile(command('sed -n 3,40p /handoffs/a.md'), '/handoffs'), true)
  assert.equal(readsTrustedFile({ tool: 'Bash', input: { command: 'head -n 5 /handoffs/a.md' } }, '/handoffs'), true)
  assert.equal(readsTrustedFile({ tool: 'Read', input: { file_path: '/handoffs/a.md' } }, '/handoffs'), true)
})

test('engine access: anything more than a plain read of a handoff file is not trusted', () => {
  for (const text of [
    "/bin/zsh -lc 'tail /handoffs/a.md; rm -rf /x'",
    'cat /handoffs/a.md && touch /x',
    'cat /handoffs/a.md | sh',
    'cat /handoffs/a.md > /x',
    'cat $(touch /x) /handoffs/a.md',
    'cat `touch /x` /handoffs/a.md',
    'cat /handoffs/a.md /etc/passwd',
    'cat /handoffs/../secret',
    'cat relative.md',
    'rm /handoffs/a.md',
    'cp /handoffs/a.md /x',
    "sed -i s/a/b/ /handoffs/a.md",
  ]) assert.equal(readsTrustedFile(command(text), '/handoffs'), false, text)
  assert.equal(readsTrustedFile({ tool: 'Read', input: { file_path: '/etc/passwd' } }, '/handoffs'), false)
  assert.equal(readsTrustedFile({ tool: 'Read', input: { file_path: 'a.md' } }, '/handoffs'), false)
  assert.equal(readsTrustedFile({ tool: 'Write', input: { file_path: '/handoffs/a.md' } }, '/handoffs'), false)
})

test('engine access: Read Only reads a handoff file with no question', async () => {
  const deps = services('read-only', 'rejected')
  assert.equal(await authorizeEngineCall(deps, command("/bin/zsh -lc 'tail -n +3 /handoffs/a.md'"), '/work'), true)
  assert.deepEqual(deps.asked, [])
})
