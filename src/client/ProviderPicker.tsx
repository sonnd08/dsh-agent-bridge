/** Model selector with a provider rail, a searchable model list, and a reasoning column. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_EFFORT, markedEffort } from '../model-prefs.ts'
import { IconSettingsOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './ToolCard.tsx'
import css from './ProviderPicker.module.css'

/** Provider id of a rail: `dsh` is the harness's own model catalog. */
export type PickerEngine = string

/** One reasoning level. */
export interface PickerEffort { readonly id: string; readonly name: string }

/** One selectable model. */
export interface PickerModel {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  readonly efforts: readonly PickerEffort[]
}

/** One rail entry and its models. */
export interface PickerGroup {
  readonly engine: PickerEngine
  readonly label: string
  readonly models: readonly PickerModel[]
  /** Text shown instead of the list, for example while the models load. */
  readonly status?: string | undefined
  /** Marker color of an added instance. */
  readonly accent?: string | undefined
}

/** What the composer has selected. */
export interface PickerCurrent {
  readonly engine: PickerEngine
  readonly modelId: string
  readonly effort: string
}

const FAVORITES_RAIL = 'favorites'
const LAST_RAIL_KEY = 'agent-bridge:selector-rail'

function readLastRail(): string | undefined {
  try {
    return localStorage.getItem(LAST_RAIL_KEY) ?? undefined
  } catch {
    return undefined // No browser storage: the selector opens on the provider in use.
  }
}

function saveLastRail(rail: string): void {
  try {
    localStorage.setItem(LAST_RAIL_KEY, rail)
  } catch { /* no browser storage: the rail is not remembered */ }
}
const PANEL_WIDTH = 560

function RailIcon({ engine, accent }: { engine: PickerEngine | typeof FAVORITES_RAIL; accent?: string | undefined }): ReactNode {
  if (engine === FAVORITES_RAIL) return <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden><path fill="currentColor" d="m8 1.3 2.07 4.2 4.63.67-3.35 3.27.79 4.61L8 11.87l-4.14 2.18.79-4.61L1.3 6.17l4.63-.67z" /></svg>
  return <span className={css.markWrap}><span className={css.mark} data-engine={engine.split('@')[0]} aria-hidden />{accent !== undefined && <span className={css.accentDot} style={{ background: accent }} />}</span>
}

/**
 * Trigger button and its panel.
 * @param props - the provider groups, the selection, and the pick callback.
 * @returns the button; the panel portals to the document body because the docked composer contains the trigger.
 */
export function ProviderPicker({ groups, current, label, effortLabel, locked, favorites, onToggleFavorite, onPick, speed, access, accessChip, onOpenSettings, savedEfforts, t }: {
  groups: readonly PickerGroup[]
  current: PickerCurrent
  label: string
  effortLabel?: string | undefined
  locked?: boolean | undefined
  favorites: readonly string[]
  onToggleFavorite: (key: string) => void
  /** Standard / Fast control; absent for providers without speed tiers. */
  speed?: { readonly available: boolean; readonly fast: boolean; readonly onChange: (fast: boolean) => void } | undefined
  /** Access control of the selected provider. */
  access?: ReactNode
  /** Access control of the chat bar, beside the selector. */
  accessChip?: ReactNode
  /** Saved reasoning level of each model, by `engine/model` key. */
  savedEfforts?: Readonly<Record<string, string>> | undefined
  /** Opens the plugin's settings; absent hides the gear. */
  onOpenSettings?: (() => void) | undefined
  onPick: (engine: PickerEngine, modelId: string, effort: string | undefined) => void
  t: Translate
}) {
  const [open, setOpen] = useState(false)
  const [rail, setRail] = useState<string>(current.engine)
  const [query, setQuery] = useState('')
  const [hovered, setHovered] = useState<string | undefined>(undefined)
  const [position, setPosition] = useState<CSSProperties>({})
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const rows = useMemo(() => {
    const all = groups.flatMap(group => group.models.map(model => ({ engine: group.engine, model, key: `${group.engine}/${model.id}` })))
    const inRail = rail === FAVORITES_RAIL ? all.filter(row => favorites.includes(row.key)).sort((a, b) => favorites.indexOf(a.key) - favorites.indexOf(b.key)) : all.filter(row => row.engine === rail)
    const needle = query.trim().toLowerCase()
    return needle === '' ? inRail : inRail.filter(row => row.model.name.toLowerCase().includes(needle))
  }, [groups, rail, favorites, query])

  const close = (): void => { setOpen(false); setQuery(''); setHovered(undefined) }
  const chooseRail = (next: string): void => { setRail(next); saveLastRail(next); setHovered(undefined) }
  const toggle = (): void => {
    if (open) { close(); return }
    const last = readLastRail()
    setRail(last !== undefined && (last === FAVORITES_RAIL || groups.some(group => group.engine === last)) ? last : current.engine)
    setOpen(true)
  }
  const pick = (engine: PickerEngine, modelId: string, effort: string | undefined): void => { close(); onPick(engine, modelId, effort) }
  useLayoutEffect(() => {
    if (!open || trigger.current === null) return
    const rect = trigger.current.getBoundingClientRect()
    setPosition({ right: Math.max(12, window.innerWidth - rect.right), bottom: window.innerHeight - rect.top + 8, width: Math.min(PANEL_WIDTH, window.innerWidth - 24) })
    search.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node
      // The access menu and its risk dialog portal to the document body while the panel stays open.
      if (target instanceof Element && target.closest('[role="menu"],[role="dialog"],[role="alertdialog"]') !== null) return
      if (panel.current?.contains(target) !== true && trigger.current?.contains(target) !== true) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); return }
      if (!event.metaKey && !event.ctrlKey) return
      const row = /^[1-9]$/.test(event.key) ? rows[Number(event.key) - 1] : undefined
      if (row === undefined) return
      event.preventDefault()
      pick(row.engine, row.model.id, undefined)
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, rows])

  const selectedKey = `${current.engine}/${current.modelId}`
  const focused = rows.find(row => row.key === hovered) ?? rows.find(row => row.key === selectedKey) ?? rows[0]
  const marked = markedEffort({ engines: {}, favorites: [], ...savedEfforts === undefined ? {} : { efforts: savedEfforts } }, focused?.key, { key: selectedKey, effort: current.effort })
  const status = rail === FAVORITES_RAIL ? undefined : groups.find(group => group.engine === rail)?.status

  return (
    <>
      <button
        ref={trigger} type="button" className={css.trigger} data-testid="ext-provider-trigger" data-engine-selected={current.engine}
        disabled={locked === true} aria-haspopup="dialog" aria-expanded={open} onClick={toggle}
      >
        <span className={css.triggerIcon}><RailIcon engine={current.engine} /></span>
        <span>{label}</span>
        {effortLabel !== undefined && effortLabel !== '' && <span className={css.triggerEffort}>{effortLabel}</span>}
        {speed?.fast === true && <svg className={css.triggerFast} data-testid="ext-provider-fast-on" viewBox="0 0 16 16" width="13" height="13" role="img" aria-label={t('picker.fast')}><path fill="currentColor" d="M9.200 1 3 9h4.200L6.500 15 13 6.800H8.700z" /></svg>}
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden><path d={open ? 'm3 7.5 3-3 3 3' : 'm3 4.5 3 3 3-3'} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {accessChip}
      {open && createPortal(
        <div ref={panel} className={css.panel} style={position} role="dialog" aria-label={t('picker.title')} data-testid="ext-provider-panel">
          <div className={css.body}>
          <nav className={css.rail}>
            <button type="button" className={rail === FAVORITES_RAIL ? css.railActive : css.railItem} data-testid="ext-provider-rail-favorites" title={t('picker.favorites')} aria-label={t('picker.favorites')} onClick={() => { chooseRail(FAVORITES_RAIL) }}>
              <RailIcon engine={FAVORITES_RAIL} />
            </button>
            <span className={css.railRule} />
            {groups.map(group => (
              <button
                key={group.engine} type="button" className={rail === group.engine ? css.railActive : css.railItem} data-testid={`ext-provider-rail-${group.engine}`}
                title={group.label} aria-label={group.label} onClick={() => { chooseRail(group.engine) }}
              ><RailIcon engine={group.engine} accent={group.accent} /></button>
            ))}
          </nav>
          <div className={css.models}>
            <input ref={search} className={css.search} data-testid="ext-provider-search" placeholder={t('picker.search')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
            <ul className={css.list} onPointerLeave={() => { setHovered(undefined) }}>
              {rows.map((row, index) => (
                <li key={row.key} className={row.key === focused?.key ? css.rowFocused : css.row} onPointerEnter={() => { setHovered(row.key) }}>
                  <button type="button" className={css.rowPick} data-testid="ext-provider-model" data-model={row.model.id} title={row.model.description} onClick={() => { pick(row.engine, row.model.id, undefined) }}>
                    <span className={css.rowIcon}><RailIcon engine={row.engine} /></span>
                    <span className={css.rowName}>{row.model.name}</span>
                    {row.key === selectedKey && <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden><path d="m2.500 6.500 2.500 2.500 4.500-5.500" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                  </button>
                  <button
                    type="button" className={favorites.includes(row.key) ? css.starOn : css.star} aria-pressed={favorites.includes(row.key)} aria-label={t('picker.favorites')}
                    onClick={() => { onToggleFavorite(row.key) }}
                  ><RailIcon engine={FAVORITES_RAIL} /></button>
                  {index < 9 && <kbd className={css.shortcut}>⌘{index + 1}</kbd>}
                </li>
              ))}
              {rows.length === 0 && <li className={css.empty}>{status ?? t(rail === FAVORITES_RAIL ? 'picker.noFavorites' : 'picker.empty')}</li>}
            </ul>
          </div>
          <div className={css.efforts}>
            <header className={css.effortsHeader}><span>{t('picker.reasoning')}</span><span className={css.effortsModel}>{focused?.model.name}</span></header>
            {focused?.model.efforts.map(effort => (
              <button
                key={effort.id} type="button" className={css.effort} data-testid="ext-provider-effort" data-effort={effort.id}
                onClick={() => { pick(focused.engine, focused.model.id, effort.id) }}
              >
                <span>{effort.name}</span>
                {effort.id === DEFAULT_EFFORT && <span className={css.effortDefault}>{t('picker.default')}</span>}
                {effort.id === marked && <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden><path d="m2.500 6.500 2.500 2.500 4.500-5.500" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </button>
            ))}
            {focused !== undefined && focused.model.efforts.length === 0 && <p className={css.empty}>{t('picker.noReasoning')}</p>}
          </div>
          </div>
          {(speed !== undefined || access !== undefined || onOpenSettings !== undefined) && (
            <footer className={css.footer}>
              <div className={css.footerLeft}>
              {onOpenSettings !== undefined && (
                <button type="button" className={css.gear} data-testid="ext-provider-settings" aria-label={t('picker.settings')} title={t('picker.settings')} onClick={() => { close(); onOpenSettings() }}>
                  <IconSettingsOutlineMedium size={16} />
                </button>
              )}
              {speed !== undefined
                ? (
                  <div className={css.speed} role="group" aria-label={t('picker.speed')}>
                    <button type="button" className={speed.fast ? css.speedOption : css.speedActive} data-testid="ext-provider-standard" aria-pressed={!speed.fast} onClick={() => { speed.onChange(false) }}>{t('picker.standard')}</button>
                    <button type="button" className={speed.fast ? css.speedActive : css.speedOption} data-testid="ext-provider-fast" aria-pressed={speed.fast} disabled={!speed.available} onClick={() => { speed.onChange(true) }}>
                      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><path fill="currentColor" d="M9.200 1 3 9h4.200L6.500 15 13 6.800H8.700z" /></svg>
                      {t('picker.fast')}
                    </button>
                  </div>
                )
                : null}
              </div>
              {access !== undefined && <div className={css.access} data-testid="ext-provider-access">{access}</div>}
            </footer>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
