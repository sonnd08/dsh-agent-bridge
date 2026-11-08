/** The user's model preferences in the browser: one copy per page, shared by the selector and the settings page. */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { NO_MODEL_PREFS } from '../model-prefs.ts'
import { MODEL_PREFS_PATH, type ModelPrefsWire } from '../protocol.ts'

let prefs: ModelPrefsWire = NO_MODEL_PREFS
let requested = false
const listeners = new Set<() => void>()

function publish(next: ModelPrefsWire): void {
  prefs = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function load(): void {
  if (requested) return
  requested = true
  void fetch(MODEL_PREFS_PATH, { credentials: 'same-origin' })
    .then(async response => await response.json() as ModelPrefsWire)
    .then(publish, (error: unknown) => { requested = false; console.warn('agent-bridge: model preferences failed to load', error) })
}

function save(next: ModelPrefsWire): void {
  publish(next)
  void fetch(MODEL_PREFS_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) })
    .then((response) => { if (!response.ok) console.warn('agent-bridge: model preferences failed to save', response.status) })
    .catch((error: unknown) => { console.warn('agent-bridge: model preferences failed to save', error) })
}

/** @returns the preferences and a function that saves new ones. */
export function useModelPrefs(): [ModelPrefsWire, (next: ModelPrefsWire) => void] {
  useEffect(load, [])
  const current = useSyncExternalStore(subscribe, () => prefs)
  return [current, useCallback(save, [])]
}
