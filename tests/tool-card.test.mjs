import test from 'node:test'
import assert from 'node:assert/strict'

const { render, click, act, byTestId, allByTestId, t, React } = await import('./support/dom.mjs')
const { DiffText, Markdown, Thinking, Todos, ToolCard, ToolRunRow } = await import('../src/client/ToolCard.tsx')
const { foldToolRuns } = await import('../src/client/tool-runs.ts')

test.afterEach(() => { document.body.replaceChildren() })

const use = (name, args = undefined, input = '') => ({ type: 'tool_use', name, input, ...args === undefined ? {} : { args } })
const result = (text, extra = {}) => ({ type: 'tool_result', text, ...extra })
const tool = (toolUse, toolResult) => ({ kind: 'tool', use: toolUse, result: toolResult })
const card = (item, running = false) => React.createElement(ToolCard, { item, t, running })
const runRow = (items, { running = false, active = false } = {}) => React.createElement(ToolRunRow, { run: { kind: 'run', id: 'run-1', items }, t, running, active })

const headerOf = element => element.querySelector('[data-disclosure-row]')
const toggle = element => click(headerOf(element))
const cardEl = () => byTestId('ext-tool-use')
const isOpen = element => headerOf(element).getAttribute('aria-expanded') === 'true'

/** Render a card and open it. */
async function opened(item, running = false) {
  const view = await render(card(item, running))
  await toggle(cardEl())
  return view
}

// The state and title of one tool row

for (const [name, item, running, state] of [
  ['a call with no result in a running turn is ongoing', tool(use('Read', { file_path: '/a' })), true, 'ongoing'],
  ['a call with no result in a stopped turn is idle', tool(use('Read', { file_path: '/a' })), false, 'idle'],
  ['a call with a result is done', tool(use('Read', { file_path: '/a' }), result('ok')), true, 'done'],
  ['a failed call shows the error state', tool(use('Read', { file_path: '/a' }), result('no', { isError: true })), false, 'error'],
]) {
  test(`tool card: ${name}`, async () => {
    const view = await render(card(item, running))
    assert.equal(cardEl().dataset.state, state)
    await view.unmount()
  })
}

test('tool card: the row names the tool and what it worked on', async () => {
  const view = await render(card(tool(use('Read', { file_path: '/invented/file.txt' }), result('body'))))
  assert.equal(cardEl().dataset.tool, 'Read')
  assert.match(headerOf(cardEl()).textContent, /Read {2}\/invented\/file\.txt/)
  await view.unmount()
})

test('tool card: an MCP tool shows only its short name in the title', async () => {
  const view = await render(card(tool(use('mcp__invented__list_things', { query: 'needle' }), result('ok'))))
  assert.match(headerOf(cardEl()).textContent, /^list_things {2}needle/)
  await view.unmount()
})

test('tool card: raw JSON input is not used as a title', async () => {
  const view = await render(card(tool(use('Mystery', undefined, '{"a":1}'), result('ok'))))
  assert.doesNotMatch(headerOf(cardEl()).textContent, /"a"/)
  assert.match(headerOf(cardEl()).textContent, /Mystery/)
  await view.unmount()
})

test('tool card: only the first line of a long command is in the title', async () => {
  const view = await render(card(tool(use('Bash', { command: 'first-line\nsecond-line' }), result('ok'))))
  assert.match(headerOf(cardEl()).textContent, /first-line/)
  assert.doesNotMatch(headerOf(cardEl()).textContent, /second-line/)
  await view.unmount()
})

test('tool card: a result with no matching call shows its first line under a generic name', async () => {
  const view = await render(card(tool(undefined, result('first line\nmore'))))
  assert.equal(cardEl().dataset.tool, 'panel.toolResult')
  assert.match(headerOf(cardEl()).textContent, /panel\.toolResult {2}first line/)
  assert.doesNotMatch(headerOf(cardEl()).textContent, /more/)
  await view.unmount()
})

// Open and close

test('tool card: it starts folded and opens and closes on a click', async () => {
  const view = await render(card(tool(use('Mystery', undefined, 'input text'), result('output text'))))
  assert.equal(isOpen(cardEl()), false)
  assert.equal(byTestId('ext-tool-result'), null)
  await toggle(cardEl())
  assert.equal(isOpen(cardEl()), true)
  assert.equal(byTestId('ext-tool-result').textContent, 'output text')
  await toggle(cardEl())
  assert.equal(byTestId('ext-tool-result'), null)
  await view.unmount()
})

test('tool card: Enter on the row opens it', async () => {
  const view = await render(card(tool(use('Mystery', undefined, 'x'), result('output text'))))
  await act(() => { headerOf(cardEl()).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  assert.equal(byTestId('ext-tool-result').textContent, 'output text')
  await view.unmount()
})

// The body of each kind of tool

test('tool card: a shell command shows the command and its output', async () => {
  const view = await opened(tool(use('Bash', { command: 'invented-command --flag' }), result('invented output')))
  assert.match(cardEl().textContent, /invented-command --flag/)
  assert.match(cardEl().textContent, /invented output/)
  assert.doesNotMatch(cardEl().textContent, /block\.exitCode/)
  await view.unmount()
})

test('tool card: the Codex command tool draws the same terminal', async () => {
  const view = await opened(tool(use('command', { command: 'invented-command' }), result('codex output')))
  assert.match(cardEl().textContent, /invented-command/)
  assert.match(cardEl().textContent, /codex output/)
  assert.equal(byTestId('ext-tool-result'), null)
  await view.unmount()
})

test('tool card: a failed command shows exit code 1', async () => {
  const view = await opened(tool(use('Bash', { command: 'invented-command' }), result('bad', { isError: true })))
  assert.match(cardEl().textContent, /block\.exitCode \{"n":1\}/)
  assert.match(cardEl().textContent, /bad/)
  await view.unmount()
})

test('tool card: a command that has not finished shows no exit code', async () => {
  const view = await opened(tool(use('Bash', { command: 'invented-command' })), true)
  assert.match(cardEl().textContent, /invented-command/)
  assert.doesNotMatch(cardEl().textContent, /block\.exitCode/)
  await view.unmount()
})

test('tool card: a command call with no parsed arguments uses its input text', async () => {
  const view = await opened(tool(use('Bash', undefined, 'plain-input-command'), result('')))
  assert.match(cardEl().textContent, /plain-input-command/)
  await view.unmount()
})

test('tool card: very long command output is cut and can be expanded', async () => {
  const output = Array.from({ length: 200 }, (_, index) => `line-${index}`).join('\n')
  const view = await opened(tool(use('Bash', { command: 'invented-command' }), result(output)))
  assert.match(cardEl().textContent, /line-0(?!\d)/)
  assert.doesNotMatch(cardEl().textContent, /line-100(?!\d)/)
  assert.match(cardEl().textContent, /block\.expand/)
  await view.unmount()
})

test('tool card: Edit shows the file and the change', async () => {
  const view = await opened(tool(use('Edit', { file_path: '/invented/a.txt', old_string: 'old words', new_string: 'new words' }), result('ok')))
  assert.match(cardEl().textContent, /\/invented\/a\.txt/)
  assert.match(cardEl().textContent, /old words/)
  assert.match(cardEl().textContent, /new words/)
  await view.unmount()
})

test('tool card: Write shows the new text', async () => {
  const view = await opened(tool(use('Write', { file_path: '/invented/b.txt', content: 'fresh content' }), result('ok')))
  assert.match(cardEl().textContent, /\/invented\/b\.txt/)
  assert.match(cardEl().textContent, /fresh content/)
  await view.unmount()
})

test('tool card: MultiEdit shows every edit', async () => {
  const edits = [{ old_string: 'first old', new_string: 'first new' }, { old_string: 'second old', new_string: 'second new' }]
  const view = await opened(tool(use('MultiEdit', { file_path: '/invented/c.txt', edits }), result('ok')))
  for (const words of ['first old', 'first new', 'second old', 'second new']) assert.match(cardEl().textContent, new RegExp(words))
  await view.unmount()
})

test('tool card: a failed edit shows the reason below the change', async () => {
  const view = await opened(tool(use('Edit', { file_path: '/invented/a.txt', old_string: 'x', new_string: 'y' }), result('The text was not found.', { isError: true })))
  assert.match(cardEl().textContent, /The text was not found\./)
  await view.unmount()
})

test('tool card: the text of a successful edit result is not shown', async () => {
  const view = await opened(tool(use('Edit', { file_path: '/invented/a.txt', old_string: 'x', new_string: 'y' }), result('Applied without problems.')))
  assert.doesNotMatch(cardEl().textContent, /Applied without problems/)
  await view.unmount()
})

test('tool card: an edit call with no file path shows its plain input', async () => {
  const view = await opened(tool(use('Edit', { old_string: 'x' }, 'plain edit input'), result('some result')))
  assert.match(cardEl().textContent, /plain edit input/)
  assert.equal(byTestId('ext-tool-result').textContent, 'some result')
  await view.unmount()
})

test('tool card: MultiEdit with no list of edits shows its plain input', async () => {
  const view = await opened(tool(use('MultiEdit', { file_path: '/invented/a.txt' }, 'plain multi input'), result('r')))
  assert.match(cardEl().textContent, /plain multi input/)
  await view.unmount()
})

test('tool card: a Codex file change colors its added and removed lines', async () => {
  const view = await opened(tool(use('fileChange', undefined, 'x'), result('+added\n-removed\nplain')))
  const lines = [...cardEl().querySelectorAll('pre span')]
  assert.deepEqual(lines.map(line => [line.textContent.trim(), line.className]), [['+added', 'add'], ['-removed', 'del'], ['plain', '']])
  await view.unmount()
})

test('tool card: another tool shows its input and result', async () => {
  const view = await opened(tool(use('Mystery', undefined, 'mystery input'), result('mystery output')))
  assert.match(cardEl().textContent, /mystery input/)
  assert.equal(byTestId('ext-tool-result').textContent, 'mystery output')
  await view.unmount()
})

test('tool card: a tool with no output has no output block', async () => {
  const view = await opened(tool(use('Mystery', undefined, 'mystery input'), result('')))
  assert.equal(byTestId('ext-tool-result'), null)
  await view.unmount()
})

test('tool card: a result with no matching call shows only the result when open', async () => {
  const view = await opened(tool(undefined, result('lone result')))
  assert.equal(byTestId('ext-tool-result').textContent, 'lone result')
  assert.equal(cardEl().querySelectorAll('pre').length, 1)
  await view.unmount()
})

// Images

test('tool card: images of the result show without opening the row', async () => {
  const view = await render(card(tool(use('Read', { file_path: '/a.png' }), result('', { images: ['data:image/png;base64,AA', 'data:image/png;base64,BB'] }))))
  assert.deepEqual(allByTestId('ext-image').map(image => image.getAttribute('src')), ['data:image/png;base64,AA', 'data:image/png;base64,BB'])
  assert.equal(allByTestId('ext-image')[0].getAttribute('alt'), 'panel.image')
  await view.unmount()
})

test('tool card: a click zooms the picked image and a click closes the zoom', async () => {
  const view = await render(card(tool(use('Read', { file_path: '/a.png' }), result('', { images: ['data:image/png;base64,AA', 'data:image/png;base64,BB'] }))))
  assert.equal(byTestId('ext-zoom'), null)
  await click(allByTestId('ext-image')[1])
  assert.equal(byTestId('ext-zoom').querySelector('img').getAttribute('src'), 'data:image/png;base64,BB')
  await click(byTestId('ext-zoom'))
  assert.equal(byTestId('ext-zoom'), null)
  await view.unmount()
})

test('tool card: a result with no images has no thumbnails', async () => {
  const view = await render(card(tool(use('Read', { file_path: '/a' }), result('text'))))
  assert.deepEqual(allByTestId('ext-image'), [])
  await view.unmount()
})

// Smaller drawings

test('diff text: only lines that start with a plus or minus are colored', async () => {
  const view = await render(React.createElement(DiffText, { text: '+a\n-b\n c' }))
  assert.deepEqual([...view.host.querySelectorAll('span')].map(line => line.className), ['add', 'del', ''])
  await view.unmount()
})

test('todos: done items are checked and other items are not', async () => {
  const view = await render(React.createElement(Todos, { todos: [{ content: 'Done item', status: 'completed' }, { content: 'Running item', status: 'in_progress' }, { content: 'Waiting item', status: 'pending' }] }))
  assert.deepEqual([...byTestId('ext-todos').querySelectorAll('li')].map(item => [item.dataset.status, item.textContent]), [
    ['completed', '☑ Done item'], ['in_progress', '☐ Running item'], ['pending', '☐ Waiting item'],
  ])
  await view.unmount()
})

test('todos: an empty list draws no items', async () => {
  const view = await render(React.createElement(Todos, { todos: [] }))
  assert.equal(byTestId('ext-todos').querySelectorAll('li').length, 0)
  await view.unmount()
})

test('thinking: it is folded, and opens to the text', async () => {
  const view = await render(React.createElement(Thinking, { text: 'A private thought', t }))
  assert.match(byTestId('ext-thinking').textContent, /panel\.thinking/)
  assert.doesNotMatch(byTestId('ext-thinking').textContent, /A private thought/)
  await toggle(byTestId('ext-thinking'))
  assert.match(byTestId('ext-thinking').textContent, /A private thought/)
  await toggle(byTestId('ext-thinking'))
  assert.doesNotMatch(byTestId('ext-thinking').textContent, /A private thought/)
  await view.unmount()
})

test('markdown: it draws formatted text', async () => {
  const view = await render(React.createElement(Markdown, { text: 'Some **bold** words', t }))
  assert.equal(view.host.querySelector('strong').textContent, 'bold')
  await view.unmount()
})

// Folded tool rows

const runEl = () => byTestId('ext-tool-run')
const runHeader = () => headerOf(runEl()).textContent
const bash = (command, output = 'ok', extra = {}) => tool(use('Bash', { command }), result(output, extra))

test('folded row: it names a created pull request', async () => {
  const view = await render(runRow([bash('gh pr create --fill', 'https://invented.test/org/repo/pull/2')]))
  assert.match(runHeader(), /tools\.prCreated \{"n":"2"\}/)
  await view.unmount()
})

test('folded row: a pull request replaces commit and push in the title', async () => {
  const view = await render(runRow([bash('git commit -m x'), bash('git push'), bash('gh pr create --fill', 'https://invented.test/org/repo/pull/7')]))
  assert.match(runHeader(), /tools\.prCreated \{"n":"7"\}/)
  assert.doesNotMatch(runHeader(), /tools\.committed|tools\.pushed/)
  await view.unmount()
})

test('folded row: a failed pull request command is not named as a result', async () => {
  const view = await render(runRow([bash('gh pr create --fill', 'https://invented.test/org/repo/pull/2', { isError: true })]))
  assert.doesNotMatch(runHeader(), /tools\.prCreated/)
  assert.match(runHeader(), /tools\.kind\.command/)
  await view.unmount()
})

test('folded row: with no result to name, the title lists the largest kinds of work', async () => {
  const view = await render(runRow([bash('a'), bash('b'), tool(use('Read', { file_path: '/a' }), result('ok'))]))
  assert.match(runHeader(), /tools\.kind\.command.*tools\.kind\.read/)
  await view.unmount()
})

test('folded row: while the turn works on it the row shows the newest call', async () => {
  const view = await render(runRow([bash('older-command'), tool(use('Read', { file_path: '/invented/newest.txt' }))], { running: true, active: true }))
  assert.match(runHeader(), /\/invented\/newest\.txt/)
  assert.doesNotMatch(runHeader(), /tools\.kind/)
  await view.unmount()
})

test('folded row: a finished run shows the summary and not the newest call', async () => {
  const view = await render(runRow([bash('older-command'), tool(use('Read', { file_path: '/invented/newest.txt' }), result('ok'))]))
  assert.doesNotMatch(runHeader(), /newest\.txt/)
  await view.unmount()
})

test('folded row: it starts folded and opens to its calls, thinking and checklist in order', async () => {
  const items = [
    { kind: 'thinking', text: 'Thought text' },
    bash('invented-command'),
    { kind: 'todos', todos: [{ content: 'Listed item', status: 'pending' }] },
  ]
  const view = await render(runRow(items))
  assert.equal(allByTestId('ext-tool-use').length, 0)
  assert.equal(byTestId('ext-todos'), null, 'the checklist moves into the fold')
  await click(headerOf(runEl()))
  assert.deepEqual([...runEl().querySelectorAll('[data-testid="ext-thinking"],[data-testid="ext-tool-use"],[data-testid="ext-todos"]')].map(item => item.dataset.testid), ['ext-thinking', 'ext-tool-use', 'ext-todos'])
  await click(headerOf(runEl()))
  assert.equal(allByTestId('ext-tool-use').length, 0)
  await view.unmount()
})

test('folded row: a call inside it reports the running state of the turn', async () => {
  const items = [tool(use('Read', { file_path: '/a' })), tool(use('Read', { file_path: '/b' }))]
  const running = await render(runRow(items, { running: true, active: true }))
  await click(headerOf(runEl()))
  assert.deepEqual(allByTestId('ext-tool-use').map(item => item.dataset.state), ['ongoing', 'ongoing'])
  await running.unmount()
  const stopped = await render(runRow(items, { running: false, active: false }))
  await click(headerOf(runEl()))
  assert.deepEqual(allByTestId('ext-tool-use').map(item => item.dataset.state), ['idle', 'idle'])
  await stopped.unmount()
})

test('folded row: each call inside opens by itself', async () => {
  const view = await render(runRow([tool(use('One', undefined, 'first input'), result('first output')), tool(use('Two', undefined, 'second input'), result('second output'))]))
  await click(headerOf(runEl()))
  await toggle(allByTestId('ext-tool-use')[1])
  assert.deepEqual(allByTestId('ext-tool-result').map(item => item.textContent), ['second output'])
  await view.unmount()
})

// The rows that a transcript becomes

/** Draw the items of a message as the panel does. */
function drawn(messages, { running = false, active = false } = {}) {
  const folded = foldToolRuns(messages)
  return React.createElement('div', null, folded.flatMap(message => message.items.map((item, index) => {
    const key = `${message.id}:${index}`
    if (item.kind === 'run') return React.createElement(ToolRunRow, { key, run: item, t, running, active })
    if (item.kind === 'tool') return React.createElement(ToolCard, { key, item, t, running })
    if (item.kind === 'text') return React.createElement('p', { key, 'data-testid': 'text-row' }, item.text)
    return null
  })))
}
const assistant = (id, items) => ({ id, role: 'assistant', items })

test('transcript: one plain call stays an ordinary row', async () => {
  const view = await render(drawn([assistant('m1', [bash('only-command')])]))
  assert.equal(allByTestId('ext-tool-run').length, 0)
  assert.equal(allByTestId('ext-tool-use').length, 1)
  await view.unmount()
})

test('transcript: one call with a result to name is folded, so the row names the result', async () => {
  const view = await render(drawn([assistant('m1', [bash('gh pr create --fill', 'https://invented.test/org/repo/pull/5')])]))
  assert.match(runHeader(), /tools\.prCreated \{"n":"5"\}/)
  await view.unmount()
})

test('transcript: calls between two pieces of text are one row, and each side of a text is its own row', async () => {
  const view = await render(drawn([assistant('m1', [bash('a'), bash('b'), { kind: 'text', text: 'between' }, bash('c'), bash('d')])]))
  assert.equal(allByTestId('ext-tool-run').length, 2)
  assert.deepEqual(allByTestId('text-row').map(item => item.textContent), ['between'])
  await view.unmount()
})

test('transcript: a run crosses messages, because an engine writes each call as its own message', async () => {
  const view = await render(drawn([assistant('m1', [bash('a')]), assistant('m2', [bash('b')])]))
  assert.equal(allByTestId('ext-tool-run').length, 1)
  await click(headerOf(runEl()))
  assert.equal(allByTestId('ext-tool-use').length, 2)
  await view.unmount()
})

test('transcript: an internal call that worked is hidden', async () => {
  const view = await render(drawn([assistant('m1', [tool(use('ToolSearch', undefined, 'x'), result('ok')), tool(use('mcp__ccd_turn__update_plan', undefined, 'x'), result('ok')), { kind: 'text', text: 'after' }])]))
  assert.equal(allByTestId('ext-tool-use').length, 0)
  assert.equal(allByTestId('ext-tool-run').length, 0)
  assert.equal(allByTestId('text-row').length, 1)
  await view.unmount()
})

test('transcript: an internal call that failed is shown', async () => {
  const view = await render(drawn([assistant('m1', [tool(use('mcp__ccd_turn__wrap_up', undefined, 'x'), result('failed', { isError: true }))])]))
  assert.equal(allByTestId('ext-tool-use').length, 1)
  assert.equal(byTestId('ext-tool-use').dataset.state, 'error')
  await view.unmount()
})
