/** The Models page of the settings dialog: order, favorites, hidden models and custom models per provider. */
import { useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { addCustomModel, enginePrefs, moveModel, normalizeCustomSlug, removeCustomModel, toggleAllHidden, toggleFavorite, toggleHidden } from '../model-prefs.ts'
import type { PrefsEngine } from '../protocol.ts'
import { useInfo } from './info.ts'
import { engineCatalog, type EngineModelRow } from './model-names.ts'
import { useModelPrefs } from './model-prefs-store.ts'
import css from './ModelsSection.module.css'

/** Props the settings shell, the locale seat and the plugin entry pass. */
export type ModelsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'agent-bridge'> & { getDefaultCwd: () => string; codexEnabled: () => boolean }

const STAR = 'm8 1.3 2.07 4.2 4.63.67-3.35 3.27.79 4.61L8 11.87l-4.14 2.18.79-4.61L1.3 6.17l4.63-.67z'

/**
 * Render the page.
 * @param props - locale seat and plugin services.
 * @returns the page.
 */
export function ModelsSection({ t, getDefaultCwd, codexEnabled }: ModelsSectionProps) {
  const engines: readonly { id: PrefsEngine; label: string }[] = [...codexEnabled() ? [{ id: 'codex' as const, label: 'Codex' }] : [], { id: 'claude' as const, label: 'Claude Code' }]
  const [selected, setSelected] = useState<PrefsEngine>(engines[0]?.id ?? 'claude')
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(false)
  const [slug, setSlug] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [prefs, save] = useModelPrefs()
  const { info, error: loadError } = useInfo(selected, getDefaultCwd())
  const settings = enginePrefs(prefs, selected)
  const catalog = useMemo(() => engineCatalog(selected, info, prefs), [selected, info, prefs])
  const listed = catalog.filter(row => row.custom !== true).map(row => row.id)
  const isFavorite = (row: EngineModelRow): boolean => prefs.favorites.includes(`${selected}/${row.id}`)
  const isHidden = (row: EngineModelRow): boolean => row.custom !== true && settings.hidden.includes(row.id)
  const favorites = catalog.filter(isFavorite)
  const shown = catalog.filter(row => !isFavorite(row) && !isHidden(row))
  const hidden = catalog.filter(row => !isFavorite(row) && isHidden(row))
  const display = [...favorites, ...shown, ...hidden].map(row => row.id)
  const needle = filter.trim().toLowerCase()
  const matches = (row: EngineModelRow): boolean => needle === '' || row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle)
  const allHidden = listed.length > 0 && listed.every(id => settings.hidden.includes(id))

  const add = (): void => {
    const cleaned = normalizeCustomSlug(slug)
    if (cleaned === undefined) { setError(t('models.invalidSlug')); return }
    if (catalog.some(row => row.id === cleaned)) { setError(t('models.duplicateSlug')); return }
    save(addCustomModel(prefs, selected, cleaned))
    setSlug('')
    setError(undefined)
    setAdding(false)
  }

  const renderRows = (rows: readonly EngineModelRow[], group: readonly EngineModelRow[]) => rows.filter(matches).map((row) => {
    const ids = group.map(item => item.id)
    const position = ids.indexOf(row.id)
    const off = isHidden(row)
    return (
      <li key={row.id} className={off ? css.rowHidden : css.row} data-testid="ext-model-row" data-model={row.id}>
        <button type="button" className={isFavorite(row) ? css.starOn : css.star} aria-pressed={isFavorite(row)} aria-label={t('picker.favorites')} data-testid="ext-model-star" onClick={() => { save(toggleFavorite(prefs, `${selected}/${row.id}`)) }}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d={STAR} fill={isFavorite(row) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        </button>
        <span className={css.name}>{row.name}</span>
        <code className={css.slug}>{row.id}</code>
        <span className={css.spacer} />
        {!off && (
          <>
            <button type="button" className={css.arrow} data-testid="ext-model-up" aria-label={t('models.moveUp')} disabled={position <= 0} onClick={() => { save(moveModel(prefs, selected, ids, display, row.id, -1)) }}>↑</button>
            <button type="button" className={css.arrow} data-testid="ext-model-down" aria-label={t('models.moveDown')} disabled={position === -1 || position === ids.length - 1} onClick={() => { save(moveModel(prefs, selected, ids, display, row.id, 1)) }}>↓</button>
          </>
        )}
        {row.custom === true
          ? <button type="button" className={css.remove} data-testid="ext-model-remove" aria-label={t('models.remove')} onClick={() => { save(removeCustomModel(prefs, selected, row.id)) }}>×</button>
          : <button type="button" role="switch" className={off ? css.switchOff : css.switchOn} data-testid="ext-model-toggle" aria-checked={!off} aria-label={row.name} onClick={() => { save(toggleHidden(prefs, selected, row.id)) }}><span /></button>}
      </li>
    )
  })

  return (
    <section className={css.page} data-testid="ext-models">
      <h2 className={css.title}>{t('models.title')}</h2>
      <div className={css.layout}>
        <nav className={css.engines}>
          {engines.map(engine => (
            <button key={engine.id} type="button" className={selected === engine.id ? css.engineActive : css.engine} data-testid={`ext-models-engine-${engine.id}`} onClick={() => { setSelected(engine.id); setFilter(''); setAdding(false); setError(undefined) }}>{engine.label}</button>
          ))}
        </nav>
        <div className={css.content}>
          <p className={css.hint}>{t('models.hint')}</p>
          <div className={css.tools}>
            <input className={css.filter} data-testid="ext-models-filter" placeholder={t('models.filter')} value={filter} onChange={(event) => { setFilter(event.target.value) }} />
            <button type="button" className={css.action} data-testid="ext-models-toggle-all" disabled={listed.length === 0} onClick={() => { save(toggleAllHidden(prefs, selected, listed)) }}>{t(allHidden ? 'models.enableAll' : 'models.disableAll')}</button>
            <span className={css.count} data-testid="ext-models-count">{t('models.count', { total: catalog.length, favorites: favorites.length, hidden: hidden.length })}</span>
            <button type="button" className={css.action} data-testid="ext-models-add" onClick={() => { setAdding(open => !open); setError(undefined) }}>+ {t('models.addCustom')}</button>
          </div>
          {adding && (
            <div className={css.addRow}>
              <input
                className={css.filter} data-testid="ext-models-slug" autoFocus placeholder={t('models.slugPlaceholder')} value={slug}
                onChange={(event) => { setSlug(event.target.value); setError(undefined) }} onKeyDown={(event) => { if (event.key === 'Enter') add() }}
              />
              <button type="button" className={css.action} data-testid="ext-models-add-save" onClick={add}>{t('models.add')}</button>
              {error !== undefined && <span className={css.error} role="alert">{error}</span>}
            </div>
          )}
          {loadError !== undefined && <p className={css.error} role="alert">{loadError}</p>}
          {favorites.some(matches) && <><h3 className={css.group}>{t('picker.favorites')}</h3><ul className={css.list}>{renderRows(favorites, favorites)}</ul></>}
          {shown.some(matches) && <><h3 className={css.group}>{t('models.all')}</h3><ul className={css.list}>{renderRows(shown, shown)}</ul></>}
          {hidden.some(matches) && <><h3 className={css.group}>{t('models.hidden')}</h3><ul className={css.list}>{renderRows(hidden, hidden)}</ul></>}
        </div>
      </div>
    </section>
  )
}
