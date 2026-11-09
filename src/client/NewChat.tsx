/** Provider selection in the harness composer: the model seat. Each provider is a route of the harness model catalog. */
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import {
  PermissionIconAutoReviewRegular, PermissionIconFullAccessRegular, PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { orderAccessPresets } from './access-order.ts'
import { LoginBar } from './LoginBar.tsx'
import { engineRailModels, visibleEngineModels, visibleRows, type EngineModelRow } from './model-names.ts'
import { publishDshCatalog } from './dsh-catalog-store.ts'
import { useProviders } from './providers-store.ts'
import { useModelPrefs } from './model-prefs-store.ts'
import { enginePrefs, isEngineEnabled, orderRows, pickEffort, toggleFavorite } from '../model-prefs.ts'
import { PermissionPicker, PermissionPopover, type PermissionOption } from './PermissionPicker.tsx'
import { ProviderPicker, type PickerCurrent, type PickerEngine, type PickerGroup } from './ProviderPicker.tsx'
import type { Translate } from './ToolCard.tsx'
import { routeOf } from '../native-routes.ts'
import type { InfoWire, ModelPrefsWire, PrefsEngine } from '../protocol.ts'

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
  return orderAccessPresets(options).map((option) => {
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
  const { catalog, loadCatalog, selectModel, codexEnabled, subscribeBridge, nativePermission } = services
  const state = useSyncExternalStore(catalog?.subscribe ?? noSubscribe, catalog?.getSnapshot ?? noCatalog)
  useEffect(() => { loadCatalog() }, [loadCatalog])
  const codexAvailable = useSyncExternalStore(subscribeBridge, codexEnabled)
  const [prefs, savePrefs] = useModelPrefs()
  const { providers } = useProviders()
  const offered = providers.filter(provider => (provider.engine !== 'codex' || codexAvailable) && isEngineEnabled(prefs, provider.id))
  const engineRoutes = useMemo(() => new Set(providers.map(provider => routeOf(provider.id))), [providers])

  const dshRows = useMemo((): EngineModelRow[] => dshProviderOrder(state.groups.filter(group => !engineRoutes.has(group.id))).flatMap(group => group.models.map(model => ({
    id: `${group.id}/${model.id}`, name: model.name, description: group.name, efforts: model.reasoning?.efforts ?? [],
  }))), [state.groups, engineRoutes])
  useEffect(() => { if (dshRows.length > 0) publishDshCatalog(dshRows) }, [dshRows])
  const loading = state.error ?? (state.status === 'loading' ? t('picker.loading') : undefined)
  const dshGroup: PickerGroup = {
    engine: 'dsh',
    label: t('picker.dsh'),
    models: visibleRows('dsh', orderRows(dshRows, enginePrefs(prefs, 'dsh').order), prefs),
    status: loading,
  }
  // Claude Code and Codex are routes of the harness catalog, so a pick changes the model of this chat.
  const engineGroups = offered.map((provider): PickerGroup => {
    const models = state.groups.find(group => group.id === routeOf(provider.id))?.models ?? []
    return {
      engine: provider.id, label: provider.label, status: loading, ...provider.accent === undefined ? {} : { accent: provider.accent },
      models: engineRailModels(provider.id, provider.label, models, prefs),
    }
  })
  const groups: readonly PickerGroup[] = [dshGroup, ...engineGroups]

  const selectedModel = state.groups.find(group => group.id === state.current?.provider)?.models.find(item => item.id === state.current?.model)
  const selectedEffort = state.current?.reasoningEffort ?? selectedModel?.reasoning?.defaultEffort ?? ''
  const selectedRail = state.current === null ? undefined : providers.find(provider => routeOf(provider.id) === state.current?.provider)?.id
  const engine: PickerEngine = selectedRail ?? 'dsh'
  const current: PickerCurrent = {
    engine,
    modelId: state.current === null ? '' : selectedRail === undefined ? `${state.current.provider}/${state.current.model}` : state.current.model,
    effort: selectedEffort,
  }
  const label = selectedModel?.name ?? state.current?.model ?? t('picker.title')
  const effortLabel = selectedModel?.reasoning?.efforts.find(level => level.id === selectedEffort)?.name ?? ''

  const pick = (target: PickerEngine, modelId: string, explicit: string | undefined): void => {
    const supported = groups.find(group => group.engine === target)?.models.find(model => model.id === modelId)?.efforts.map(level => level.id) ?? []
    const { effort, prefs: nextPrefs } = pickEffort(prefs, { key: `${current.engine}/${current.modelId}`, effort: current.effort }, { key: `${target}/${modelId}`, efforts: supported }, explicit)
    if (nextPrefs !== prefs) savePrefs(nextPrefs)
    const route = target === 'dsh' ? undefined : routeOf(target)
    for (const group of state.groups) {
      if (route !== undefined && group.id !== route) continue
      const model = group.models.find(item => (route === undefined ? `${group.id}/${item.id}` : item.id) === modelId)
      if (model === undefined) continue
      const level = effort !== '' ? effort : model.reasoning?.defaultEffort
      selectModel({ provider: group.id, model: model.id, ...level === undefined ? {} : { reasoningEffort: level } })
      return
    }
    // A custom model is not in the catalog, and the engine decides if it exists.
    if (route !== undefined) selectModel({ provider: route, model: modelId })
  }

  const native = nativePermission()
  const nativeSelection = useProjection('permissions')
  const nativeCatalog = useSyncExternalStore(native?.catalog.subscribe ?? noSubscribe, native?.catalog.getSnapshot ?? noPermissionCatalog).value
  const accessChip = native === undefined || nativeCatalog === null || nativeSelection === undefined
    ? undefined
    : <PermissionPopover options={nativeAccessOptions(nativeCatalog.options, t)} value={nativeSelection.currentValue} riskValues={RISKY_NATIVE_PRESETS} locked={locked} onChange={(preset) => { void native.select(preset).catch((error: unknown) => { console.warn('agent-bridge: permission change failed', error) }) }} t={t} />
  return (
    <ProviderPicker
      groups={groups} current={current} label={label} effortLabel={effortLabel} locked={locked}
      favorites={prefs.favorites} onToggleFavorite={(key) => { savePrefs(toggleFavorite(prefs, key)) }} onPick={pick} accessChip={accessChip} onOpenSettings={services.openSettings} savedEfforts={prefs.efforts}
      access={native === undefined ? undefined : <NativeAccess native={native} useProjection={useProjection} t={t} />}
      t={t}
    />
  )
}

/**
 * The sign-in notice above the composer. It shows only when the selected model belongs to a provider that is not signed in.
 * @param props - the plugin services of the session and translate.
 * @returns the notice, or nothing.
 */
export function LoginDock({ services, t }: { services: SeatServices; t: Translate }) {
  const { catalog } = services
  const state = useSyncExternalStore(catalog?.subscribe ?? noSubscribe, catalog?.getSnapshot ?? noCatalog)
  const { providers } = useProviders()
  const provider = providers.find(entry => routeOf(entry.id) === state.current?.provider)
  return provider === undefined ? null : <LoginBar provider={provider.id} label={provider.label} t={t} />
}
