/** Model selector with a provider rail, a searchable model list, and a reasoning column. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Translate } from './ToolCard.tsx'
import css from './ProviderPicker.module.css'

/** Providers the rail can show; `dsh` is the harness's own model catalog. */
export type PickerEngine = 'dsh' | 'claude' | 'codex' | 'pi'

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
}

/** What the composer has selected. */
export interface PickerCurrent {
  readonly engine: PickerEngine
  readonly modelId: string
  readonly effort: string
}

const FAVORITES_RAIL = 'favorites'
const PANEL_WIDTH = 560

function RailIcon({ engine }: { engine: PickerEngine | typeof FAVORITES_RAIL }): ReactNode {
  if (engine === FAVORITES_RAIL) return <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden><path fill="currentColor" d="m8 1.3 2.07 4.2 4.63.67-3.35 3.27.79 4.61L8 11.87l-4.14 2.18.79-4.61L1.3 6.17l4.63-.67z" /></svg>
  return <span className={css.mark} data-engine={engine} aria-hidden />
}

/**
 * Trigger button and its panel.
 * @param props - the provider groups, the selection, and the pick callback.
 * @returns the button; the panel portals to the document body because the docked composer contains the trigger.
 */
export function ProviderPicker({ groups, current, label, effortLabel, locked, favorites, onToggleFavorite, onPick, t }: {
  groups: readonly PickerGroup[]
  current: PickerCurrent
  label: string
  effortLabel?: string | undefined
  locked?: boolean | undefined
  favorites: readonly string[]
  onToggleFavorite: (key: string) => void
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
    const inRail = rail === FAVORITES_RAIL ? all.filter(row => favorites.includes(row.key)) : all.filter(row => row.engine === rail)
    const needle = query.trim().toLowerCase()
    return needle === '' ? inRail : inRail.filter(row => row.model.name.toLowerCase().includes(needle))
  }, [groups, rail, favorites, query])

  const close = (): void => { setOpen(false); setQuery(''); setHovered(undefined) }
  const toggle = (): void => {
    if (open) { close(); return }
    setRail(current.engine)
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
  const status = rail === FAVORITES_RAIL ? undefined : groups.find(group => group.engine === rail)?.status

  return (
    <>
      <button
        ref={trigger} type="button" className={css.trigger} data-testid="ext-provider-trigger" data-engine-selected={current.engine}
        disabled={locked === true} aria-haspopup="dialog" aria-expanded={open} onClick={toggle}
      >
        <span>{label}</span>
        {effortLabel !== undefined && effortLabel !== '' && <span className={css.triggerEffort}>{effortLabel}</span>}
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden><path d={open ? 'm3 7.5 3-3 3 3' : 'm3 4.5 3 3 3-3'} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && createPortal(
        <div ref={panel} className={css.panel} style={position} role="dialog" aria-label={t('picker.title')} data-testid="ext-provider-panel">
          <nav className={css.rail}>
            <button type="button" className={rail === FAVORITES_RAIL ? css.railActive : css.railItem} data-testid="ext-provider-rail-favorites" title={t('picker.favorites')} aria-label={t('picker.favorites')} onClick={() => { setRail(FAVORITES_RAIL) }}>
              <RailIcon engine={FAVORITES_RAIL} />
            </button>
            <span className={css.railRule} />
            {groups.map(group => (
              <button
                key={group.engine} type="button" className={rail === group.engine ? css.railActive : css.railItem} data-testid={`ext-provider-rail-${group.engine}`}
                title={group.label} aria-label={group.label} onClick={() => { setRail(group.engine); setHovered(undefined) }}
              ><RailIcon engine={group.engine} /></button>
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
                {focused.key === selectedKey && effort.id === current.effort && <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden><path d="m2.500 6.500 2.500 2.500 4.500-5.500" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </button>
            ))}
            {focused !== undefined && focused.model.efforts.length === 0 && <p className={css.empty}>{t('picker.noReasoning')}</p>}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
