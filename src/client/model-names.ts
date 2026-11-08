/** Display data of an external provider's models, for the provider selector. */
import { enginePrefs, orderRows } from '../model-prefs.ts'
import type { ChoiceWire, EngineName, InfoWire, ModelPrefsWire, ModelWire, PrefsEngine } from '../protocol.ts'

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
export function engineModels(engine: EngineName, info: InfoWire | undefined): EngineModelRow[] {
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
  const { hidden } = enginePrefs(prefs, engine)
  return engineCatalog(engine, info, prefs).filter(row => row.custom === true || !hidden.includes(row.id))
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
 * @returns the selected row id, the model caption, and the effort caption.
 */
export function engineLabels(engine: EngineName, info: InfoWire | undefined, choice: ChoiceWire): { label: string; effort: string; modelId: string } {
  const value = choice.model === DEFAULT_VALUE ? '' : choice.model
  const fallback = defaultModel(info)
  const model = value === '' ? fallback : info?.models.find(item => item.value === value)
  return {
    modelId: model?.value ?? value,
    label: model !== undefined ? modelTitle(engine, model) : value !== '' ? value : info?.defaults?.model ?? '',
    effort: choice.effort !== '' ? effortName(choice.effort) : info?.defaults?.effort !== undefined ? effortName(info.defaults.effort) : '',
  }
}
