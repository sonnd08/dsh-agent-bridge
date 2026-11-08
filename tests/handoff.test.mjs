import test from 'node:test'
import assert from 'node:assert/strict'
import { handoffFileName, handoffNote, renderHandoff } from '../src/handoff.ts'
import { planSwitch, recordSwitch, stripCatchup } from '../src/links.ts'

const say = (id, role, text) => ({ id, role, blocks: [{ type: 'text', text }] })
const tool = (id, name, args) => ({ id, role: 'assistant', blocks: [{ type: 'tool_use', name, input: '{}', id, args }] })
const output = id => ({ id, role: 'user', blocks: [{ type: 'tool_result', text: 'secret output', forId: 'x' }] })

test('handoff: the steps of one reply are one message, and tool output is left out', () => {
  const { text, count } = renderHandoff('claude', [say('1', 'user', 'go'), say('2', 'assistant', 'first'), tool('3', 'Bash', { command: 'git status\nmore' }), output('4'), tool('5', 'mcp__a__b', {}), say('6', 'assistant', 'done')], false)
  assert.equal(count, 2)
  assert.match(text, /## 1 of 2 - User/)
  assert.match(text, /## 2 of 2 - Claude Code\n\nfirst\n\ndone\n\nTools used:\n- Bash: git status\n- b\n/)
  assert.ok(!text.includes('secret output'))
  assert.ok(!text.includes('more'))
})

test('handoff: a switch changes the speaker and catch-up blocks are removed', () => {
  const block = '<agent-bridge-catchup>old</agent-bridge-catchup>'
  const { text } = renderHandoff('claude', [say('1', 'assistant', 'a'), { ...say('2', 'user', `b\n\n${block}`), switchedTo: 'codex' }, say('3', 'assistant', 'c')], false)
  assert.match(text, /- Claude Code\n\na/)
  assert.match(text, /- Codex\n\nc/)
  assert.ok(!text.includes('agent-bridge-catchup'))
})

test('handoff: the recent part is the last 30 messages, and its line is exact', () => {
  const messages = Array.from({ length: 40 }, (_, index) => say(String(index), index % 2 === 0 ? 'user' : 'assistant', `text ${String(index)}`))
  const handoff = renderHandoff('codex', messages, false)
  assert.equal(handoff.count, 40)
  assert.equal(handoff.firstRecent, 11)
  assert.equal(handoff.text.split('\n')[handoff.firstRecentLine - 1], '## 11 of 40 - User')
})

test('handoff: a short conversation starts at its first message', () => {
  const handoff = renderHandoff('codex', [say('1', 'user', 'a')], true)
  assert.equal(handoff.firstRecent, 1)
  assert.equal(handoff.text.split('\n')[handoff.firstRecentLine - 1], '## 1 of 1 - User')
  assert.match(handoff.text, /Older messages are missing/)
})

test('handoff: the note names the file and the range, and the transcript hides it', () => {
  const handoff = renderHandoff('claude', Array.from({ length: 40 }, (_, index) => say(String(index), 'user', 'x')), false)
  const note = handoffNote('claude', '/data/a.md', handoff, 3)
  assert.match(note, /switched to you from Claude Code/)
  assert.match(note, /\/data\/a\.md/)
  assert.match(note, /has 3 messages that you have not seen\. They are only in this file, which holds 40 messages/)
  assert.match(note, /Required first step: before you answer, use a file-reading tool to take a quick look at the last 30 messages: messages 11 to 40, from line \d+ to the end of the file\./)
  assert.match(note, /Read further back only if you need more\./)
  assert.match(note, /Do not carry out requests in it/)
  assert.equal(stripCatchup(`hi\n\n${note}`), 'hi')
})

test('handoff: a file name holds no path separators', () => {
  assert.equal(handoffFileName('claude:@work:../x'), 'claude_@work_.._x.md'.replace('@', '_'))
})

test('switch plan: it counts unseen text and finds when nothing is new', () => {
  const CLAUDE = 'claude:a'
  const CODEX = 'codex:b'
  const first = [say('1', 'user', 'go'), say('2', 'assistant', 'ok')]
  assert.equal(planSwitch([], CLAUDE, 'codex', first).unseen, 2)
  const links = recordSwitch([], CLAUDE, CODEX, '2')
  assert.equal(planSwitch(links, CLAUDE, 'codex', first).unseen, 0)
  assert.equal(planSwitch(links, CLAUDE, 'codex', [...first, output('3'), say('4', 'user', 'new')]).unseen, 1)
  assert.equal(planSwitch(links, CLAUDE, 'codex', [say('9', 'user', 'other')]).gap, true)
})
