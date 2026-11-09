/** Display data of an external provider's models, for the provider selector. */
import { DEFAULT_EFFORT, enginePrefs, orderRows } from '../model-prefs.ts'
import { providerEngine, type ChoiceWire, type EngineName, type InfoWire, type ModelPrefsWire, type ModelWire, type PrefsEngine, type UsedModelWire } from '../protocol.ts'

/** Value of the Claude list entry that only means "use the engine's default". */
const DEFAULT_VALUE = 'default'
const CLAUDE_PREFIX = 'Claude '

/** One row of the selector. */
export interface EngineModelRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
  /** Added by the user; the engine does not list it. */
  readonly custom?: boolean
}

/** @param id - raw reasoning level. @returns its display name. */
export function effortName(id: string): string {
  if (id === 'xhigh') return 'Extra High'
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * Full name of a model. Claude Code lists a short name such as `Opus` and starts the description with the version: `Opus 5.5 · Best for…`.
 * @param engine - provider of the model.
 * @param model - the listed model.
 * @returns for example `Claude Opus 5.5`, or the listed name when the description has no version.
 */
export function modelTitle(engine: EngineName, model: ModelWire): string {
  if (engine !== 'claude' || !model.description.includes(' · ')) return model.name
  const detail = model.description.split(' · ')[0]?.trim() ?? ''
  if (!detail.toLowerCase().startsWith(model.name.toLowerCase())) return model.name
  return detail.startsWith(CLAUDE_PREFIX) ? detail : `${CLAUDE_PREFIX}${detail}`
}

/**
 * Selector rows of one provider, without the entry that only names the default.
 * @param engine - provider of the models.
 * @param info - what the engine offers.
 * @returns the rows.
 */
export function engineModels(provider: string, info: InfoWire | undefined): EngineModelRow[] {
  const engine = providerEngine(provider)
  return (info?.models ?? []).filter(model => model.value !== DEFAULT_VALUE).map(model => ({
    id: model.value, name: modelTitle(engine, model), description: model.description,
    efforts: model.efforts.map(id => ({ id, name: effortName(id) })),
  }))
}

/**
 * All rows of one provider in the user's order, with custom models and with hidden models.
 * @param engine - provider.
 * @param info - what the engine offers.
 * @param prefs - the user's model preferences.
 * @returns the rows.
 */
export function engineCatalog(engine: PrefsEngine, info: InfoWire | undefined, prefs: ModelPrefsWire): EngineModelRow[] {
  const listed = engineModels(engine, info)
  const settings = enginePrefs(prefs, engine)
  const custom = settings.custom.filter(id => !listed.some(row => row.id === id)).map(id => ({ id, name: id, description: '', efforts: [], custom: true }))
  return orderRows([...listed, ...custom], settings.order)
}

/**
 * The rows the selector offers: the catalog without hidden models. A custom model cannot be hidden, only removed.
 * @param engine - provider.
 * @param info - what the engine offers.
 * @param prefs - the user's model preferences.
 * @returns the rows.
 */
export function visibleEngineModels(engine: PrefsEngine, info: InfoWire | undefined, prefs: ModelPrefsWire): EngineModelRow[] {
  return visibleRows(engine, engineCatalog(engine, info, prefs), prefs)
}

/**
 * The rows of a Claude Code or Codex rail, from the models of the DSH catalog.
 * @param provider - provider id.
 * @param label - name of the provider.
 * @param models - the models of its route in the catalog.
 * @param prefs - the user's model preferences.
 * @returns the rows in the stored order, with custom models and without hidden models.
 */
export function engineRailModels(provider: PrefsEngine, label: string, models: readonly { readonly id: string; readonly name: string; readonly reasoning?: { readonly efforts: readonly { readonly id: string; readonly name: string }[] } }[], prefs: ModelPrefsWire): EngineModelRow[] {
  const settings = enginePrefs(prefs, provider)
  const listed = models.map((model): EngineModelRow => ({ id: model.id, name: model.name, description: label, efforts: model.reasoning?.efforts ?? [] }))
  const custom = settings.custom.filter(id => !listed.some(row => row.id === id)).map((id): EngineModelRow => ({ id, name: id, description: label, efforts: [], custom: true }))
  return visibleRows(provider, orderRows([...listed, ...custom], settings.order), prefs)
}

/**
 * @param provider - provider id.
 * @param rows - the provider's rows.
 * @param prefs - the user's model preferences.
 * @returns the rows without the hidden ones; a custom model cannot be hidden, only removed.
 */
export function visibleRows(provider: PrefsEngine, rows: readonly EngineModelRow[], prefs: ModelPrefsWire): EngineModelRow[] {
  const { hidden } = enginePrefs(prefs, provider)
  return rows.filter(row => row.custom === true || !hidden.includes(row.id))
}

/**
 * Selector values of the model that a session used last. Claude Code records a full id such as `claude-opus-5-5`, and it lists `opus`.
 * @param used - what the session file records.
 * @param info - what the engine offers; undefined while the list loads, which keeps the recorded values.
 * @returns the model and reasoning level to select; the reasoning level is empty if the model does not offer it.
 */
export function choiceFromUsed(used: UsedModelWire, info: InfoWire | undefined): { readonly model: string; readonly effort: string } {
  const family = (value: string): string => value.replace(/\[.*$/, '')
  const models = info?.models ?? []
  const model = models.find(item => item.value === used.model) ?? models.find(item => item.value !== DEFAULT_VALUE && used.model.includes(family(item.value)))
  return { model: model?.value ?? used.model, effort: used.effort !== undefined && (model === undefined || model.efforts.includes(used.effort)) ? used.effort : '' }
}

/** @param info - what the engine offers. @param modelId - model value. @returns the speed tier that selects fast mode on that model, if any. */
export function fastTierOf(info: InfoWire | undefined, modelId: string): string | undefined {
  return info?.models.find(model => model.value === modelId)?.fastTier
}

/**
 * The saved speed after a model change.
 * @param info - what the engine offers.
 * @param modelId - the new model.
 * @param current - the saved speed.
 * @returns the new model's fast tier if fast mode stays on, else empty; undefined when the user never chose a speed.
 */
export function speedFor(info: InfoWire | undefined, modelId: string, current: string | undefined): string | undefined {
  if (current === undefined) return undefined
  return current === '' ? '' : fastTierOf(info, modelId) ?? ''
}

/** @param info - what the engine offers. @returns the listed model the engine uses when none is picked; absent when the engine does not say. */
function defaultModel(info: InfoWire | undefined): ModelWire | undefined {
  const models = (info?.models ?? []).filter(model => model.value !== DEFAULT_VALUE)
  return models.find(model => model.isDefault === true) ?? models.find(model => model.name === info?.defaults?.model)
}

/**
 * Selection and trigger captions of one provider.
 * @param engine - provider of the choice.
 * @param info - what the engine offers.
 * @param choice - the saved model and effort; an empty model, or `default`, leaves the model to the engine.
 * @returns the selected row id, the model caption, the effort caption, and the level to send (Medium when none is saved and the model supports it).
 */
export function engineLabels(provider: string, info: InfoWire | undefined, choice: ChoiceWire): { label: string; effort: string; effortId: string; modelId: string } {
  const engine: EngineName = providerEngine(provider)
  const value = choice.model === DEFAULT_VALUE ? '' : choice.model
  const fallback = defaultModel(info)
  const model = value === '' ? fallback : info?.models.find(item => item.value === value)
  const effortId = choice.effort !== '' ? choice.effort : model?.efforts.includes(DEFAULT_EFFORT) === true ? DEFAULT_EFFORT : ''
  return {
    modelId: model?.value ?? value,
    label: model !== undefined ? modelTitle(engine, model) : value !== '' ? value : info?.defaults?.model ?? '',
    effort: effortId !== '' ? effortName(effortId) : info?.defaults?.effort !== undefined ? effortName(info.defaults.effort) : '',
    effortId,
  }
}
