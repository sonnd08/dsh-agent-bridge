import test from 'node:test'
import assert from 'node:assert/strict'

const { render, act, React } = await import('./support/dom.mjs')

const LOGIN = '/api/agent-bridge/login'
const RUNNING = { state: 'running' }
const SUCCEEDED = { state: 'succeeded' }
const FAILED = { state: 'failed', error: 'The command stopped.' }

let serial = 0
/** Each test gets its own copy of the store, which keeps its state at module level. */
const loadStore = async () => await import(`../src/client/login-store.ts?test=${String(++serial)}`)

const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

/** A promise that the test settles. */
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Replace fetch. `respond` gets each call and its 1-based number, and returns the response. */
function host(context, respond) {
  const calls = []
  context.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', credentials: init.credentials, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) }
    calls.push(call)
    return await respond(call, calls.length)
  })
  return { calls, reads: () => calls.filter(call => call.method === 'GET').length, posts: () => calls.filter(call => call.method === 'POST') }
}

/** Answers the reads in order and repeats the last one; answers a POST with `posted`. */
function sequence(context, answers, posted = {}) {
  let index = 0
  return host(context, (call) => {
    if (call.method === 'POST') return reply(posted)
    const answer = answers[Math.min(index, answers.length - 1)]
    index += 1
    if (answer instanceof Error) throw answer
    return answer instanceof Response ? answer : reply(answer)
  })
}

const clock = context => context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
const advance = (context, ms) => act(() => { context.mock.timers.tick(ms) })

/** Mount a component that uses the hook, and read what it returns. An empty list reads nothing and still sees every provider. */
async function probe(store, providers = []) {
  const seen = { logins: undefined, renders: 0 }
  function Probe({ list }) {
    seen.logins = store.useLogins(list)
    seen.renders += 1
    return null
  }
  const view = await render(React.createElement(Probe, { list: providers }))
  return { seen, unmount: view.unmount, change: list => view.update(React.createElement(Probe, { list })) }
}

const refresh = (store, provider = 'claude', force = true) => act(() => store.refreshLogin(provider, force))

test('login state: a read asks the host about the engine of a default provider', async (context) => {
  clock(context)
  const fake = sequence(context, [{ signedIn: true }])
  const store = await loadStore()
  await refresh(store, 'codex')
  assert.equal(fake.calls[0].url, `${LOGIN}?engine=codex`)
  assert.equal(fake.calls[0].credentials, 'same-origin')
})

test('login state: a read of an added instance names the engine and the instance', async (context) => {
  clock(context)
  const fake = sequence(context, [{ signedIn: true }])
  const store = await loadStore()
  await refresh(store, 'claude@work')
  assert.equal(fake.calls[0].url, `${LOGIN}?engine=claude&instance=work`)
})

test('login state: an answer with no sign-in state keeps the known state and plan', async (context) => {
  clock(context)
  sequence(context, [{ signedIn: true, plan: 'team' }, {}])
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  assert.deepEqual(seen.logins.claude, { signedIn: true, plan: 'team' })
  await refresh(store)
  assert.deepEqual(seen.logins.claude, { signedIn: true, plan: 'team' })
  await unmount()
})

test('login state: a later answer replaces the sign-in state', async (context) => {
  clock(context)
  sequence(context, [{ signedIn: true, plan: 'team' }, { signedIn: false, plan: 'free' }])
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  await refresh(store)
  assert.deepEqual(seen.logins.claude, { signedIn: false, plan: 'free' })
  await unmount()
})

test('login state: an empty answer stays empty, so the state is not known', async (context) => {
  clock(context)
  sequence(context, [{}])
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  assert.deepEqual(seen.logins.claude, {})
  await unmount()
})

test('login state: providers do not share their state', async (context) => {
  clock(context)
  host(context, call => reply({ signedIn: call.url.includes('codex') }))
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store, 'codex')
  await refresh(store, 'claude')
  assert.equal(seen.logins.codex.signedIn, true)
  assert.equal(seen.logins.claude.signedIn, false)
  await unmount()
})

test('login state: a failed attempt stays after the host reports it once', async (context) => {
  clock(context)
  sequence(context, [{ signedIn: false, flow: FAILED }, { signedIn: false }])
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  await refresh(store)
  assert.deepEqual(seen.logins.claude, { signedIn: false, flow: FAILED })
  await advance(context, 120_000)
  assert.deepEqual(seen.logins.claude.flow, FAILED)
  await unmount()
})

test('login state: an attempt that stops being reported while it runs goes away', async (context) => {
  clock(context)
  sequence(context, [{ flow: RUNNING }, { signedIn: false }])
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  assert.equal(seen.logins.claude.flow.state, 'running')
  await refresh(store)
  assert.deepEqual(seen.logins.claude, { signedIn: false })
  await unmount()
})

test('login state: a new report replaces the finished attempt', async (context) => {
  clock(context)
  sequence(context, [{ flow: FAILED }, { flow: { state: 'failed', error: 'A second problem.' } }])
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  await refresh(store)
  assert.equal(seen.logins.claude.flow.error, 'A second problem.')
  await unmount()
})

test('login polling: an attempt that runs is read every 1.5 s until it finishes', async (context) => {
  clock(context)
  const page = 'https://signin.example.test/start'
  const fake = sequence(context, [{ flow: { state: 'running', url: page } }, { flow: { state: 'running', url: page } }, { signedIn: true, flow: SUCCEEDED }], { flow: RUNNING })
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await act(() => store.startLogin('claude'))
  assert.equal(fake.reads(), 0)
  await advance(context, 1_499)
  assert.equal(fake.reads(), 0)
  await advance(context, 1)
  assert.equal(fake.reads(), 1)
  assert.equal(seen.logins.claude.flow.url, page)
  await advance(context, 1_500)
  assert.equal(fake.reads(), 2)
  await advance(context, 1_500)
  assert.equal(fake.reads(), 3)
  assert.equal(seen.logins.claude.flow.state, 'succeeded')
  await advance(context, 6_000)
  assert.equal(fake.reads(), 3, 'a finished attempt is not read again')
  await unmount()
})

test('login polling: several answers that say running keep one poll', async (context) => {
  clock(context)
  const fake = sequence(context, [{ flow: RUNNING }])
  const store = await loadStore()
  await refresh(store)
  await advance(context, 100)
  await refresh(store)
  await advance(context, 100)
  await refresh(store)
  assert.equal(fake.reads(), 3)
  await advance(context, 1_300)
  assert.equal(fake.reads(), 4, 'the timers of the other answers did not fire')
})

test('login polling: a read that is refused while an attempt runs keeps the waiting state', async (context) => {
  clock(context)
  context.mock.method(console, 'warn', () => {})
  sequence(context, [{ flow: RUNNING }, new Response('', { status: 500 })])
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  await advance(context, 1_500)
  assert.equal(seen.logins.claude.flow.state, 'running')
  await unmount()
})

test('login polling: the 30 s check restarts the poll after a read fails', async (context) => {
  clock(context)
  context.mock.method(console, 'warn', () => {})
  const fake = sequence(context, [{ flow: RUNNING }, new Error('offline'), { flow: RUNNING }, { signedIn: true, flow: SUCCEEDED }])
  const store = await loadStore()
  const { seen, unmount } = await probe(store, ['claude'])
  assert.equal(seen.logins.claude.flow.state, 'running')
  await advance(context, 1_500)
  assert.equal(fake.reads(), 2)
  await advance(context, 28_500)
  assert.equal(fake.reads(), 3)
  await advance(context, 1_500)
  assert.equal(seen.logins.claude.flow.state, 'succeeded')
  await unmount()
})

test('login success: the attempt goes away after 8 s and the sign-in state stays', async (context) => {
  clock(context)
  sequence(context, [{ signedIn: true, plan: 'team', flow: SUCCEEDED }])
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  assert.equal(seen.logins.claude.flow.state, 'succeeded')
  await advance(context, 7_999)
  assert.equal(seen.logins.claude.flow.state, 'succeeded')
  await advance(context, 1)
  assert.deepEqual(seen.logins.claude, { signedIn: true, plan: 'team' })
  await unmount()
})

test('login success: a read during the 8 s does not make the text go away early', async (context) => {
  clock(context)
  sequence(context, [{ signedIn: true, flow: SUCCEEDED }, { signedIn: true }])
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  await advance(context, 4_000)
  await refresh(store)
  assert.equal(seen.logins.claude.flow.state, 'succeeded')
  await advance(context, 4_000)
  assert.equal(seen.logins.claude.flow, undefined)
  await unmount()
})

test('login success: a new attempt that starts during the 8 s is not removed', async (context) => {
  clock(context)
  const fake = host(context, call => call.method === 'POST' || fake.reads() > 1 ? reply({ flow: RUNNING }) : reply({ signedIn: false, flow: SUCCEEDED }))
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  await advance(context, 2_000)
  await act(() => store.startLogin('claude'))
  await advance(context, 6_000)
  assert.equal(seen.logins.claude.flow.state, 'running')
  await unmount()
})

test('login start: the waiting state shows before the host answers, and an earlier error goes away', async (context) => {
  clock(context)
  const answer = deferred()
  const fake = host(context, call => call.method === 'POST' ? answer.promise : reply({ signedIn: false, flow: FAILED }))
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  let finished
  await act(() => { finished = store.startLogin('claude') })
  assert.deepEqual(seen.logins.claude, { signedIn: false, flow: RUNNING })
  assert.deepEqual(fake.posts()[0].body, { engine: 'claude', action: 'start' })
  assert.equal(fake.posts()[0].headers['content-type'], 'application/json')
  await act(async () => { answer.resolve(reply({ flow: RUNNING })); await finished })
  await unmount()
})

test('login start: the request of an added instance names it', async (context) => {
  clock(context)
  const fake = sequence(context, [{}], { flow: RUNNING })
  const store = await loadStore()
  await act(() => store.startLogin('codex@spare'))
  assert.deepEqual(fake.posts()[0].body, { engine: 'codex', action: 'start', instance: 'spare' })
})

test('login start: the page that the host reports is kept', async (context) => {
  clock(context)
  sequence(context, [{}], { flow: { state: 'running', url: 'https://signin.example.test/x' } })
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await act(() => store.startLogin('claude'))
  assert.equal(seen.logins.claude.flow.url, 'https://signin.example.test/x')
  await unmount()
})

for (const [name, answer, expected] of [
  ['the error text of the host', () => reply({ error: 'The sign-in command is missing.' }, 500), 'The sign-in command is missing.'],
  ['the HTTP status when the host gives no text', () => reply({}, 503), 'HTTP 503'],
]) {
  test(`login start: a refused start shows ${name}`, async (context) => {
    clock(context)
    host(context, call => call.method === 'POST' ? answer() : reply({ signedIn: false }))
    const store = await loadStore()
    const { seen, unmount } = await probe(store)
    await refresh(store)
    await act(() => store.startLogin('claude'))
    assert.deepEqual(seen.logins.claude, { signedIn: false, flow: { state: 'failed', error: expected } })
    await unmount()
  })
}

for (const [name, thrown, expected] of [['an error', new Error('network down'), 'network down'], ['a plain text', 'gone away', 'gone away']]) {
  test(`login start: a start that throws ${name} shows it and does not poll`, async (context) => {
    clock(context)
    const fake = host(context, () => { throw thrown })
    const store = await loadStore()
    const { seen, unmount } = await probe(store)
    await act(() => store.startLogin('claude'))
    assert.deepEqual(seen.logins.claude.flow, { state: 'failed', error: expected })
    await advance(context, 10_000)
    assert.equal(fake.reads(), 0)
    await unmount()
  })
}

test('login start: an answer that is not JSON still ends the attempt as failed', async (context) => {
  clock(context)
  host(context, () => reply('<html>Bad gateway</html>', 502))
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await act(() => store.startLogin('claude'))
  assert.equal(seen.logins.claude.flow.state, 'failed')
  assert.equal(typeof seen.logins.claude.flow.error, 'string')
  await unmount()
})

test('login cancel: the attempt goes away before the host answers and the sign-in state stays', async (context) => {
  clock(context)
  const answer = deferred()
  const fake = host(context, call => call.method === 'POST' ? answer.promise : reply({ signedIn: false, plan: 'team', flow: RUNNING }))
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  let finished
  await act(() => { finished = store.cancelLogin('claude') })
  assert.deepEqual(seen.logins.claude, { signedIn: false, plan: 'team' })
  assert.deepEqual(fake.posts()[0].body, { engine: 'claude', action: 'cancel' })
  await act(async () => { answer.resolve(reply({ signedIn: false })); await finished })
  assert.deepEqual(seen.logins.claude, { signedIn: false, plan: 'team' })
  await unmount()
})

test('login cancel: the poll that was waiting does not bring the attempt back', async (context) => {
  clock(context)
  const fake = sequence(context, [{ signedIn: false, flow: RUNNING }, { signedIn: false }], { signedIn: false })
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  await act(() => store.cancelLogin('claude'))
  await advance(context, 1_500)
  assert.equal(fake.reads(), 2)
  assert.equal(seen.logins.claude.flow, undefined)
  await advance(context, 6_000)
  assert.equal(fake.reads(), 2, 'the poll stops')
  await unmount()
})

test('login cancel: a cancel that fails shows the failure', async (context) => {
  clock(context)
  host(context, () => reply({ error: 'The command did not stop.' }, 500))
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await act(() => store.cancelLogin('claude'))
  assert.deepEqual(seen.logins.claude.flow, { state: 'failed', error: 'The command did not stop.' })
  await unmount()
})

test('login reads: a second read within 5 s does not reach the host', async (context) => {
  clock(context)
  const fake = sequence(context, [{ signedIn: true }])
  const store = await loadStore()
  await refresh(store, 'claude', false)
  await advance(context, 4_999)
  await refresh(store, 'claude', false)
  assert.equal(fake.reads(), 1)
  await advance(context, 1)
  await refresh(store, 'claude', false)
  assert.equal(fake.reads(), 2)
})

test('login reads: a forced read is not held back', async (context) => {
  clock(context)
  const fake = sequence(context, [{ signedIn: true }])
  const store = await loadStore()
  await refresh(store, 'claude', false)
  await refresh(store, 'claude', true)
  assert.equal(fake.reads(), 2)
})

test('login reads: the 5 s limit is per provider', async (context) => {
  clock(context)
  const fake = sequence(context, [{ signedIn: true }])
  const store = await loadStore()
  await refresh(store, 'claude', false)
  await refresh(store, 'codex', false)
  assert.equal(fake.reads(), 2)
})

test('login reads: reads at the same time share one request, even a forced read', async (context) => {
  clock(context)
  const answer = deferred()
  const fake = host(context, () => answer.promise)
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  let reads
  await act(() => { reads = Promise.all([store.refreshLogin('claude'), store.refreshLogin('claude', true)]) })
  assert.equal(fake.reads(), 1)
  await act(async () => { answer.resolve(reply({ signedIn: true })); await reads })
  assert.equal(seen.logins.claude.signedIn, true)
  await unmount()
})

test('login reads: a read that the host refuses keeps the known state and does not throw', async (context) => {
  clock(context)
  sequence(context, [{ signedIn: true }, reply({ error: 'no' }, 500)])
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  await refresh(store)
  assert.deepEqual(seen.logins.claude, { signedIn: true })
  await unmount()
})

test('login reads: a lost connection warns, keeps the state, and a later read works', async (context) => {
  clock(context)
  const warn = context.mock.method(console, 'warn', () => {})
  const fake = sequence(context, [{ signedIn: true }, new Error('offline'), { signedIn: false }])
  const store = await loadStore()
  const { seen, unmount } = await probe(store)
  await refresh(store)
  await refresh(store)
  assert.deepEqual(seen.logins.claude, { signedIn: true })
  assert.equal(warn.mock.callCount(), 1)
  await refresh(store)
  assert.equal(fake.reads(), 3)
  assert.equal(seen.logins.claude.signedIn, false)
  await unmount()
})

test('login reads: a failed read still counts for the 5 s limit', async (context) => {
  clock(context)
  context.mock.method(console, 'warn', () => {})
  const fake = sequence(context, [new Error('offline'), { signedIn: true }])
  const store = await loadStore()
  await refresh(store, 'claude', false)
  await advance(context, 1_000)
  await refresh(store, 'claude', false)
  assert.equal(fake.reads(), 1)
  await advance(context, 4_000)
  await refresh(store, 'claude', false)
  assert.equal(fake.reads(), 2)
})

test('useLogins: each provider is read on open and the state is returned', async (context) => {
  clock(context)
  const fake = host(context, call => reply({ signedIn: call.url.includes('codex') }))
  const store = await loadStore()
  const { seen, unmount } = await probe(store, ['claude', 'codex@spare'])
  assert.equal(fake.reads(), 2)
  assert.equal(seen.logins.claude.signedIn, false)
  assert.equal(seen.logins['codex@spare'].signedIn, true)
  await unmount()
})

test('useLogins: the state is read again every 30 s while the page is visible', async (context) => {
  clock(context)
  const fake = sequence(context, [{ signedIn: false }, { signedIn: true }])
  const store = await loadStore()
  const { seen, unmount } = await probe(store, ['claude'])
  await advance(context, 29_999)
  assert.equal(fake.reads(), 1)
  await advance(context, 1)
  assert.equal(fake.reads(), 2)
  assert.equal(seen.logins.claude.signedIn, true)
  await unmount()
})

test('useLogins: a hidden page does not read', async (context) => {
  clock(context)
  const fake = sequence(context, [{ signedIn: false }])
  const store = await loadStore()
  const { unmount } = await probe(store, ['claude'])
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  context.after(() => { delete document.visibilityState })
  await advance(context, 90_000)
  assert.equal(fake.reads(), 1)
  await unmount()
})

test('useLogins: window focus reads again, but not within 5 s of the last read', async (context) => {
  clock(context)
  const fake = sequence(context, [{ signedIn: false }])
  const store = await loadStore()
  const { unmount } = await probe(store, ['claude'])
  const focus = () => act(() => { window.dispatchEvent(new window.Event('focus')) })
  await focus()
  assert.equal(fake.reads(), 1)
  await advance(context, 5_000)
  await focus()
  assert.equal(fake.reads(), 2)
  await unmount()
})

test('useLogins: nothing is read after the component goes away', async (context) => {
  clock(context)
  const fake = sequence(context, [{ signedIn: false }])
  const store = await loadStore()
  const { unmount } = await probe(store, ['claude'])
  await unmount()
  await advance(context, 90_000)
  await act(() => { window.dispatchEvent(new window.Event('focus')) })
  assert.equal(fake.reads(), 1)
})

test('useLogins: a new list reads the new provider, and the same list reads nothing', async (context) => {
  clock(context)
  const fake = sequence(context, [{ signedIn: false }])
  const store = await loadStore()
  const { change, unmount } = await probe(store, ['claude'])
  await change(['claude'])
  assert.equal(fake.reads(), 1)
  await change(['claude', 'codex'])
  assert.equal(fake.reads(), 2, 'claude is held back by the 5 s limit, and codex is new')
  assert.match(fake.calls[1].url, /engine=codex/)
  await unmount()
})

test('useLogins: every component sees a change', async (context) => {
  clock(context)
  host(context, call => reply(call.body?.action === 'start' ? { flow: RUNNING } : {}))
  const store = await loadStore()
  const first = await probe(store)
  const second = await probe(store)
  await act(() => store.startLogin('claude'))
  assert.equal(first.seen.logins.claude.flow.state, 'running')
  assert.equal(second.seen.logins.claude.flow.state, 'running')
  await first.unmount()
  const renders = first.seen.renders
  await act(() => store.cancelLogin('claude'))
  assert.equal(first.seen.renders, renders, 'a removed component is not called')
  assert.equal(second.seen.logins.claude.flow, undefined)
  await second.unmount()
})
