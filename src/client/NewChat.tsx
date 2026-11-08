/** Provider selection in the harness composer: the model seat, and the store that says which provider a new chat uses. */
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import {
  PermissionIconAutoReviewRegular, PermissionIconFullAccessRegular, PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useChoices } from './ComposerBar.tsx'
import { useInfos } from './info.ts'
import { engineLabels, fastTierOf, speedFor, visibleEngineModels, visibleRows, type EngineModelRow } from './model-names.ts'
import { publishDshCatalog } from './dsh-catalog-store.ts'
import { useProviders } from './providers-store.ts'
import { useModelPrefs } from './model-prefs-store.ts'
import { enginePrefs, isEngineEnabled, orderRows, pickEffort, toggleFavorite } from '../model-prefs.ts'
import { bridgeAccessOptions, PermissionPicker, PermissionPopover, type PermissionOption } from './PermissionPicker.tsx'
import { ProviderPicker, type PickerCurrent, type PickerEngine, type PickerGroup } from './ProviderPicker.tsx'
import type { Translate } from './ToolCard.tsx'
import type { InfoWire, ModelPrefsWire, PermissionPreset, PrefsEngine } from '../protocol.ts'

/** Provider a new chat starts with: `dsh` or a provider id. */
export type NewChatEngine = string

/** Observable provider of new chats, kept between chats and page loads. */
export interface EngineStore {
  getSnapshot(): NewChatEngine
  subscribe(listener: () => void): () => void
  set(next: NewChatEngine): void
}

const ENGINE_KEY = 'agent-bridge:new-chat-engine'

/** @returns the store, starting from the provider of the last new chat. */
export function createEngineStore(): EngineStore {
  let engine: NewChatEngine = 'dsh'
  try {
    const stored = localStorage.getItem(ENGINE_KEY)
    if (stored !== null && stored !== '') engine = stored
  } catch { /* the choice lasts for this page */ }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => engine,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      if (next === engine) return
      engine = next
      try {
        localStorage.setItem(ENGINE_KEY, next)
      } catch { /* the choice lasts for this page */ }
      for (const listener of listeners) listener()
    },
  }
}

/** One provider of the harness model catalog. */
interface CatalogGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly { readonly id: string; readonly name: string; readonly reasoning?: { readonly defaultEffort?: string; readonly efforts: readonly { readonly id: string; readonly name: string }[] } }[]
}

/** The harness model selection of one session. */
export interface CatalogState {
  readonly current: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | null
  readonly groups: readonly CatalogGroup[]
  readonly status: string
  readonly error: string | null
}

/** Observable model catalog of one session. */
export interface CatalogStore {
  getSnapshot(): CatalogState
  subscribe(listener: () => void): () => void
}

/** One harness permission preset. */
interface NativeOption { readonly value: string; readonly name: string; readonly description?: string }

/** The harness permission presets, as its own composer control reads them. */
export interface NativePermission {
  readonly catalog: {
    getSnapshot(): { readonly value: { readonly options: readonly NativeOption[] } | null }
    subscribe(listener: () => void): () => void
  }
  readonly select: (preset: string) => Promise<boolean>
}

/** What the model seat gets from the plugin entry. */
export interface SeatServices {
  readonly catalog?: CatalogStore | undefined
  readonly loadCatalog: () => void
  readonly selectModel: (selection: { provider: string; model: string; reasoningEffort?: string }) => void
  readonly engines: EngineStore
  readonly getCwd: () => string
  readonly subscribeSessions: (listener: () => void) => () => void
  readonly isBlank: () => boolean
  readonly codexEnabled: () => boolean
  /** Calls back when the plugin learns its configuration from the host, after a page load. */
  readonly subscribeBridge: (listener: () => void) => () => void
  readonly nativePermission: () => NativePermission | undefined
  readonly openSettings: (() => void) | undefined
}

const NO_CATALOG: CatalogState = { current: null, groups: [], status: 'idle', error: null }
const noSubscribe = (): (() => void) => () => {}
const noCatalog = (): CatalogState => NO_CATALOG
const NO_PERMISSION_CATALOG = { value: null }
const noPermissionCatalog = (): { readonly value: null } => NO_PERMISSION_CATALOG

/** The harness's own provider order: the account and the official provider come first. */
function dshProviderOrder(groups: readonly CatalogGroup[]): CatalogGroup[] {
  const rank = (group: CatalogGroup): number => group.id === 'deepseek-account' ? 0 : group.id === 'deepseek-official' ? 1 : 2
  return [...groups].sort((left, right) => rank(left) - rank(right))
}
const RISKY_NATIVE_PRESETS = ['danger-full-access', 'auto']
const NATIVE_ICONS: Readonly<Record<string, ReactNode>> = {
  'read-only': <PermissionIconReadOnlyRegular />,
  'workspace-write': <PermissionIconWorkspaceWriteRegular />,
  'danger-full-access': <PermissionIconFullAccessRegular />,
  auto: <PermissionIconAutoReviewRegular />,
}

/** Picker data of one external provider. */
export function engineGroup(engine: PrefsEngine, label: string, info: InfoWire | undefined, error: string | undefined, prefs: ModelPrefsWire, t: Translate, accent?: string): PickerGroup {
  return { engine, label, models: visibleEngineModels(engine, info, prefs), status: error ?? (info === undefined ? t('picker.loading') : undefined), ...accent === undefined ? {} : { accent } }
}

/** @param option - a harness preset. @param t - translate. @returns the name the composer shows for it; the catalog can hold the raw preset id. */
function nativePresetLabel(option: { readonly value: string; readonly name: string }, t: Translate): string {
  if (option.value === 'read-only') return t('composer.permissionReadOnly')
  if (option.value === 'workspace-write') return t('composer.permissionWorkspace')
  if (option.value === 'danger-full-access') return t('composer.permissionFull')
  return option.name
}

/** @param options - the harness presets. @param t - translate. @returns them as access levels; the presets the bridge also has use its descriptions when the catalog has none. */
function nativeAccessOptions(options: readonly NativeOption[], t: Translate): PermissionOption[] {
  const known: Readonly<Record<string, string>> = { 'read-only': t('picker.accessReadOnly'), 'workspace-write': t('picker.accessWorkspace'), 'danger-full-access': t('picker.accessFull') }
  return options.map((option) => {
    const description = option.description ?? known[option.value]
    return { value: option.value, label: nativePresetLabel(option, t), ...description === undefined ? {} : { description }, ...NATIVE_ICONS[option.value] === undefined ? {} : { icon: NATIVE_ICONS[option.value] } }
  })
}

/** The harness permission control, for the selector footer. */
function NativeAccess({ native, useProjection, t }: { native: NativePermission; useProjection: (name: 'permissions') => { readonly currentValue: string } | undefined; t: Translate }) {
  const selection = useProjection('permissions')
  const catalog = useSyncExternalStore(native.catalog.subscribe, native.catalog.getSnapshot).value
  if (selection === undefined || catalog === null) return null
  return (
    <PermissionPicker
      value={selection.currentValue} riskValues={RISKY_NATIVE_PRESETS} t={t}
      options={nativeAccessOptions(catalog.options, t)}
      onChange={(preset) => { void native.select(preset).catch((error: unknown) => { console.warn('agent-bridge: permission change failed', error) }) }}
    />
  )
}

/**
 * Replaces the harness model seat; the rest of the harness composer stays as it is.
 * @param props - the seat's lock state, plugin services, the session projection hook and locale seat.
 * @returns the picker.
 */
export function ProviderSeat({ locked, services, useProjection, t }: { locked?: boolean; services: SeatServices; useProjection: (name: 'permissions') => { readonly currentValue: string } | undefined; t: Translate }) {
  const { catalog, loadCatalog, selectModel, engines, getCwd, subscribeSessions, isBlank, codexEnabled, subscribeBridge, nativePermission } = services
  const state = useSyncExternalStore(catalog?.subscribe ?? noSubscribe, catalog?.getSnapshot ?? noCatalog)
  const stored = useSyncExternalStore(engines.subscribe, engines.getSnapshot)
  const blank = useSyncExternalStore(subscribeSessions, isBlank)
  useEffect(() => { loadCatalog() }, [loadCatalog])
  const cwd = getCwd()
  const codexAvailable = useSyncExternalStore(subscribeBridge, codexEnabled)
  const [prefs, savePrefs] = useModelPrefs()
  const { providers } = useProviders()
  const offered = providers.filter(provider => (provider.engine !== 'codex' || codexAvailable) && isEngineEnabled(prefs, provider.id))
  const offeredIds = offered.map(provider => provider.id)
  const infos = useInfos(blank ? offeredIds : [], cwd)
  const choices = useChoices(offeredIds)
  const selected = stored !== 'dsh' && !offeredIds.includes(stored) ? 'dsh' : stored

  const dshRows = useMemo((): EngineModelRow[] => dshProviderOrder(state.groups).flatMap(group => group.models.map(model => ({
    id: `${group.id}/${model.id}`, name: model.name, description: group.name, efforts: model.reasoning?.efforts ?? [],
  }))), [state.groups])
  useEffect(() => { if (dshRows.length > 0) publishDshCatalog(dshRows) }, [dshRows])
  const dshGroup: PickerGroup = {
    engine: 'dsh',
    label: t('picker.dsh'),
    models: visibleRows('dsh', orderRows(dshRows, enginePrefs(prefs, 'dsh').order), prefs),
    status: state.error ?? (state.status === 'loading' ? t('picker.loading') : undefined),
  }
  const groups: readonly PickerGroup[] = blank
    ? [dshGroup, ...offered.map(provider => engineGroup(provider.id, provider.label, infos[provider.id]?.info, infos[provider.id]?.error, prefs, t, provider.accent))]
    : [dshGroup]

  const engine: PickerEngine = blank ? selected : 'dsh'
  const external = engine !== 'dsh'
  const externalInfo = infos[engine]?.info
  const [externalChoice, setExternalChoice] = choices[engine] ?? [{ model: '', effort: '' }, () => {}]
  let current: PickerCurrent
  let label: string
  let effortLabel: string
  if (external) {
    const labels = engineLabels(engine, externalInfo, externalChoice)
    current = { engine, modelId: labels.modelId, effort: labels.effortId }
    label = labels.label
    effortLabel = labels.effort
  } else {
    const model = state.groups.find(group => group.id === state.current?.provider)?.models.find(item => item.id === state.current?.model)
    const effort = state.current?.reasoningEffort ?? model?.reasoning?.defaultEffort ?? ''
    current = { engine: 'dsh', modelId: state.current === null ? '' : `${state.current.provider}/${state.current.model}`, effort }
    label = model?.name ?? state.current?.model ?? t('picker.title')
    effortLabel = model?.reasoning?.efforts.find(level => level.id === effort)?.name ?? ''
  }

  const pick = (target: PickerEngine, modelId: string, explicit: string | undefined): void => {
    const supported = groups.find(group => group.engine === target)?.models.find(model => model.id === modelId)?.efforts.map(level => level.id) ?? []
    const { effort, prefs: nextPrefs } = pickEffort(prefs, { key: `${current.engine}/${current.modelId}`, effort: current.effort }, { key: `${target}/${modelId}`, efforts: supported }, explicit)
    if (nextPrefs !== prefs) savePrefs(nextPrefs)
    if (target !== 'dsh') {
      const entry = choices[target]
      if (entry === undefined) return
      const [choice, set] = entry
      const speed = speedFor(infos[target]?.info, modelId, choice.speed)
      set({ ...choice, model: modelId, effort, ...speed === undefined ? {} : { speed } })
      engines.set(target)
      return
    }
    engines.set('dsh')
    for (const group of state.groups) {
      const model = group.models.find(item => `${group.id}/${item.id}` === modelId)
      if (model === undefined) continue
      const level = effort !== '' ? effort : model.reasoning?.defaultEffort
      selectModel({ provider: group.id, model: model.id, ...level === undefined ? {} : { reasoningEffort: level } })
      return
    }
  }

  const fastTier = external ? fastTierOf(externalInfo, current.modelId) : undefined
  const native = external ? undefined : nativePermission()
  const nativeSelection = useProjection('permissions')
  const nativeCatalog = useSyncExternalStore(native?.catalog.subscribe ?? noSubscribe, native?.catalog.getSnapshot ?? noPermissionCatalog).value
  const accessChip = external
    ? <PermissionPopover options={bridgeAccessOptions(t)} value={externalChoice.permission ?? ''} locked={locked} onChange={(permission) => { setExternalChoice({ ...externalChoice, permission: permission as PermissionPreset | '' }) }} t={t} />
    : native === undefined || nativeCatalog === null || nativeSelection === undefined
      ? undefined
      : <PermissionPopover options={nativeAccessOptions(nativeCatalog.options, t)} value={nativeSelection.currentValue} riskValues={RISKY_NATIVE_PRESETS} locked={locked} onChange={(preset) => { void native.select(preset).catch((error: unknown) => { console.warn('agent-bridge: permission change failed', error) }) }} t={t} />
  return (
    <ProviderPicker
      groups={groups} current={current} label={label} effortLabel={effortLabel} locked={locked}
      favorites={prefs.favorites} onToggleFavorite={(key) => { savePrefs(toggleFavorite(prefs, key)) }} onPick={pick} accessChip={accessChip} onOpenSettings={services.openSettings} savedEfforts={prefs.efforts}
      speed={external ? { available: fastTier !== undefined, fast: fastTier !== undefined && (externalChoice.speed ?? '') !== '', onChange: (fast) => { setExternalChoice({ ...externalChoice, speed: fast ? fastTier ?? '' : '' }) } } : undefined}
      access={external
        ? <PermissionPicker value={externalChoice.permission ?? ''} onChange={(permission) => { setExternalChoice({ ...externalChoice, permission: permission as PermissionPreset | '' }) }} t={t} />
        : native === undefined ? undefined : <NativeAccess native={native} useProjection={useProjection} t={t} />}
      t={t}
    />
  )
}
