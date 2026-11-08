/** Main panel shown while an external session is selected. */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button, Menu, MenuItemButton, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { draftIdFor, DRAFT_PATH, engineOfSession, providerEngine, providerInstance, providerOfSession, type AttachmentWire, type EngineName, type PermissionPreset, type PermissionWire } from '../protocol.ts'
import { engineGroup } from './NewChat.tsx'
import { engineLabels, fastTierOf, speedFor } from './model-names.ts'
import { bridgeAccessOptions, PermissionPicker, PermissionPopover } from './PermissionPicker.tsx'
import { useModelPrefs } from './model-prefs-store.ts'
import { enginePrefs, isEngineEnabled, orderRows, pickEffort, toggleFavorite } from '../model-prefs.ts'
import { ProviderPicker, type PickerEngine } from './ProviderPicker.tsx'
import { isDraft, type TranscriptController, type TranscriptState } from './transcript.ts'
import type { SessionsSnapshot } from './sessions.ts'
import { IconAlarm, IconArchive, IconBranch, IconCopy, IconEdit, IconMore, IconSearch, IconTrash } from './icons.tsx'
import { Markdown, Thinking, Todos, ToolCard } from './ToolCard.tsx'
import { buildTimeline } from './timeline.ts'
import { AttachmentChips, ComposerBar, SlashMenu, toAttachments, useChoices } from './ComposerBar.tsx'
import { useInfos } from './info.ts'
import { useProviders } from './providers-store.ts'
import { useDshCatalog } from './dsh-catalog-store.ts'
import { visibleRows } from './model-names.ts'
import { SpeakButton, useVoiceEnabled } from './voice.tsx'
import { RunningStatus } from './RunningStatus.tsx'
import { ScheduleBar } from './ScheduleBar.tsx'
import { SearchBox } from './SearchBox.tsx'
import { DirPicker } from './DirPicker.tsx'
import { ExtensionsTab } from './workbench/ExtensionsTab.tsx'
import { FilesTab } from './workbench/FilesTab.tsx'
import { GitTab } from './workbench/GitTab.tsx'
import { TasksTab } from './workbench/TasksTab.tsx'
import { TerminalTab } from './workbench/Terminal.tsx'
import css from './ExternalPanel.module.css'

/** Registrant-private share arriving through the register inject factory. */
/** A message that moves an open conversation to a new DSH session. */
export interface DshSwitchRequest {
  readonly fromId: string
  readonly text: string
  readonly cwd: string
  /** `provider/model` of the DSH catalog. */
  readonly modelId: string
  readonly effort: string
}

export type ExternalPanelInjected = {
  hooks: {
    /** Rows and selection of the Claude / Codex page. */
    selection: HostObservable<SessionsSnapshot>
    /** Transcript and live turn of the selected session. */
    transcript: HostObservable<TranscriptState>
  }
  /** Actions on the selected session. */
  controller: TranscriptController
  /** Start a DSH session from the conversation; resolves to an error text, if any. */
  startDshSession: (request: DshSwitchRequest) => Promise<string | undefined>
  /** Working directory offered for a new session. */
  getDefaultCwd: () => string
  /** Adds a tool to the permanent allow list. */
  alwaysAllow: (tool: string) => Promise<void>
  /** Called when the page unmounts, so the row highlight follows the page. */
  clearSelection: () => void
  /** Open another external session (a search result). */
  openSession: (id: string) => void
  codexEnabled: () => boolean
  openSettings: (() => void) | undefined
  /** Working directory requested for the next new session (consumed once), for example from a worktree. */
  takePendingCwd: () => string | undefined
  /** The core sidebar column, which the page hides while it shows its own session list. */
  sidebar: { collapsed: () => boolean; toggle: () => void }
  /** Leave the page for the Conversation. */
  leave: () => void
}

/** Full panel props. */
export type ExternalPanelProps =
  PropsRuntime<'main'>
  & PropsLocale<'agent-bridge'>
  & PropsHooks<ExternalPanelInjected['hooks']>
  & Omit<ExternalPanelInjected, 'hooks'>

type T = ExternalPanelProps['t']

const spokenText = (items: ReadonlyArray<{ kind: string; text?: string }>): string => items.flatMap(item => item.kind === 'text' && item.text !== undefined ? [item.text] : []).join('\n').trim()

/** How close to the bottom, in pixels, the reader must be for new content to keep the panel scrolled down. */
const FOLLOW_SLACK = 48

/** Arrow and square glyphs of the DSH composer's send and stop buttons. */
const SEND_GLYPH = 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z'

const compact = (n: number): string => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

const COMPOSER_PLACEHOLDER = { claude: 'composer.placeholder', codex: 'composer.placeholderCodex', pi: 'composer.placeholderPi' } as const

function PermissionCard({ permission, controller, alwaysAllow, engine, t }: {
  permission: PermissionWire; controller: TranscriptController; alwaysAllow: (tool: string) => Promise<void>; engine: EngineName; t: T
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const pick = (question: string, label: string, multi: boolean): void => {
    setPicked((current) => {
      const had = current[question] ?? []
      const next = multi ? (had.includes(label) ? had.filter(x => x !== label) : [...had, label]) : [label]
      return { ...current, [question]: next }
    })
  }
  if (permission.questions !== undefined) {
    const complete = permission.questions.every(q => (picked[q.question] ?? []).length > 0)
    return (
      <div className={css.card} data-testid="ext-question">
        {permission.questions.map(q => (
          <fieldset key={q.question} className={css.fieldset}>
            <legend>{q.header} · {q.question}</legend>
            {q.options.map(option => (
              <label key={option.label} className={css.option}>
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={q.question}
                  data-testid="ext-option"
                  checked={(picked[q.question] ?? []).includes(option.label)}
                  onChange={() => pick(q.question, option.label, q.multiSelect)}
                />
                {option.label}{option.description === '' ? '' : ` — ${option.description}`}
              </label>
            ))}
          </fieldset>
        ))}
        <button
          type="button" data-testid="ext-answer" disabled={!complete}
          onClick={() => {
            const answers = Object.fromEntries((permission.questions ?? []).map(q => [q.question, (picked[q.question] ?? []).join(', ')]))
            void controller.answer(permission.requestId, 'allow', answers)
          }}
        >{t('card.submit')}</button>
        <button type="button" onClick={() => { void controller.answer(permission.requestId, 'deny') }}>{t('card.decline')}</button>
      </div>
    )
  }
  return (
    <div className={css.card} data-testid="ext-permission" data-tool={permission.tool}>
      <p className={css.cardTitle}>{permission.title}</p>
      {permission.plan === undefined
        ? <pre className={css.input}>{permission.input}</pre>
        : <pre className={css.input} data-testid="ext-plan">{permission.plan}</pre>}
      <Button variant="primary" size="sm" data-testid="ext-allow" onClick={() => { void controller.answer(permission.requestId, 'allow') }}>{t('card.allow')}</Button>
      {engine !== 'pi' && (
        <Button
          variant="outline" size="sm" data-testid="ext-always"
          onClick={() => {
            if (engine === 'codex') void controller.answer(permission.requestId, 'allow', undefined, true)
            else void alwaysAllow(permission.tool).then(() => controller.answer(permission.requestId, 'allow'))
          }}
        >{engine === 'codex' ? t('card.session') : t('card.always', { tool: permission.tool })}</Button>
      )}
      <Button variant="ghost" size="sm" data-testid="ext-deny" onClick={() => { void controller.answer(permission.requestId, 'deny') }}>{t('card.deny')}</Button>
    </div>
  )
}

/**
 * Render the selected session: transcript, live turn, cards, and composer.
 * @param props - locale seat, bound hooks, and callbacks.
 * @returns the panel.
 */
export function ExternalPanel({ t, useSelection, useTranscript, controller, startDshSession, getDefaultCwd, alwaysAllow, clearSelection, openSession, takePendingCwd, codexEnabled, openSettings }: ExternalPanelProps) {
  const selected = useSelection(snapshot => snapshot.rows.find(row => row.id === snapshot.selectedId))
  const transcript = useTranscript(state => state)
  const [text, setText] = useState('')
  const [cwd, setCwd] = useState<string | undefined>(undefined)
  useEffect(() => clearSelection, [clearSelection])
  useEffect(() => { if (isDraft(transcript.sessionId)) { const pending = takePendingCwd(); if (pending !== undefined) setCwd(pending) } }, [transcript.sessionId, takePendingCwd])
  useEffect(() => { setTab('chat'); setVisited(new Set()) }, [transcript.sessionId])
  const pick = (next: typeof tab): void => { setTab(next); setVisited(current => new Set(current).add(next)) }
  const timeline = useMemo(() => buildTimeline(transcript.messages), [transcript.messages])
  // The panel keeps the latest message in view while the reader is at the bottom; scrolling up to read history stops that.
  const panelRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const following = useRef(true)
  const toBottom = (): void => { const panel = panelRef.current; if (panel !== null && following.current) panel.scrollTop = panel.scrollHeight }
  useLayoutEffect(() => { following.current = true }, [transcript.sessionId])
  useLayoutEffect(toBottom, [timeline, transcript.pendingUser, transcript.partial, transcript.permissions, transcript.error, transcript.sessionId])
  useEffect(() => {
    const list = listRef.current
    if (list === null) return undefined
    // Rendered Markdown and images change the height after the commit that added them.
    const observer = new ResizeObserver(toBottom)
    observer.observe(list)
    return () => { observer.disconnect() }
  }, [])
  const draft = isDraft(transcript.sessionId)
  const shownCwd = cwd ?? getDefaultCwd()
  const sessionEngine = engineOfSession(transcript.sessionId)
  const sessionProvider = providerOfSession(transcript.sessionId)
  // A provider picked in an open session applies to the next message, which moves the conversation there.
  const [switchTarget, setSwitchTarget] = useState<string | undefined>(undefined)
  // A DSH model picked in an open session applies to the next message, which starts a new DSH session.
  const [dshTarget, setDshTarget] = useState<{ readonly modelId: string; readonly effort: string } | undefined>(undefined)
  useEffect(() => { setSwitchTarget(undefined); setDshTarget(undefined) }, [transcript.sessionId])
  const provider = switchTarget ?? sessionProvider
  const engine: EngineName = providerEngine(provider)
  const pickerCwd = draft ? shownCwd : selected?.cwd
  const [modelPrefs, saveModelPrefs] = useModelPrefs()
  const { providers } = useProviders()
  const offeredProviders = providers.filter(item => (item.engine !== 'codex' || codexEnabled()) && (item.id === provider || isEngineEnabled(modelPrefs, item.id)))
  const providerIds = [...new Set([provider, ...offeredProviders.map(item => item.id)])]
  const infos = useInfos(providerIds, pickerCwd)
  const info = infos[provider]?.info
  const choices = useChoices(providerIds)
  const [choice, setChoice] = choices[provider] ?? [{ model: '', effort: '' }, () => {}]
  const dshCatalog = useDshCatalog()
  const dshRow = dshTarget === undefined ? undefined : dshCatalog.find(model => model.id === dshTarget.modelId)
  const pickProvider = (target: PickerEngine, modelId: string, explicit: string | undefined): void => {
    if (target === 'dsh') {
      const efforts = dshCatalog.find(model => model.id === modelId)?.efforts.map(level => level.id) ?? []
      const picked = pickEffort(modelPrefs, { key: `${pickerCurrent.engine}/${pickerCurrent.modelId}`, effort: pickerCurrent.effort }, { key: `dsh/${modelId}`, efforts }, explicit)
      if (picked.prefs !== modelPrefs) saveModelPrefs(picked.prefs)
      setSwitchTarget(undefined)
      setDshTarget({ modelId, effort: picked.effort })
      return
    }
    setDshTarget(undefined)
    const entry = choices[target]
    if (entry === undefined) return
    const [current, set] = entry
    const targetInfo = infos[target]?.info
    const supported = targetInfo?.models.find(model => model.value === modelId)?.efforts ?? []
    const picked = pickEffort(modelPrefs, { key: `${pickerCurrent.engine}/${pickerCurrent.modelId}`, effort: pickerCurrent.effort }, { key: `${target}/${modelId}`, efforts: supported }, explicit)
    if (picked.prefs !== modelPrefs) saveModelPrefs(picked.prefs)
    const speed = speedFor(targetInfo, modelId, current.speed)
    set({ ...current, model: modelId, effort: picked.effort, ...speed === undefined ? {} : { speed } })
    if (!draft) setSwitchTarget(target === sessionProvider ? undefined : target)
    else if (target !== sessionProvider) openSession(draftIdFor(target))
  }
  const pickerLabels = engineLabels(provider, info, choice)
  const pickerCurrent = dshTarget === undefined ? { engine: provider, modelId: pickerLabels.modelId, effort: pickerLabels.effortId } : { engine: 'dsh', modelId: dshTarget.modelId, effort: dshTarget.effort }
  const fastTier = fastTierOf(info, pickerLabels.modelId)
  const [attachments, setAttachments] = useState<AttachmentWire[]>([])
  const [draftLoaded, setDraftLoaded] = useState<string | undefined>(undefined)
  // Text typed while the saved draft is loading is kept instead of being replaced by it.
  const typedBeforeDraft = useRef(false)
  useEffect(() => {
    const id = transcript.sessionId
    setAttachments([])
    setDraftLoaded(undefined)
    typedBeforeDraft.current = false
    if (id === undefined) return undefined
    let cancelled = false
    void fetch(`${DRAFT_PATH}?${new URLSearchParams({ id }).toString()}`, { credentials: 'same-origin' })
      .then(async response => await response.json() as { text: string })
      .then(({ text: saved }) => { if (!cancelled) { if (!typedBeforeDraft.current) setText(saved); setDraftLoaded(id) } }, () => { if (!cancelled) setDraftLoaded(id) })
    return () => { cancelled = true }
  }, [transcript.sessionId])
  useEffect(() => {
    const id = transcript.sessionId
    if (id === undefined || draftLoaded !== id) return undefined
    const timer = window.setTimeout(() => {
      void fetch(DRAFT_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, text }) }).catch(() => {})
    }, 600)
    return () => { window.clearTimeout(timer) }
  }, [text, transcript.sessionId, draftLoaded])
  const attach = (files: File[]): void => { void toAttachments(files).then((added) => { setAttachments(current => [...current, ...added]) }) }
  const canSend = (text.trim() !== '' || attachments.length > 0) && !transcript.running && (!draft || shownCwd !== '') && (dshTarget === undefined || attachments.length === 0)
  const voice = useVoiceEnabled()
  const [tab, setTab] = useState<'chat' | 'terminal' | 'files' | 'git' | 'tasks' | 'extensions'>('chat')
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set())
  const workCwd = draft ? undefined : selected?.cwd
  const [goalText, setGoalText] = useState('')
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [goalOpen, setGoalOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const send = (): void => {
    if (!canSend) return
    const message = text.trim() === '' ? t('composer.seeAttached') : text.trim()
    if (dshTarget !== undefined && transcript.sessionId !== undefined) {
      const fromId = transcript.sessionId
      setText('')
      void startDshSession({ fromId, text: message, cwd: selected?.cwd ?? shownCwd, modelId: dshTarget.modelId, effort: dshTarget.effort }).then((failure) => {
        if (failure === undefined) {
          void fetch(DRAFT_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: fromId, text: '' }) }).catch(() => {})
          return
        }
        setText(message)
        controller.fail(failure)
      })
      return
    }
    const sent = attachments
    following.current = true
    setText('')
    setAttachments([])
    void controller.send(message, draft ? shownCwd : selected?.cwd ?? shownCwd, {
      ...choice.model === '' ? {} : { model: choice.model }, ...pickerLabels.effortId === '' ? {} : { effort: pickerLabels.effortId },
      ...choice.permission === undefined || choice.permission === '' ? {} : { permission: choice.permission },
      ...sent.length === 0 ? {} : { attachments: sent },
      ...choice.speed === undefined ? {} : { speed: choice.speed },
      ...switchTarget === undefined || draft || transcript.sessionId === undefined ? {} : { engine: providerEngine(switchTarget), ...providerInstance(switchTarget) === undefined ? {} : { instance: providerInstance(switchTarget) as string }, switchFrom: transcript.sessionId },
    })
  }
  const tabs = workCwd !== undefined && workCwd !== '' ? (['chat', 'terminal', 'files', 'git', 'tasks', 'extensions'] as const) : undefined
  const managedId = draft ? undefined : transcript.sessionId
  const managed = managedId !== undefined
  return (
    <div className={css.shell}>
      <header className={css.topbar} data-testid="ext-topbar" data-window-drag="">
        <div className={css.titleRow}>
          <div className={css.titleCluster}>
            <h2 className={css.title} data-testid="ext-title" title={draft ? undefined : selected?.cwd}>{selected?.title ?? t('panel.empty')}</h2>
            {draft
              ? (
                <label className={css.meta}>
                  {t('composer.cwd')}{' '}
                  <input data-testid="ext-cwd" value={shownCwd} onChange={event => setCwd(event.target.value)} />
                  <DirPicker start={shownCwd} onPick={setCwd} t={t} />
                </label>
              )
              : null}
          </div>
          <div className={css.headerActions}>
            {managed && renaming !== undefined && (
              <>
                <input className={css.renameInput} data-testid="ext-rename-input" value={renaming} onChange={event => setRenaming(event.target.value)} />
                <Button
                  variant="primary" size="sm" data-testid="ext-rename-save" disabled={renaming.trim() === ''}
                  onClick={() => { void controller.manage('rename', renaming.trim()).then(() => { setRenaming(undefined) }) }}
                >{t('settings.save')}</Button>
                <Button variant="ghost" size="sm" onClick={() => { setRenaming(undefined) }}>{t('manage.cancel')}</Button>
              </>
            )}
            {managed && confirmDelete && (
              <>
                <Button variant="primary" size="sm" data-testid="ext-delete-confirm" onClick={() => { setConfirmDelete(false); void controller.manage('delete') }}>{t('manage.confirmDelete')}</Button>
                <Button variant="ghost" size="sm" onClick={() => { setConfirmDelete(false) }}>{t('manage.cancel')}</Button>
              </>
            )}
            {/* The dsh conversation header keeps its session verbs behind one More actions menu. */}
            {managed && (
              <Menu
                open={menuOpen} onClose={() => { setMenuOpen(false) }} align="end" portal
                anchor={(
                  <button
                    type="button" className={css.iconButton} data-testid="ext-more" aria-label={t('manage.more')} title={t('manage.more')}
                    aria-expanded={menuOpen} onClick={() => { setMenuOpen(open => !open) }}
                  ><IconMore size={16} /></button>
                )}
              >
                <div data-testid="ext-rename">
                  <MenuItemButton icon={<IconEdit size={16} />} onSelect={() => { setMenuOpen(false); setRenaming(selected?.title ?? '') }}>{t('manage.rename')}</MenuItemButton>
                </div>
                <div data-testid="ext-fork">
                  <MenuItemButton icon={<IconBranch size={16} />} disabled={selected === undefined || (transcript.running && engineOfSession(selected.id) === 'pi')} onSelect={() => { setMenuOpen(false); if (selected !== undefined) void controller.fork(selected.id, `${selected.title} (fork)`, selected.cwd) }}>{t('manage.fork')}</MenuItemButton>
                </div>
                <div data-testid="ext-archive">
                  <MenuItemButton icon={<IconArchive size={16} />} disabled={transcript.running} onSelect={() => { setMenuOpen(false); void controller.archive() }}>{t('manage.archive')}</MenuItemButton>
                </div>
                <div data-testid="ext-delete">
                  <MenuItemButton icon={<IconTrash size={16} />} danger separatorBefore disabled={transcript.running} onSelect={() => { setMenuOpen(false); setConfirmDelete(true) }}>{t('manage.delete')}</MenuItemButton>
                </div>
              </Menu>
            )}
            <button
              type="button" className={css.iconButton} data-testid="ext-search-toggle" aria-pressed={searchOpen}
              aria-label={t('manage.search')} title={t('manage.search')} onClick={() => { setSearchOpen(open => !open) }}
            ><IconSearch size={16} /></button>
          </div>
        </div>
        {tabs !== undefined && (
          <nav className={css.tabs} role="tablist" data-testid="ext-tabs">
            {tabs.map(name => (
              <button
                key={name} type="button" role="tab" aria-selected={tab === name} data-testid={`ext-tab-${name}`}
                className={tab === name ? css.tabActive : css.tab} onClick={() => { pick(name) }}
              >{t(`tab.${name}`)}</button>
            ))}
          </nav>
        )}
      </header>
      {searchOpen && <div className={css.searchRow}><SearchBox onOpen={openSession} t={t} /></div>}
      {tabs !== undefined && workCwd !== undefined && (
        <div className={css.workbench} hidden={tab === 'chat'}>
          {visited.has('terminal') && <div className={css.pane} hidden={tab !== 'terminal'}><TerminalTab cwd={workCwd} active={tab === 'terminal'} t={t} /></div>}
          {visited.has('files') && <div className={css.pane} hidden={tab !== 'files'}><FilesTab cwd={workCwd} active={tab === 'files'} t={t} /></div>}
          {visited.has('git') && <div className={css.pane} hidden={tab !== 'git'}><GitTab cwd={workCwd} active={tab === 'git'} t={t} /></div>}
          {visited.has('tasks') && <div className={css.pane} hidden={tab !== 'tasks'}><TasksTab cwd={workCwd} active={tab === 'tasks'} t={t} /></div>}
          {visited.has('extensions') && <div className={css.pane} hidden={tab !== 'extensions'}><ExtensionsTab cwd={workCwd} active={tab === 'extensions'} t={t} engine={sessionEngine} /></div>}
        </div>
      )}
      <section
        ref={panelRef} className={css.panel} data-testid="ext-panel" hidden={tab !== 'chat'}
        onScroll={(event) => { const panel = event.currentTarget; following.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight <= FOLLOW_SLACK }}
      >
        <div className={css.column}>
          {transcript.staleElsewhere && (
            <p className={css.stale} data-testid="ext-stale" role="status">
              {t('panel.stale')}{' '}
              <button type="button" data-testid="ext-reload" onClick={() => { controller.reload() }}>{t('panel.reload')}</button>
            </p>
          )}
          {!draft && transcript.goal !== undefined && (
            <div className={css.goal} data-testid="ext-goal" data-iterations={transcript.goal.iterations ?? 0}>
              <p className={css.cardTitle}>{t('goal.title')}: <span data-testid="ext-goal-condition">{transcript.goal.condition}</span></p>
              <p className={css.meta}>
                {transcript.goal.iterations !== undefined && t('goal.iterations', { n: transcript.goal.iterations })}
                {transcript.goal.tokensUsed !== undefined && t('goal.tokens', { n: transcript.goal.tokensUsed })}
                {transcript.goal.reason !== undefined && <> · <span data-testid="ext-goal-reason">{transcript.goal.reason}</span></>}
              </p>
              <Button variant="ghost" size="sm" data-testid="ext-goal-clear" disabled={transcript.running} onClick={() => { void controller.send('/goal clear', shownCwd) }}>{t('goal.clear')}</Button>
            </div>
          )}
          {transcript.recentTurns !== undefined && <p className={css.summary} data-testid="ext-recent-turns">{t('panel.recentTurns', { n: transcript.recentTurns })}</p>}
          <ol ref={listRef} className={css.messages}>
            {timeline.map(message => (
              <Fragment key={message.id}>
              {message.switchedTo !== undefined && <li className={css.switchDivider} data-testid="ext-switch-divider"><span>{t('picker.switchedTo', { name: providers.find(item => item.id === message.switchedToProvider)?.label ?? (message.switchedTo === 'codex' ? 'Codex' : 'Claude Code') })}</span></li>}
              <li className={message.role === 'user' ? css.userRow : css.message} data-testid="ext-message" data-role={message.role}>
                <div className={message.role === 'user' ? css.userBody : css.assistantBody}>
                  {message.items.map((item, index) => {
                    switch (item.kind) {
                      case 'text': return <div key={index} data-testid="ext-text"><Markdown text={item.text} t={t} /></div>
                      case 'thinking': return <Thinking key={index} text={item.text} t={t} />
                      case 'todos': return <Todos key={index} todos={item.todos} />
                      case 'tool': return <ToolCard key={index} item={item} t={t} running={transcript.running} />
                    }
                  })}
                </div>
                {spokenText(message.items) !== '' && (
                  <div className={message.role === 'user' ? css.userActions : css.messageActions}>
                    <button
                      type="button" className={css.iconButton} data-testid="ext-copy" aria-label={t('message.copy')} title={t('message.copy')}
                      onClick={() => { void writeClipboard(spokenText(message.items)) }}
                    ><IconCopy size={16} /></button>
                    {message.role === 'assistant' && voice && <SpeakButton text={spokenText(message.items)} t={t} className={css.iconButton} />}
                  </div>
                )}
              </li>
              </Fragment>
            ))}
            {transcript.pendingUser !== undefined && (
              <li className={css.userRow} data-testid="ext-pending">
                <div className={css.userBody}><Markdown text={transcript.pendingUser} t={t} /></div>
              </li>
            )}
            {transcript.partial !== '' && (
              <li className={css.message} data-testid="ext-partial">
                <div className={css.assistantBody}><Markdown text={transcript.partial} t={t} streaming /></div>
              </li>
            )}
          </ol>
          {transcript.permissions.map(permission => (
            <PermissionCard key={permission.requestId} permission={permission} controller={controller} alwaysAllow={alwaysAllow} engine={sessionEngine} t={t} />
          ))}
          {transcript.running && <RunningStatus engine={sessionEngine} startedAt={transcript.startedAt} t={t} />}
          {transcript.error !== undefined && <p className={css.error} data-testid="ext-error" role="alert">{transcript.error}</p>}
        </div>
        <div className={css.composer} data-testid="ext-composer">
          <div className={css.composerStack}>
            {managedId !== undefined && <ScheduleBar sessionId={managedId} cwd={selected?.cwd ?? shownCwd} text={text} choice={choice} open={scheduleOpen} onClose={() => { setScheduleOpen(false) }} onSent={() => { setText('') }} t={t} />}
            {managed && goalOpen && transcript.goal === undefined && (
              <div className={css.goalSet}>
                <input data-testid="ext-goal-input" value={goalText} placeholder={t('goal.placeholder')} onChange={event => setGoalText(event.target.value)} />
                <Button
                  variant="primary" size="sm" data-testid="ext-goal-set" disabled={goalText.trim() === '' || transcript.running}
                  onClick={() => { const condition = goalText.trim(); setGoalText(''); void controller.send(`/goal ${condition}`, shownCwd) }}
                >{t('goal.set')}</Button>
              </div>
            )}
            <SlashMenu text={text} commands={info?.commands ?? []} onPick={(name) => { setText(`/${name} `) }} />
            {dshTarget !== undefined && <p className={css.summary} data-testid="ext-switch-note">{t(attachments.length === 0 ? 'picker.switchNoteDsh' : 'picker.dshNoFiles')}</p>}
            {switchTarget !== undefined && <p className={css.summary} data-testid="ext-switch-note">{t('picker.switchNote', { name: providers.find(item => item.id === switchTarget)?.label ?? switchTarget })}</p>}
            <div className={css.composerCard}>
              <AttachmentChips attachments={attachments} onRemove={(index) => { setAttachments(current => current.filter((_, position) => position !== index)) }} t={t} />
              <textarea
                className={css.text} data-testid="ext-input" rows={2} value={text} placeholder={t(COMPOSER_PLACEHOLDER[engine])}
                onChange={(event) => { typedBeforeDraft.current = true; setText(event.target.value) }}
                onKeyDown={(event) => {
                  // The same keys as the DSH composer. The Enter that closes an input-method composition picks a word, not sends; 229 is what some engines report for it.
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
                  event.preventDefault()
                  send()
                }}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files)
                  if (files.length > 0) { event.preventDefault(); attach(files) }
                }}
                onDrop={(event) => {
                  const files = Array.from(event.dataTransfer.files)
                  if (files.length > 0) { event.preventDefault(); attach(files) }
                }}
                onDragOver={(event) => { event.preventDefault() }}
              />
              <div className={css.toolbar}>
                <div className={css.tools}>
                  <ComposerBar
                    part="leading" engine={engine} info={info} choice={choice} onChoice={setChoice} onAttach={attach}
                    onDictated={(spoken) => { setText(current => current === '' ? spoken : `${current} ${spoken}`) }} t={t}
                  />
                  {managed && (
                    <button type="button" className={css.chip} data-testid="ext-schedule" aria-pressed={scheduleOpen} onClick={() => { setScheduleOpen(open => !open) }}>
                      <IconAlarm size={14} />{t('schedule.open')}
                    </button>
                  )}
                  {managed && engine !== 'pi' && transcript.goal === undefined && (
                    <button type="button" className={css.chip} data-testid="ext-goal-toggle" aria-pressed={goalOpen} onClick={() => { setGoalOpen(open => !open) }}>
                      {t('goal.title')}
                    </button>
                  )}
                </div>
                <div className={css.trailing}>
                  {sessionEngine === 'pi'
                    ? <ComposerBar part="trailing" engine={engine} info={info} choice={choice} onChoice={setChoice} onAttach={attach} onDictated={() => {}} t={t} />
                    : (
                      <ProviderPicker
                        groups={[
                          ...!draft && dshCatalog.length > 0 ? [{ engine: 'dsh', label: t('picker.dsh'), models: visibleRows('dsh', orderRows(dshCatalog, enginePrefs(modelPrefs, 'dsh').order), modelPrefs) }] : [],
                          ...offeredProviders.map(item => engineGroup(item.id, item.label, infos[item.id]?.info, infos[item.id]?.error, modelPrefs, t, item.accent)),
                        ]}
                        onOpenSettings={openSettings} savedEfforts={modelPrefs.efforts}
                        accessChip={dshTarget !== undefined ? undefined : <PermissionPopover options={bridgeAccessOptions(t)} value={choice.permission ?? ''} locked={transcript.running} onChange={(permission) => { setChoice({ ...choice, permission: permission as PermissionPreset | '' }) }} t={t} />}
                        favorites={modelPrefs.favorites} onToggleFavorite={(key) => { saveModelPrefs(toggleFavorite(modelPrefs, key)) }}
                        current={pickerCurrent} label={dshTarget === undefined ? pickerLabels.label : dshRow?.name ?? dshTarget.modelId} effortLabel={dshTarget === undefined ? pickerLabels.effort : dshRow?.efforts.find(level => level.id === dshTarget.effort)?.name ?? ''}
                        locked={transcript.running} onPick={pickProvider} t={t}
                        speed={dshTarget !== undefined ? undefined : { available: fastTier !== undefined, fast: fastTier !== undefined && (choice.speed ?? '') !== '', onChange: (fast) => { setChoice({ ...choice, speed: fast ? fastTier ?? '' : '' }) } }}
                        access={dshTarget !== undefined ? undefined : <PermissionPicker value={choice.permission ?? ''} onChange={(permission) => { setChoice({ ...choice, permission: permission as PermissionPreset | '' }) }} t={t} />}
                      />
                    )}
                  {transcript.running
                    ? (
                      <button type="button" className={css.primary} data-testid="ext-stop" aria-label={t('composer.stop')} title={t('composer.stop')} onClick={() => { void controller.interrupt() }}>
                        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" /></svg>
                      </button>
                    )
                    : (
                      <button type="button" className={css.primary} data-testid="ext-send" aria-label={t('composer.send')} title={t('composer.send')} disabled={!canSend} onClick={send}>
                        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d={SEND_GLYPH} fill="currentColor" /></svg>
                      </button>
                    )}
                </div>
              </div>
            </div>
            <p
              className={css.summary} data-testid="ext-summary" data-status={transcript.status}
              data-count={transcript.messages.length} data-running={transcript.running} data-session={transcript.sessionId ?? ''}
            >
              {transcript.status !== 'ready' && `${t(`panel.status.${transcript.status}`)} · `}{t('panel.summary', { count: transcript.messages.length })}
              {transcript.usage !== undefined && <span data-testid="ext-usage" data-input={transcript.usage.input} data-output={transcript.usage.output}> · {t('panel.usage', { input: compact(transcript.usage.input + transcript.usage.cacheRead + transcript.usage.cacheWrite), output: compact(transcript.usage.output) })}</span>}
              {transcript.running && ` · ${t('panel.running')}`}
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
