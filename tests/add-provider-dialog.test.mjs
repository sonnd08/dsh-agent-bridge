import test from 'node:test'
import assert from 'node:assert/strict'

const { render, click, act, byTestId, t, React } = await import('./support/dom.mjs')
const { AddProviderDialog } = await import('../src/client/AddProviderDialog.tsx')

test.afterEach(() => { document.body.replaceChildren() })

const setValue = (input, value) => act(() => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
})
const settle = () => act(() => new Promise((resolve) => { setTimeout(resolve, 0) }))
const buttonNamed = label => [...document.querySelectorAll('button')].find(item => item.textContent === label)
const swatch = label => document.querySelector(`button[aria-label="${label}"]`)
const next = () => click(byTestId('ext-add-provider-next'))
const save = () => byTestId('ext-add-provider-save')
const alertText = () => document.querySelector('[role="alert"]')?.textContent
const stepTexts = () => [...document.querySelectorAll('ol li')].map(item => item.textContent)

/** Render the dialog and record its calls; `answer` is what the add callback returns. */
async function open({ taken = [], answer = async () => undefined } = {}) {
  const added = []
  let closed = 0
  const view = await render(React.createElement(AddProviderDialog, {
    taken, t, onAdd: (instance) => { added.push(instance); return answer(instance) }, onClose: () => { closed += 1 },
  }))
  return { view, added, closed: () => closed }
}

/** Go to the last step and fill in the required home folder. */
async function toConfig(home = '~/.invented-home') {
  await next()
  await next()
  await setValue(byTestId('ext-add-provider-home'), home)
}

test('add provider: it starts on the first step with Codex selected', async () => {
  const { view } = await open()
  assert.deepEqual(stepTexts(), ['1providers.stepProvider', '2providers.stepIdentity', '3providers.stepConfig'])
  assert.equal(byTestId('ext-add-provider-codex').getAttribute('aria-pressed'), 'true')
  assert.equal(byTestId('ext-add-provider-claude').getAttribute('aria-pressed'), 'false')
  assert.equal(byTestId('ext-add-provider-label'), null)
  assert.equal(save(), null)
  assert.equal(buttonNamed('providers.back'), undefined)
  await view.unmount()
})

test('add provider: a finished step shows a check and Back returns to it', async () => {
  const { view } = await open()
  await next()
  assert.deepEqual(stepTexts(), ['✓providers.stepProvider', '2providers.stepIdentity', '3providers.stepConfig'])
  assert.notEqual(byTestId('ext-add-provider-label'), null)
  await next()
  assert.deepEqual(stepTexts(), ['✓providers.stepProvider', '✓providers.stepIdentity', '3providers.stepConfig'])
  assert.notEqual(save(), null)
  assert.equal(byTestId('ext-add-provider-next'), null, 'the last step has the add button instead of Next')
  await click(buttonNamed('providers.back'))
  assert.notEqual(byTestId('ext-add-provider-label'), null)
  await click(buttonNamed('providers.back'))
  assert.notEqual(byTestId('ext-add-provider-codex'), null)
  await view.unmount()
})

test('add provider: Cancel and the close button close the dialog and add nothing', async () => {
  const { view, added, closed } = await open()
  await click(buttonNamed('manage.cancel'))
  assert.equal(closed(), 1)
  await click(document.querySelector('button[aria-label="manage.cancel"]'))
  assert.equal(closed(), 2)
  assert.deepEqual(added, [])
  await view.unmount()
})

test('add provider: the label and id are filled in for the selected engine', async () => {
  const { view } = await open()
  await next()
  assert.equal(byTestId('ext-add-provider-label').value, 'Codex')
  assert.equal(byTestId('ext-add-provider-id').value, 'codex_2')
  await view.unmount()
})

test('add provider: the suggested id skips the ids in use', async () => {
  const { view } = await open({ taken: ['codex_2', 'codex_3', 'claude_4'] })
  await next()
  assert.equal(byTestId('ext-add-provider-id').value, 'codex_4')
  await view.unmount()
})

test('add provider: an id in use by the other engine does not move the suggestion', async () => {
  const { view } = await open({ taken: ['codex_2'] })
  await click(byTestId('ext-add-provider-claude'))
  await next()
  assert.equal(byTestId('ext-add-provider-id').value, 'claude_2')
  await view.unmount()
})

test('add provider: choosing Claude changes the suggested label, id and config fields', async () => {
  const { view } = await open()
  await click(byTestId('ext-add-provider-claude'))
  assert.equal(byTestId('ext-add-provider-claude').getAttribute('aria-pressed'), 'true')
  await next()
  assert.equal(byTestId('ext-add-provider-label').value, 'Claude')
  assert.equal(byTestId('ext-add-provider-id').value, 'claude_2')
  await next()
  assert.equal(byTestId('ext-add-provider-binary').placeholder, 'claude')
  assert.equal(byTestId('ext-add-provider-home').placeholder, '~/.claude-work')
  assert.match(document.body.textContent, /providers\.home \{"name":"CLAUDE_CONFIG_DIR"\}/)
  assert.match(document.body.textContent, /providers\.binaryHint \{"name":"Claude"\}/)
  await view.unmount()
})

test('add provider: the config fields of Codex name its own folder variable', async () => {
  const { view } = await open()
  await next()
  await next()
  assert.equal(byTestId('ext-add-provider-binary').placeholder, 'codex')
  assert.equal(byTestId('ext-add-provider-home').placeholder, '~/.codex-work')
  assert.match(document.body.textContent, /providers\.home \{"name":"CODEX_HOME"\}/)
  await view.unmount()
})

test('add provider: changing the engine drops the typed label and id', async () => {
  const { view } = await open()
  await next()
  await setValue(byTestId('ext-add-provider-label'), 'Invented label')
  await setValue(byTestId('ext-add-provider-id'), 'invented-id')
  await click(buttonNamed('providers.back'))
  await click(byTestId('ext-add-provider-claude'))
  await next()
  assert.equal(byTestId('ext-add-provider-label').value, 'Claude')
  assert.equal(byTestId('ext-add-provider-id').value, 'claude_2')
  await view.unmount()
})

test('add provider: an emptied label or id goes back to the suggestion', async () => {
  const { view, added } = await open({ taken: ['codex_2'] })
  await next()
  await setValue(byTestId('ext-add-provider-label'), 'Typed')
  await setValue(byTestId('ext-add-provider-label'), '')
  await setValue(byTestId('ext-add-provider-id'), 'typed')
  await setValue(byTestId('ext-add-provider-id'), '')
  assert.equal(byTestId('ext-add-provider-label').value, 'Codex')
  assert.equal(byTestId('ext-add-provider-id').value, 'codex_3')
  await next()
  await setValue(byTestId('ext-add-provider-home'), '~/.invented-home')
  await click(save())
  await settle()
  assert.equal(added[0].label, 'Codex')
  assert.equal(added[0].id, 'codex_3')
  await view.unmount()
})

test('add provider: typed values stay when the user goes back and forward', async () => {
  const { view } = await open()
  await next()
  await setValue(byTestId('ext-add-provider-label'), 'Invented label')
  await next()
  await setValue(byTestId('ext-add-provider-home'), '~/.invented-home')
  await setValue(byTestId('ext-add-provider-binary'), '/opt/invented/bin')
  await setValue(byTestId('ext-add-provider-args'), '--invented')
  await click(buttonNamed('providers.back'))
  assert.equal(byTestId('ext-add-provider-label').value, 'Invented label')
  await next()
  assert.equal(byTestId('ext-add-provider-home').value, '~/.invented-home')
  assert.equal(byTestId('ext-add-provider-binary').value, '/opt/invented/bin')
  assert.equal(byTestId('ext-add-provider-args').value, '--invented')
  await view.unmount()
})

test('add provider: the home folder is required, and white space does not count', async () => {
  const { view, added } = await open()
  await next()
  await next()
  assert.equal(save().disabled, true)
  await setValue(byTestId('ext-add-provider-home'), '   ')
  assert.equal(save().disabled, true)
  await click(save())
  assert.deepEqual(added, [])
  await setValue(byTestId('ext-add-provider-home'), '~/.invented-home')
  assert.equal(save().disabled, false)
  await view.unmount()
})

test('add provider: the binary and arguments are optional', async () => {
  const { view, added, closed } = await open()
  await toConfig()
  await click(save())
  await settle()
  assert.deepEqual(added, [{ id: 'codex_2', engine: 'codex', label: 'Codex', home: '~/.invented-home', binaryPath: '', launchArgs: '' }])
  assert.equal(closed(), 1)
  await view.unmount()
})

test('add provider: every field reaches the add call', async () => {
  const { view, added } = await open()
  await click(byTestId('ext-add-provider-claude'))
  await next()
  await setValue(byTestId('ext-add-provider-label'), 'Invented label')
  await setValue(byTestId('ext-add-provider-id'), 'invented-id')
  await click(swatch('#2fa866'))
  await next()
  await setValue(byTestId('ext-add-provider-binary'), '/opt/invented/claude')
  await setValue(byTestId('ext-add-provider-home'), '~/.invented-home')
  await setValue(byTestId('ext-add-provider-args'), '--flag value')
  await click(save())
  await settle()
  assert.deepEqual(added, [{ id: 'invented-id', engine: 'claude', label: 'Invented label', home: '~/.invented-home', binaryPath: '/opt/invented/claude', launchArgs: '--flag value', accent: '#2fa866' }])
  await view.unmount()
})

test('add provider: no accent is the default, and one color is pressed at a time', async () => {
  const { view } = await open()
  await next()
  assert.equal(swatch('providers.accentNone').getAttribute('aria-pressed'), 'true')
  await click(swatch('#4f7cff'))
  assert.equal(swatch('#4f7cff').getAttribute('aria-pressed'), 'true')
  assert.equal(swatch('providers.accentNone').getAttribute('aria-pressed'), 'false')
  await click(swatch('#e05d5d'))
  assert.equal(swatch('#4f7cff').getAttribute('aria-pressed'), 'false')
  assert.equal(swatch('#e05d5d').getAttribute('aria-pressed'), 'true')
  await view.unmount()
})

test('add provider: choosing no accent again sends no accent', async () => {
  const { view, added } = await open()
  await next()
  await click(swatch('#4f7cff'))
  await click(swatch('providers.accentNone'))
  await next()
  await setValue(byTestId('ext-add-provider-home'), '~/.invented-home')
  await click(save())
  await settle()
  assert.equal('accent' in added[0], false)
  await view.unmount()
})

test('add provider: while the add runs the button is off, so it cannot be sent twice', async () => {
  let finish
  const { view, added, closed } = await open({ answer: () => new Promise((resolve) => { finish = resolve }) })
  await toConfig()
  await click(save())
  assert.equal(save().disabled, true)
  await click(save())
  assert.equal(added.length, 1)
  assert.equal(closed(), 0)
  await act(() => { finish(undefined) })
  await settle()
  assert.equal(closed(), 1)
  await view.unmount()
})

test('add provider: a refusal is shown, the dialog stays and the button works again', async () => {
  const { view, added, closed } = await open({ answer: async () => 'The folder cannot be created.' })
  await toConfig()
  await click(save())
  await settle()
  assert.equal(alertText(), 'The folder cannot be created.')
  assert.equal(closed(), 0)
  assert.equal(save().disabled, false)
  assert.equal(added.length, 1)
  await view.unmount()
})

test('add provider: a thrown error shows its message', async () => {
  const { view, closed } = await open({ answer: async () => { throw new Error('network went away') } })
  await toConfig()
  await click(save())
  await settle()
  assert.equal(alertText(), 'network went away')
  assert.equal(closed(), 0)
  assert.equal(save().disabled, false)
  await view.unmount()
})

test('add provider: a rejection that is not an Error is shown as text', async () => {
  const { view } = await open({ answer: () => Promise.reject('plain reason') }) // eslint-disable-line prefer-promise-reject-errors
  await toConfig()
  await click(save())
  await settle()
  assert.equal(alertText(), 'plain reason')
  await view.unmount()
})

test('add provider: an id the user types is sent as typed, and a duplicate refused by the host can be corrected', async () => {
  const taken = ['invented-id']
  const answer = async instance => taken.includes(instance.id) ? 'This ID is already used.' : undefined
  const { view, added, closed } = await open({ taken, answer })
  await next()
  await setValue(byTestId('ext-add-provider-id'), 'invented-id')
  await next()
  await setValue(byTestId('ext-add-provider-home'), '~/.invented-home')
  await click(save())
  await settle()
  assert.equal(alertText(), 'This ID is already used.')
  assert.equal(closed(), 0)
  await click(buttonNamed('providers.back'))
  assert.equal(alertText(), undefined, 'going back removes the old error')
  await setValue(byTestId('ext-add-provider-id'), 'other-id')
  await next()
  await click(save())
  await settle()
  assert.deepEqual(added.map(item => item.id), ['invented-id', 'other-id'])
  assert.equal(closed(), 1)
  await view.unmount()
})

test('add provider: a second attempt removes the error of the first while it runs', async () => {
  const answers = ['first failure']
  let finish
  const { view } = await open({ answer: () => answers.length > 0 ? Promise.resolve(answers.shift()) : new Promise((resolve) => { finish = resolve }) })
  await toConfig()
  await click(save())
  await settle()
  assert.equal(alertText(), 'first failure')
  await click(save())
  assert.equal(alertText(), undefined)
  await act(() => { finish('second failure') })
  await settle()
  assert.equal(alertText(), 'second failure')
  await view.unmount()
})
