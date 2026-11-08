/** The harness model list as the model seat last saw it; the settings page has no session of its own to read it from. */
import { useSyncExternalStore } from 'react'
import type { EngineModelRow } from './model-names.ts'

const NONE: readonly EngineModelRow[] = []
let rows: readonly EngineModelRow[] = NONE
const listeners = new Set<() => void>()

/** @param next - the harness models in their catalog order. */
export function publishDshCatalog(next: readonly EngineModelRow[]): void {
  if (next === rows) return
  rows = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** @returns the harness models. */
export function useDshCatalog(): readonly EngineModelRow[] {
  return useSyncExternalStore(subscribe, () => rows)
}
