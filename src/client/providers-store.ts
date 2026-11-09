/** The providers the plugin offers, in the browser: the two defaults and the instances the user added. */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { INSTANCES_PATH, providerId, type ProviderInstanceWire } from '../protocol.ts'

/** One provider of the list. */
export interface ProviderEntry {
  readonly id: string
  readonly engine: 'claude' | 'codex'
  readonly label: string
  readonly accent?: string | undefined
  /** Present on an instance the user added. */
  readonly instance?: ProviderInstanceWire | undefined
}

const DEFAULTS: readonly ProviderEntry[] = [
  { id: 'codex', engine: 'codex', label: 'Codex' },
  { id: 'claude', engine: 'claude', label: 'Claude Code' },
]

let entries: readonly ProviderEntry[] = DEFAULTS
let requested = false
const listeners = new Set<() => void>()

function publish(instances: readonly ProviderInstanceWire[]): void {
  entries = [...DEFAULTS, ...instances.map(instance => ({ id: providerId(instance.engine, instance.id), engine: instance.engine, label: instance.label, accent: instance.accent, instance }))]
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function load(): void {
  if (requested) return
  requested = true
  void fetch(INSTANCES_PATH, { credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      return await response.json() as { instances: ProviderInstanceWire[] }
    })
    .then(body => { publish(body.instances) }, (error: unknown) => { requested = false; console.warn('agent-bridge: provider instances failed to load', error) })
}

async function change(body: unknown): Promise<string | undefined> {
  const response = await fetch(INSTANCES_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json() as { instances?: ProviderInstanceWire[]; error?: string }
  if (!response.ok || result.instances === undefined) return result.error ?? `HTTP ${response.status}`
  publish(result.instances)
  return undefined
}

/** @returns the providers as the page knows them now, for code outside a component. */
export function currentProviders(): readonly ProviderEntry[] {
  return entries
}

/** @returns the providers, and functions that add or remove an instance; each resolves to an error text, if any. */
export function useProviders(): { providers: readonly ProviderEntry[]; add: (instance: unknown) => Promise<string | undefined>; remove: (id: string) => Promise<string | undefined> } {
  useEffect(load, [])
  const providers = useSyncExternalStore(subscribe, () => entries)
  return {
    providers,
    add: useCallback(async (instance: unknown) => await change({ action: 'add', instance }), []),
    remove: useCallback(async (id: string) => await change({ action: 'remove', id }), []),
  }
}
