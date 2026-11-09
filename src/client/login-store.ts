/** The sign-in state of each provider, shared by the composer notice and the settings page. */
import { useEffect, useSyncExternalStore } from 'react'
import { LOGIN_PATH, providerEngine, providerInstance, type LoginBodyWire, type LoginWire } from '../protocol.ts'

const POLL_MS = 1_500
const RECHECK_MS = 30_000
const MIN_AGE_MS = 5_000
const DONE_VISIBLE_MS = 8_000

let logins: Readonly<Record<string, LoginWire>> = {}
const listeners = new Set<() => void>()
const readAt = new Map<string, number>()
const loading = new Map<string, Promise<void>>()
const pollers = new Set<string>()

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const snapshot = (): Readonly<Record<string, LoginWire>> => logins

function put(provider: string, next: LoginWire): void {
  logins = { ...logins, [provider]: next }
  for (const listener of listeners) listener()
}

function apply(provider: string, body: LoginWire): void {
  const previous = logins[provider]
  // The host reports a finished attempt one time, so its result stays here until the notice no longer needs it.
  const finished = previous?.flow !== undefined && previous.flow.state !== 'running' ? previous.flow : undefined
  const flow = body.flow ?? finished
  const signedIn = body.signedIn ?? previous?.signedIn
  const plan = body.plan ?? previous?.plan
  put(provider, { ...signedIn === undefined ? {} : { signedIn }, ...plan === undefined ? {} : { plan }, ...flow === undefined ? {} : { flow } })
  if (body.flow?.state === 'running' && !pollers.has(provider)) {
    pollers.add(provider)
    window.setTimeout(() => { pollers.delete(provider); void refreshLogin(provider, true) }, POLL_MS)
  }
  if (body.flow?.state === 'succeeded') {
    window.setTimeout(() => {
      const { flow: shown, ...rest } = logins[provider] ?? {}
      if (shown?.state === 'succeeded') put(provider, rest)
    }, DONE_VISIBLE_MS)
  }
}

/**
 * Read the sign-in state of one provider.
 * @param provider - provider id.
 * @param force - read even if the last answer is recent.
 * @returns when the answer is in the store.
 */
export async function refreshLogin(provider: string, force = false): Promise<void> {
  const running = loading.get(provider)
  if (running !== undefined) return await running
  if (!force && Date.now() - (readAt.get(provider) ?? 0) < MIN_AGE_MS) return
  readAt.set(provider, Date.now())
  const instance = providerInstance(provider)
  const request = fetch(`${LOGIN_PATH}?${new URLSearchParams({ engine: providerEngine(provider), ...instance === undefined ? {} : { instance } }).toString()}`, { credentials: 'same-origin' })
    .then(async (response) => { if (response.ok) apply(provider, await response.json() as LoginWire) })
    .catch((error: unknown) => { console.warn('agent-bridge: sign-in state failed', error) })
    .finally(() => { loading.delete(provider) })
  loading.set(provider, request)
  await request
}

async function post(provider: string, action: LoginBodyWire['action']): Promise<void> {
  const instance = providerInstance(provider)
  const body: LoginBodyWire = { engine: providerEngine(provider), action, ...instance === undefined ? {} : { instance } }
  try {
    const response = await fetch(LOGIN_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const answer = await response.json() as LoginWire & { error?: string }
    if (response.ok) apply(provider, answer)
    else apply(provider, { flow: { state: 'failed', error: answer.error ?? `HTTP ${String(response.status)}` } })
  } catch (error) {
    apply(provider, { flow: { state: 'failed', error: error instanceof Error ? error.message : String(error) } })
  }
}

/** @param provider - provider id. Remove the result of an earlier attempt and run the sign-in command. */
export async function startLogin(provider: string): Promise<void> {
  const { flow: _earlier, ...rest } = logins[provider] ?? {}
  put(provider, { ...rest, flow: { state: 'running' } })
  await post(provider, 'start')
}

/** @param provider - provider id. Stop the sign-in command and remove the attempt. */
export async function cancelLogin(provider: string): Promise<void> {
  const { flow: _attempt, ...rest } = logins[provider] ?? {}
  put(provider, rest)
  await post(provider, 'cancel')
}

/**
 * Keep the sign-in state of some providers current: on open, when the window gets focus, and every 30 seconds.
 * @param providers - provider ids.
 * @returns the state of each provider, when known.
 */
export function useLogins(providers: readonly string[]): Readonly<Record<string, LoginWire>> {
  const list = providers.join('|')
  useEffect(() => {
    const read = (): void => { for (const provider of providers) void refreshLogin(provider) }
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') read() }, RECHECK_MS)
    read()
    window.addEventListener('focus', read)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', read) }
  }, [list])
  return useSyncExternalStore(subscribe, snapshot)
}
