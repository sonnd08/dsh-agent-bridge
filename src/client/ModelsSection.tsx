/** The provider list and each provider's models, on the Agent Bridge settings page. */
import { useMemo, useState } from 'react'
import { addCustomModel, enginePrefs, isEngineEnabled, moveFavorite, moveModel, normalizeCustomSlug, orderFavorites, removeCustomModel, orderRows, toggleAllHidden, toggleEngine, toggleFavorite, toggleHidden } from '../model-prefs.ts'
import type { InfoWire, LoginWire, ModelPrefsWire, PrefsEngine } from '../protocol.ts'
import type { AboutRow } from './about.ts'
import { AddProviderDialog } from './AddProviderDialog.tsx'
import { useDshCatalog } from './dsh-catalog-store.ts'
import { useInfos } from './info.ts'
import { LoginBar } from './LoginBar.tsx'
import { useLogins } from './login-store.ts'
import { useProviders, type ProviderEntry } from './providers-store.ts'
import { engineCatalog, type EngineModelRow } from './model-names.ts'
import { useModelPrefs } from './model-prefs-store.ts'
import type { Translate } from './ToolCard.tsx'
import css from './ModelsSection.module.css'

const STAR = 'm8 1.3 2.07 4.2 4.63.67-3.35 3.27.79 4.61L8 11.87l-4.14 2.18.79-4.61L1.3 6.17l4.63-.67z'

/** @param info - what the provider offers. @param error - its load error. @param row - its about row, if any. @param login - its sign-in state, if known. @param t - translate. @returns the status line under a provider's name. */
function providerStatus(engine: string, info: InfoWire | undefined, error: string | undefined, row: AboutRow | undefined, login: LoginWire | undefined, t: Translate): string {
  if (row?.status === 'missing') return t('about.status.missing')
  if (login?.signedIn === false) return t('providers.notSignedIn')
  if (error !== undefined) return t('providers.notReady')
  // Codex reports no account even when it is signed in, so until the sign-in check answers only Claude can say "not signed in".
  if (login?.signedIn === undefined && engine === 'claude' && info?.account?.loggedIn === false) return t('providers.notSignedIn')
  const plan = login?.plan ?? info?.account?.plan
  return plan === undefined ? t('providers.available') : t('providers.authenticated', { plan: plan.charAt(0).toUpperCase() + plan.slice(1) })
}

/** @param entry - an added instance. @returns the command that signs it in. */
function loginCommand(entry: ProviderEntry): string {
  const home = entry.instance?.home ?? ''
  return entry.engine === 'codex' ? `CODEX_HOME=${home} ${entry.instance?.binaryPath ?? 'codex'} login` : `CLAUDE_CONFIG_DIR=${home} ${entry.instance?.binaryPath ?? 'claude'} auth login`
}

/**
 * Render the providers and the models of the selected one.
 * @param props - locale seat, plugin services, and the rows of the about response.
 * @returns the panel.
 */
export function ProvidersPanel({ t, getDefaultCwd, codexEnabled, rows }: { t: Translate; getDefaultCwd: () => string; codexEnabled: () => boolean; rows: readonly AboutRow[] }) {
  // The about response decides once it arrives; the plugin's own flag is not known yet right after a page load.
  const codexOn = rows.length === 0 ? codexEnabled() : rows.some(row => row.id === 'codex' && row.status !== 'off')
  const { providers, add: addInstance, remove: removeInstance } = useProviders()
  const entries = providers.filter(provider => provider.engine !== 'codex' || codexOn)
  const [addOpen, setAddOpen] = useState(false)
  const dshRows = useDshCatalog()
  const [tab, setTab] = useState<string>('favorites')
  // Rows stay on the Favorites tab after a change, so a mistake can be undone; opening the tab again refreshes them.
  const [frozenFavorites, setFrozenFavorites] = useState<readonly string[] | undefined>(undefined)
  const selected: PrefsEngine = tab === 'favorites' ? 'dsh' : tab
  const openTab = (next: string): void => { setTab(next); setFrozenFavorites(undefined); setFilter(''); setAdding(false); setError(undefined) }
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(false)
  const [slug, setSlug] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [prefs, save] = useModelPrefs()
  const infos = useInfos(entries.map(entry => entry.id), getDefaultCwd())
  const logins = useLogins(entries.map(entry => entry.id))
  const info = infos[selected]?.info
  const loadError = infos[selected]?.error
  const settings = enginePrefs(prefs, selected)
  const dshCatalog = useMemo(() => orderRows(dshRows, enginePrefs(prefs, 'dsh').order), [dshRows, prefs])
  const catalog = useMemo(() => selected === 'dsh' ? dshCatalog : engineCatalog(selected, info, prefs), [selected, dshCatalog, info, prefs])
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

  const catalogs: Readonly<Record<string, readonly EngineModelRow[]>> = { dsh: dshCatalog, ...Object.fromEntries(entries.map(entry => [entry.id, engineCatalog(entry.id, infos[entry.id]?.info, prefs)])) }
  const activeEntry = entries.find(entry => entry.id === tab)
  const favoriteKeys = frozenFavorites ?? prefs.favorites
  const favoriteRows = favoriteKeys.map((key) => {
    const [engine = '', ...rest] = key.split('/')
    const id = rest.join('/')
    const listed = catalogs[engine]?.find(row => row.id === id)
    return { key, engine, id, name: listed?.name ?? (engine === 'dsh' ? rest.slice(1).join('/') : id), canHide: listed !== undefined && listed.custom !== true }
  })
  const keep = (next: ModelPrefsWire): void => {
    setFrozenFavorites(favoriteKeys)
    save(next)
  }
  const moveRow = (key: string, delta: -1 | 1): void => {
    const moved = moveFavorite(prefs, favoriteKeys, key, delta)
    setFrozenFavorites(moved.shown)
    save(moved.prefs)
  }

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
      <div className={css.titleRow}><h3 className={css.title}>{t('providers.title')}</h3><button type="button" className={css.titleAdd} data-testid="ext-provider-add-title" aria-label={t('providers.add')} title={t('providers.add')} onClick={() => { setAddOpen(true) }}>+</button></div>
      <div className={css.layout}>
        <nav className={css.engines}>
          <div className={tab === 'favorites' ? css.engineActive : css.engine} data-testid="ext-models-provider-favorites">
            <button type="button" className={css.engineSelect} data-testid="ext-models-engine-favorites" onClick={() => { openTab('favorites') }}>
              <span className={css.engineHead}>
                <svg className={css.favoritesMark} viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d={STAR} fill="currentColor" /></svg>
                <span>{t('picker.favorites')}</span>
              </span>
              <span className={css.engineStatus}>{t('providers.favoriteCount', { n: prefs.favorites.length })}</span>
            </button>
          </div>
          <div className={tab === 'dsh' ? css.engineActive : css.engine} data-testid="ext-models-provider-dsh">
            <button type="button" className={css.engineSelect} data-testid="ext-models-engine-dsh" onClick={() => { openTab('dsh') }}>
              <span className={css.engineHead}>
                <span className={css.engineMark} data-engine="dsh" aria-hidden />
                <span>{t('picker.dsh')}</span>
                {rows.find(row => row.id === 'dsh')?.version !== undefined && <code className={css.slug}>v{rows.find(row => row.id === 'dsh')?.version}</code>}
              </span>
              <span className={css.engineStatus}>{t('providers.favoriteCount', { n: dshRows.length })}</span>
            </button>
          </div>
          {entries.map((entry) => {
            const about = rows.find(row => row.id === entry.id)
            const enabled = isEngineEnabled(prefs, entry.id)
            return (
              <div key={entry.id} className={tab === entry.id ? css.engineActive : css.engine} data-testid={`ext-models-provider-${entry.id}`}>
                <button type="button" className={css.engineSelect} data-testid={`ext-models-engine-${entry.id}`} onClick={() => { openTab(entry.id) }}>
                  <span className={css.engineHead}>
                    <span className={css.engineMark} data-engine={entry.engine} aria-hidden />
                    {entry.accent !== undefined && <span className={css.accentDot} style={{ background: entry.accent }} />}
                    <span>{entry.label}</span>
                    {about?.version !== undefined && <code className={css.slug}>v{about.version}</code>}
                  </span>
                  <span className={css.engineStatus}>{providerStatus(entry.engine, infos[entry.id]?.info, infos[entry.id]?.error, about, logins[entry.id], t)}</span>
                </button>
                <button type="button" role="switch" className={enabled ? css.switchOn : css.switchOff} data-testid={`ext-models-enable-${entry.id}`} aria-checked={enabled} aria-label={entry.label} onClick={() => { save(toggleEngine(prefs, entry.id)) }}><span /></button>
              </div>
            )
          })}
          <button type="button" className={css.addProvider} data-testid="ext-provider-add" onClick={() => { setAddOpen(true) }}>+ {t('providers.add')}</button>
        </nav>
        <div className={css.content}>
          {tab === 'favorites'
            ? (
              <>
                <h4 className={css.modelsTitle}>{t('picker.favorites')}</h4>
                <p className={css.hint}>{t('models.favoritesHint')}</p>
                <ul className={css.list}>
                  {favoriteRows.map((row, index) => {
                    const starred = prefs.favorites.includes(row.key)
                    const off = row.canHide && enginePrefs(prefs, row.engine).hidden.includes(row.id)
                    return (
                      <li key={row.key} className={off ? css.rowHidden : css.row} data-testid="ext-favorite-row" data-model={row.key}>
                        <button type="button" className={starred ? css.starOn : css.star} aria-pressed={starred} aria-label={t('picker.favorites')} data-testid="ext-favorite-star" onClick={() => { keep(orderFavorites(toggleFavorite(prefs, row.key), favoriteKeys)) }}>
                          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d={STAR} fill={starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
                        </button>
                        <span className={css.engineMark} data-engine={row.engine.split('@')[0]} aria-hidden />
                        <span className={css.name}>{row.name}</span>
                        <code className={css.slug}>{row.id}</code>
                        <span className={css.spacer} />
                        <button type="button" className={css.arrow} data-testid="ext-favorite-up" aria-label={t('models.moveUp')} disabled={index === 0} onClick={() => { moveRow(row.key, -1) }}>↑</button>
                        <button type="button" className={css.arrow} data-testid="ext-favorite-down" aria-label={t('models.moveDown')} disabled={index === favoriteRows.length - 1} onClick={() => { moveRow(row.key, 1) }}>↓</button>
                        {row.canHide
                          ? <button type="button" role="switch" className={off ? css.switchOff : css.switchOn} data-testid="ext-favorite-toggle" aria-checked={!off} aria-label={row.name} onClick={() => { keep(toggleHidden(prefs, row.engine, row.id)) }}><span /></button>
                          : <span className={css.switchSpace} />}
                      </li>
                    )
                  })}
                  {favoriteRows.length === 0 && <li className={css.hint}>{t('picker.noFavorites')}</li>}
                </ul>
              </>
            )
            : (
              <>
          {activeEntry !== undefined && <LoginBar provider={activeEntry.id} label={activeEntry.label} t={t} />}
          {activeEntry?.instance !== undefined && (
                <div className={css.instanceBar}>
                  <span>{t('providers.loginHint')}</span>
                  <code className={css.loginCommand}>{loginCommand(activeEntry)}</code>
                  <button type="button" className={css.action} data-testid="ext-provider-remove" onClick={() => { const id = activeEntry.instance?.id ?? ''; removeInstance(id).then((failure) => { if (failure === undefined) openTab('favorites'); else setError(failure) }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }) }}>{t('providers.remove')}</button>
                  {error !== undefined && !adding && <span className={css.error} role="alert" data-testid="ext-provider-remove-error">{error}</span>}
                </div>
              )}
          <h4 className={css.modelsTitle}>{t('models.title')}</h4>
          <p className={css.hint}>{t('models.hint')}</p>
          <div className={css.tools}>
            <input className={css.filter} data-testid="ext-models-filter" placeholder={t('models.filter')} value={filter} onChange={(event) => { setFilter(event.target.value) }} />
            <button type="button" className={css.action} data-testid="ext-models-toggle-all" disabled={listed.length === 0} onClick={() => { save(toggleAllHidden(prefs, selected, listed)) }}>{t(allHidden ? 'models.enableAll' : 'models.disableAll')}</button>
            <span className={css.count} data-testid="ext-models-count">{t(favorites.length === 1 ? 'models.countOne' : 'models.count', { total: catalog.length, favorites: favorites.length, hidden: hidden.length })}</span>
            {tab !== 'dsh' && <button type="button" className={css.action} data-testid="ext-models-add" onClick={() => { setAdding(open => !open); setError(undefined) }}>+ {t('models.addCustom')}</button>}
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
              </>
            )}
        </div>
      </div>
      {addOpen && <AddProviderDialog taken={providers.map(entry => entry.instance?.id ?? '')} t={t} onAdd={addInstance} onClose={() => { setAddOpen(false) }} />}
    </section>
  )
}
