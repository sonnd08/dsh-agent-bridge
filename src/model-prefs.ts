/**
 * The user's model list per provider: order, hidden models, favorites, and custom model ids.
 * @module dsh-agent-bridge/model-prefs
 */
import type { ModelPrefsWire, EngineModelPrefsWire, PrefsEngine } from './protocol.ts'

/** Preferences before the user changes anything. */
export const NO_MODEL_PREFS: ModelPrefsWire = { engines: {}, favorites: [] }

/** Reasoning level of a model the user has not set one for. */
export const DEFAULT_EFFORT = 'medium'

/** Provider ids with a model list. */
const PROVIDER_KEY = /^(dsh|claude|codex)(@[A-Za-z0-9_-]+)?$/
/** Provider ids that can be turned off; DeepSeek Harness is always available. */
const SWITCHABLE_PROVIDER = /^(claude|codex)(@[A-Za-z0-9_-]+)?$/
const NO_ENGINE_PREFS: EngineModelPrefsWire = { hidden: [], order: [], custom: [] }
const MAX_ENTRIES = 500
const MAX_SLUG_LENGTH = 256

/** A row the preferences can order. */
export interface OrderedRow { readonly id: string }

/** @param prefs - stored preferences. @param engine - provider. @returns that provider's preferences. */
export function enginePrefs(prefs: ModelPrefsWire, engine: PrefsEngine): EngineModelPrefsWire {
  return prefs.engines[engine] ?? NO_ENGINE_PREFS
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) return undefined
  return value.every(item => typeof item === 'string' && item.length <= MAX_SLUG_LENGTH * 2) ? value as string[] : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length > MAX_ENTRIES) return undefined
  return entries.every(([key, item]) => key.length <= MAX_SLUG_LENGTH * 2 && typeof item === 'string' && item.length <= 50) ? Object.fromEntries(entries) as Record<string, string> : undefined
}

function parseEngine(value: unknown): EngineModelPrefsWire | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { hidden, order, custom } = value as Record<string, unknown>
  const lists = [stringList(hidden), stringList(order), stringList(custom)]
  return lists[0] === undefined || lists[1] === undefined || lists[2] === undefined ? undefined : { hidden: lists[0], order: lists[1], custom: lists[2] }
}

/**
 * Validate preferences that arrive over the wire.
 * @param value - request body.
 * @returns the preferences, or undefined when the body is not valid.
 */
export function parseModelPrefs(value: unknown): ModelPrefsWire | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { engines, favorites } = value as Record<string, unknown>
  const parsedFavorites = stringList(favorites)
  if (parsedFavorites === undefined || typeof engines !== 'object' || engines === null) return undefined
  const parsedEngines: Record<string, EngineModelPrefsWire> = {}
  for (const [provider, item] of Object.entries(engines)) {
    if (!PROVIDER_KEY.test(provider)) continue
    const parsed = parseEngine(item)
    if (parsed === undefined) return undefined
    parsedEngines[provider] = parsed
  }
  const disabled = (value as Record<string, unknown>)['disabled']
  const parsedDisabled = disabled === undefined ? undefined : stringList(disabled)
  if ((disabled !== undefined && parsedDisabled === undefined) || parsedDisabled?.some(item => !SWITCHABLE_PROVIDER.test(item)) === true) return undefined
  const efforts = (value as Record<string, unknown>)['efforts']
  const parsedEfforts = efforts === undefined ? undefined : stringRecord(efforts)
  if (efforts !== undefined && parsedEfforts === undefined) return undefined
  return {
    engines: parsedEngines, favorites: parsedFavorites,
    ...parsedDisabled === undefined ? {} : { disabled: parsedDisabled },
    ...parsedEfforts === undefined ? {} : { efforts: parsedEfforts },
  }
}

/**
 * Clean a model id the user typed.
 * @param text - typed id.
 * @returns the id, or undefined when it is empty, too long, or contains white space.
 */
export function normalizeCustomSlug(text: string): string | undefined {
  const slug = text.trim()
  return slug === '' || slug.length > MAX_SLUG_LENGTH || /\s/.test(slug) ? undefined : slug
}

/**
 * Sort rows by the stored order; rows without a position keep their listed order after the others.
 * @param rows - rows in listed order.
 * @param order - stored ids.
 * @returns the sorted rows.
 */
export function orderRows<T extends OrderedRow>(rows: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]))
  return rows.map((row, index) => ({ row, index })).sort((a, b) => (rank.get(a.row.id) ?? Infinity) - (rank.get(b.row.id) ?? Infinity) || a.index - b.index).map(item => item.row)
}

function withEngine(prefs: ModelPrefsWire, engine: PrefsEngine, patch: Partial<EngineModelPrefsWire>): ModelPrefsWire {
  return { ...prefs, engines: { ...prefs.engines, [engine]: { ...enginePrefs(prefs, engine), ...patch } } }
}

/**
 * Move a row one place within the rows shown beside it.
 * @param prefs - stored preferences.
 * @param engine - provider.
 * @param group - ids of the row's group, in display order.
 * @param display - all ids in display order.
 * @param id - row to move.
 * @param delta - -1 moves up, 1 moves down.
 * @returns the new preferences; unchanged when the row is at the end of its group.
 */
export function moveModel(prefs: ModelPrefsWire, engine: PrefsEngine, group: readonly string[], display: readonly string[], id: string, delta: -1 | 1): ModelPrefsWire {
  const from = group.indexOf(id)
  const neighbor = group[from + delta]
  if (from === -1 || neighbor === undefined) return prefs
  const order = display.map(item => item === id ? neighbor : item === neighbor ? id : item)
  return withEngine(prefs, engine, { order })
}

/** @param prefs - stored preferences. @param engine - provider. @param id - model. @returns the preferences with the model shown or hidden. */
export function toggleHidden(prefs: ModelPrefsWire, engine: PrefsEngine, id: string): ModelPrefsWire {
  const { hidden } = enginePrefs(prefs, engine)
  return withEngine(prefs, engine, { hidden: hidden.includes(id) ? hidden.filter(item => item !== id) : [...hidden, id] })
}

/**
 * Hide every listed model, or show them all if they are already hidden.
 * @param prefs - stored preferences.
 * @param engine - provider.
 * @param ids - the provider's listed models.
 * @returns the new preferences.
 */
export function toggleAllHidden(prefs: ModelPrefsWire, engine: PrefsEngine, ids: readonly string[]): ModelPrefsWire {
  const { hidden } = enginePrefs(prefs, engine)
  const allHidden = ids.every(id => hidden.includes(id))
  return withEngine(prefs, engine, { hidden: allHidden ? hidden.filter(id => !ids.includes(id)) : [...new Set([...hidden, ...ids])] })
}

/** @param prefs - stored preferences. @param engine - provider. @returns whether the selector offers the provider. */
export function isEngineEnabled(prefs: ModelPrefsWire, engine: PrefsEngine): boolean {
  return prefs.disabled?.includes(engine) !== true
}

/** @param prefs - stored preferences. @param engine - provider. @returns the preferences with the provider turned on or off. */
export function toggleEngine(prefs: ModelPrefsWire, engine: PrefsEngine): ModelPrefsWire {
  const disabled = prefs.disabled ?? []
  return { ...prefs, disabled: disabled.includes(engine) ? disabled.filter(item => item !== engine) : [...disabled, engine] }
}

/**
 * The level the Reasoning column marks for a row.
 * @param prefs - saved levels by `engine/model` key.
 * @param key - the row under the pointer.
 * @param selected - the selected model and its level.
 * @returns the selected model's level, else the row's saved level, if any.
 */
export function markedEffort(prefs: ModelPrefsWire, key: string | undefined, selected: { readonly key: string; readonly effort: string }): string | undefined {
  if (key === undefined) return undefined
  return key === selected.key ? selected.effort : prefs.efforts?.[key]
}

/**
 * Decide the reasoning level after a model pick, and remember the levels involved.
 * The level of the model the user leaves is saved. An explicit level is saved for the picked model.
 * Without an explicit level, the picked model uses its saved level, else the current level if it supports it, else Medium if it supports that.
 * @param prefs - stored preferences.
 * @param from - the selected model before the pick, with its level.
 * @param to - the picked model and the levels it supports.
 * @param explicit - the level the user clicked, if any.
 * @returns the level (empty when the model has no level to use) and the new preferences.
 */
export function pickEffort(
  prefs: ModelPrefsWire,
  from: { readonly key: string; readonly effort: string },
  to: { readonly key: string; readonly efforts: readonly string[] },
  explicit: string | undefined,
): { effort: string; prefs: ModelPrefsWire } {
  const saved = prefs.efforts?.[to.key]
  const effort = explicit ?? (saved !== undefined && to.efforts.includes(saved) ? saved : to.efforts.includes(from.effort) ? from.effort : to.efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : '')
  const efforts = { ...prefs.efforts, ...from.effort === '' ? {} : { [from.key]: from.effort }, ...explicit === undefined ? {} : { [to.key]: explicit } }
  return { effort, prefs: Object.keys(efforts).length === 0 ? prefs : { ...prefs, efforts } }
}

/**
 * Put the favorites in the order of the rows on screen. Rows that are no longer favorites are ignored.
 * @param prefs - stored preferences.
 * @param shown - keys in display order.
 * @returns the new preferences; favorites that are not on screen follow the others.
 */
export function orderFavorites(prefs: ModelPrefsWire, shown: readonly string[]): ModelPrefsWire {
  return { ...prefs, favorites: [...shown.filter(key => prefs.favorites.includes(key)), ...prefs.favorites.filter(key => !shown.includes(key))] }
}

/**
 * Move a row one place in the Favorites tab.
 * @param prefs - stored preferences.
 * @param shown - keys in display order.
 * @param key - row to move.
 * @param delta - -1 moves up, 1 moves down.
 * @returns the new display order and preferences; unchanged at the end of the list.
 */
export function moveFavorite(prefs: ModelPrefsWire, shown: readonly string[], key: string, delta: -1 | 1): { shown: readonly string[]; prefs: ModelPrefsWire } {
  const from = shown.indexOf(key)
  const neighbor = shown[from + delta]
  if (from === -1 || neighbor === undefined) return { shown, prefs }
  const next = shown.map(item => item === key ? neighbor : item === neighbor ? key : item)
  return { shown: next, prefs: orderFavorites(prefs, next) }
}

/** @param prefs - stored preferences. @param key - `engine/model`. @returns the preferences with the favorite added or removed. */
export function toggleFavorite(prefs: ModelPrefsWire, key: string): ModelPrefsWire {
  return { ...prefs, favorites: prefs.favorites.includes(key) ? prefs.favorites.filter(item => item !== key) : [...prefs.favorites, key] }
}

/** @param prefs - stored preferences. @param engine - provider. @param slug - cleaned model id. @returns the preferences with the custom model added. */
export function addCustomModel(prefs: ModelPrefsWire, engine: PrefsEngine, slug: string): ModelPrefsWire {
  const { custom } = enginePrefs(prefs, engine)
  return custom.includes(slug) ? prefs : withEngine(prefs, engine, { custom: [...custom, slug] })
}

/** @param prefs - stored preferences. @param engine - provider. @param slug - model id. @returns the preferences without the custom model. */
export function removeCustomModel(prefs: ModelPrefsWire, engine: PrefsEngine, slug: string): ModelPrefsWire {
  const { custom, order } = enginePrefs(prefs, engine)
  const key = `${engine}/${slug}`
  return { ...withEngine(prefs, engine, { custom: custom.filter(item => item !== slug), order: order.filter(item => item !== slug) }), favorites: prefs.favorites.filter(item => item !== key) }
}
