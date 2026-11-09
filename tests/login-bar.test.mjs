import test from 'node:test'
import assert from 'node:assert/strict'

const { render, click, byTestId, t, act, React } = await import('./support/dom.mjs')
const { LoginBar } = await import('../src/client/LoginBar.tsx')

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status })

let serial = 0
/** The store keeps its state at module level, so each test uses its own provider. */
const nextProvider = () => `claude@bar${String(++serial)}`
const LABEL = 'Test Provider'

function deferred() {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}

/** The bar polls while an attempt runs, so the timers of each test are fake. */
const clock = context => context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
const advance = (context, ms) => act(() => { context.mock.timers.tick(ms) })

function host(context, read, posted = () => reply({})) {
  const posts = []
  context.mock.method(globalThis, 'fetch', async (_url, init = {}) => {
    if (init.method !== 'POST') return reply(read)
    const body = JSON.parse(init.body)
    posts.push(body)
    return await posted(body)
  })
  return posts
}

const open = provider => render(React.createElement(LoginBar, { provider, label: LABEL, t }))
const bar = () => byTestId('ext-login-bar')
const name = JSON.stringify({ name: LABEL })

test('login notice: a signed-out provider gets a notice with a Sign in button', async (context) => {
  clock(context)
  host(context, { signedIn: false })
  const view = await open(nextProvider())
  assert.equal(bar().dataset.state, 'needed')
  assert.equal(bar().getAttribute('role'), 'alert')
  assert.match(bar().textContent, new RegExp(`login\\.needed ${name.replace(/[{}]/g, '\\$&')}`))
  assert.match(byTestId('ext-login-start').textContent, /login\.start/)
  assert.equal(byTestId('ext-login-cancel'), null)
  await view.unmount()
})

test('login notice: a signed-in provider shows nothing', async (context) => {
  clock(context)
  host(context, { signedIn: true })
  const view = await open(nextProvider())
  assert.equal(bar(), null)
  assert.equal(view.host.textContent, '')
  await view.unmount()
})

test('login notice: a state that is not known shows nothing', async (context) => {
  clock(context)
  host(context, {})
  const view = await open(nextProvider())
  assert.equal(bar(), null)
  await view.unmount()
})

test('login notice: nothing shows while the first read is on its way', async (context) => {
  clock(context)
  const answer = deferred()
  context.mock.method(globalThis, 'fetch', () => answer.promise)
  const view = await open(nextProvider())
  assert.equal(bar(), null)
  await act(async () => { answer.resolve(reply({ signedIn: false })); await answer.promise })
  assert.equal(bar().dataset.state, 'needed')
  await view.unmount()
})

test('login notice: a read that fails shows no notice', async (context) => {
  clock(context)
  context.mock.method(console, 'warn', () => {})
  context.mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
  const view = await open(nextProvider())
  assert.equal(bar(), null)
  await view.unmount()
})

test('login notice: Sign in sends the request and shows the waiting state at once', async (context) => {
  clock(context)
  const answer = deferred()
  const posts = host(context, { signedIn: false }, () => answer.promise)
  const view = await open('claude@start')
  await click(byTestId('ext-login-start'))
  assert.deepEqual(posts, [{ engine: 'claude', action: 'start', instance: 'start' }])
  assert.equal(bar().dataset.state, 'running')
  assert.equal(byTestId('ext-login-start'), null)
  await act(async () => { answer.resolve(reply({ flow: { state: 'running' } })); await answer.promise })
  await view.unmount()
})

test('login notice: a running attempt with no page has only Cancel', async (context) => {
  clock(context)
  host(context, { flow: { state: 'running' } })
  const view = await open(nextProvider())
  assert.equal(bar().dataset.state, 'running')
  assert.equal(bar().getAttribute('role'), 'status')
  assert.match(bar().textContent, /login\.waiting/)
  assert.equal(byTestId('ext-login-open'), null)
  assert.match(byTestId('ext-login-cancel').textContent, /login\.cancel/)
  await view.unmount()
})

test('login notice: a running attempt with a page links to it in a new tab', async (context) => {
  clock(context)
  host(context, { flow: { state: 'running', url: 'https://signin.example.test/device' } })
  const view = await open(nextProvider())
  const link = byTestId('ext-login-open')
  assert.equal(link.getAttribute('href'), 'https://signin.example.test/device')
  assert.equal(link.getAttribute('target'), '_blank')
  assert.equal(link.getAttribute('rel'), 'noreferrer')
  assert.match(link.textContent, /login\.openPage/)
  assert.notEqual(byTestId('ext-login-cancel'), null)
  await view.unmount()
})

test('login notice: a running attempt hides the signed-out text, also when the provider is signed in', async (context) => {
  clock(context)
  host(context, { signedIn: true, flow: { state: 'running' } })
  const view = await open(nextProvider())
  assert.equal(bar().dataset.state, 'running')
  await view.unmount()
})

test('login notice: Cancel sends the request and returns to the signed-out notice', async (context) => {
  clock(context)
  const posts = host(context, { signedIn: false }, body => reply(body.action === 'start' ? { flow: { state: 'running' } } : { signedIn: false }))
  const view = await open('codex@cancel')
  await click(byTestId('ext-login-start'))
  await click(byTestId('ext-login-cancel'))
  assert.deepEqual(posts[1], { engine: 'codex', action: 'cancel', instance: 'cancel' })
  assert.equal(bar().dataset.state, 'needed')
  assert.equal(byTestId('ext-login-cancel'), null)
  await view.unmount()
})

test('login notice: a success shows the done text, then the notice goes away', async (context) => {
  clock(context)
  host(context, { signedIn: true, flow: { state: 'succeeded' } })
  const view = await open(nextProvider())
  assert.equal(bar().dataset.state, 'done')
  assert.equal(bar().getAttribute('role'), 'status')
  assert.match(bar().textContent, /login\.done/)
  assert.equal(byTestId('ext-login-cancel'), null)
  assert.equal(byTestId('ext-login-start'), null)
  await advance(context, 8_000)
  assert.equal(bar(), null)
  await view.unmount()
})

test('login notice: an attempt that fails shows the error and Sign in again', async (context) => {
  clock(context)
  host(context, { signedIn: false, flow: { state: 'failed', error: 'The browser was closed.' } })
  const view = await open(nextProvider())
  assert.equal(bar().dataset.state, 'needed')
  assert.match(bar().textContent, /login\.failed/)
  assert.match(bar().textContent, /The browser was closed\./)
  assert.notEqual(byTestId('ext-login-start'), null)
  await view.unmount()
})

test('login notice: a failed attempt with no error text shows the signed-out text', async (context) => {
  clock(context)
  host(context, { signedIn: false, flow: { state: 'failed' } })
  const view = await open(nextProvider())
  assert.match(bar().textContent, /login\.needed/)
  assert.doesNotMatch(bar().textContent, /login\.failed/)
  await view.unmount()
})

test('login notice: a second try removes the earlier error', async (context) => {
  clock(context)
  host(context, { signedIn: false, flow: { state: 'failed', error: 'The browser was closed.' } }, () => reply({ flow: { state: 'running' } }))
  const view = await open(nextProvider())
  await click(byTestId('ext-login-start'))
  assert.equal(bar().dataset.state, 'running')
  assert.doesNotMatch(bar().textContent, /The browser was closed\./)
  await view.unmount()
})

test('login notice: a start that the host refuses shows the reason and offers Sign in again', async (context) => {
  clock(context)
  host(context, { signedIn: false }, () => reply({ error: 'The sign-in command is missing.' }, 500))
  const view = await open(nextProvider())
  await click(byTestId('ext-login-start'))
  assert.equal(bar().dataset.state, 'needed')
  assert.match(bar().textContent, /The sign-in command is missing\./)
  assert.notEqual(byTestId('ext-login-start'), null)
  await view.unmount()
})

test('login notice: a failed attempt of a provider that is signed in shows nothing', async (context) => {
  clock(context)
  host(context, { signedIn: true, flow: { state: 'failed', error: 'Old problem.' } })
  const view = await open(nextProvider())
  assert.equal(bar(), null)
  await view.unmount()
})

test('login notice: a failed attempt with an unknown state shows nothing', async (context) => {
  clock(context)
  host(context, { flow: { state: 'failed', error: 'Old problem.' } })
  const view = await open(nextProvider())
  assert.equal(bar(), null)
  await view.unmount()
})

test('login notice: another provider has its own notice', async (context) => {
  clock(context)
  context.mock.method(globalThis, 'fetch', async url => reply({ signedIn: !String(url).includes('instance=out') }))
  const signedOut = await open('claude@out')
  assert.equal(bar().dataset.state, 'needed')
  await signedOut.unmount()
  const signedIn = await open('claude@in')
  assert.equal(bar(), null)
  await signedIn.unmount()
})
