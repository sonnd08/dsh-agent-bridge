import test from 'node:test'
import assert from 'node:assert/strict'
import { activeLine, foldToolRuns, runTitle, shortToolName, summarizeTool, toolLine } from '../src/client/tool-runs.ts'

const t = (key, values) => {
  const words = {
    'tools.comma': ', ', 'tools.prCreated': 'Created PR #{n}', 'tools.prMerged': 'Merged PR #{n}', 'tools.committed': 'Committed', 'tools.pushed': 'Pushed', 'tools.more': '{title} and more',
    'tools.kind.command': 'Ran commands', 'tools.kind.edit': 'Edited files', 'tools.kind.read': 'Read files', 'tools.kind.search': 'Searched', 'tools.kind.web': 'Browsed the web', 'tools.kind.agent': 'Ran agents', 'tools.kind.other': 'Used tools',
  }
  return Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), words[key])
}
const tool = (name, args = {}, resultText = 'ok', isError = false, input = '{}') => ({ kind: 'tool', use: { type: 'tool_use', name, input, args }, result: { type: 'tool_result', text: resultText, ...isError ? { isError } : {} } })
const assistant = (id, ...items) => ({ id, role: 'assistant', items })
const user = (id, text) => ({ id, role: 'user', items: [{ kind: 'text', text }] })
const say = text => ({ kind: 'text', text })
const bash = (command, resultText, isError) => tool('Bash', { command }, resultText, isError)

test('tool runs: a run crosses messages and text splits it', () => {
  const folded = foldToolRuns([user('u', 'go'), assistant('a', tool('Read', { file_path: 'a' })), assistant('b', tool('Edit', { file_path: 'a' })), assistant('c', say('done')), assistant('d', tool('Read', { file_path: 'b' }), tool('Read', { file_path: 'c' }))])
  assert.deepEqual(folded.map(message => message.id), ['u', 'a', 'c', 'd'])
  assert.equal(folded[1].items[0].kind, 'run')
  assert.equal(folded[1].items[0].items.length, 2)
  assert.equal(folded[2].items[0].kind, 'text')
  assert.equal(folded[3].items[0].kind, 'run')
})

test('tool runs: one plain call, or thinking alone, stays an ordinary row', () => {
  assert.equal(foldToolRuns([assistant('a', tool('Read', { file_path: 'a' }))])[0].items[0].kind, 'tool')
  assert.equal(foldToolRuns([assistant('a', { kind: 'thinking', text: 'x' })])[0].items[0].kind, 'thinking')
})

test('tool runs: internal calls are hidden unless they fail', () => {
  assert.deepEqual(foldToolRuns([assistant('a', tool('mcp__ccd_turn__update_plan')), assistant('b', tool('ToolSearch'))]), [])
  assert.equal(foldToolRuns([assistant('a', tool('mcp__ccd_turn__wrap_up', {}, 'bad', true))])[0].items[0].kind, 'tool')
})

test('tool runs: a user message and a provider switch end a run', () => {
  const folded = foldToolRuns([assistant('a', tool('Read'), tool('Grep')), user('u', 'next'), assistant('b', tool('Read')), { ...assistant('c', tool('Read')), switchedTo: 'codex' }])
  assert.deepEqual(folded.map(message => message.id), ['a', 'u', 'b', 'c'])
})

test('tool runs: a command with a result gets a run of its own title', () => {
  const folded = foldToolRuns([assistant('a', bash('git add . && gh pr create --fill', 'https://github.com/o/r/pull/2'))])
  assert.equal(folded[0].items[0].kind, 'run')
  assert.equal(runTitle(folded[0].items[0].items, t), 'Created PR #2')
})

test('tool runs: a pull request replaces commit and push, and a failed command names nothing', () => {
  assert.equal(runTitle([bash('git commit -m x'), bash('git push'), bash('gh pr merge 7 --squash')], t), 'Merged PR #7')
  assert.equal(runTitle([bash('git commit -m x'), bash('git push')], t), 'Committed, Pushed')
  assert.equal(runTitle([bash('git push', 'rejected', true), bash('ls')], t), 'Ran commands')
  assert.equal(runTitle([bash('git -C "/a b" commit -m x && git -C /c push')], t), 'Committed, Pushed')
})

test('tool runs: the title names the largest kinds of work first', () => {
  assert.equal(runTitle([tool('Read'), tool('Read'), tool('Edit')], t), 'Read files, edited files')
  assert.equal(runTitle([tool('Read'), tool('Read'), tool('Edit'), tool('Edit'), tool('Bash'), tool('Grep')], t), 'Read files, edited files, ran commands and more')
  assert.equal(runTitle([tool('mcp__a__b')], t), 'Used tools')
})

test('tool rows: short names, no raw JSON, and the newest call while working', () => {
  assert.equal(shortToolName('mcp__ccd_turn__update_plan'), 'update_plan')
  assert.equal(shortToolName('Read'), 'Read')
  assert.equal(shortToolName('command'), 'Bash')
  assert.equal(summarizeTool('mcp__x__y', {}, '{"items":[1]}'), '')
  assert.equal(summarizeTool('Bash', { description: 'List files', command: 'ls' }, 'ls'), 'List files')
  assert.equal(summarizeTool('app_click', { action_summary: 'Opens the menu' }, '{}'), 'Opens the menu')
  assert.equal(toolLine(tool('mcp__x__y', {}, 'ok', false, '{"a":1}')), 'y')
  assert.equal(activeLine([tool('Read', { file_path: 'a' }), { kind: 'thinking', text: 'x' }, tool('Grep', { pattern: 'b' })]), 'Grep  b')
})
