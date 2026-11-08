/**
 * dsh-agent-bridge, browser half. Puts the Claude Code and Codex sessions in the Workspace browser
 * through its external session source when the running browser offers one (the dsh-ui-workspace-hub
 * bundle); otherwise adds a Claude / Codex entry to the sidebar panel list whose page carries its own
 * session list. Either way the session panel opens in the main column, and the configuration page sits
 * on the Plugins page. The session list, transcript and change feed are owned here, in the apply world,
 * so the components only read snapshots.
 * @module dsh-agent-bridge/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ExternalSessionSource } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { isEngineEnabled } from '../model-prefs.ts'
import { currentModelPrefs } from './model-prefs-store.ts'
import { currentProviders } from './providers-store.ts'
import { loadInfo } from './info.ts'
import { engineLabels } from './model-names.ts'
import type { DshSwitchRequest } from './ExternalPanel.tsx'
import { composeSwitchPrompt } from '../links.ts'
import { publishRowIndicators, RowIndicators, type RowIndicator } from './RowIndicators.tsx'
import { ARCHIVE_PATH, BRANCH_STATUS_PATH, type BranchStateWire, type BranchTargetWire, CATCHUP_PATH, DSH_IMPORT_PATH, SEEN_PATH, MANAGE_PATH, NEW_CODEX_SESSION_ID, NEW_PI_SESSION_ID, PIN_PATH, draftIdFor, engineOfSession, CHOICE_PATH, type ChoiceWire, type DshImportBodyWire, type ManageBodyWire, NEW_SESSION_ID, PANEL_ID, SESSIONS_PATH, type SessionRowWire } from '../protocol.ts'
import { applyEngineMarks } from './branding.tsx'
import { IconChats } from './icons.tsx'
import { endedSince, notifyEnded } from './notify.ts'
import { createSessionsStore, type SessionRow } from './sessions.ts'
import { ExternalPanel } from './ExternalPanel.tsx'
import { EngineMark, EXTERNAL_MENU_KIND, EXTERNAL_PREFIX, graftWorkspaceBrowser, type ExternalMenuTarget, type GraftSlots } from './graft.tsx'
import { createModeStore, withMode } from './mode.tsx'
import { SessionsPage } from './SessionsPage.tsx'
import { SettingsCard, type ExternalEnginesSection } from './SettingsCard.tsx'
import { AboutSection } from './AboutSection.tsx'
import { en, NS, zh, type ExternalEnginesKey } from './locales.ts'
import { createTranscriptController, isDraft, type SendExtras } from './transcript.ts'
import { createEngineStore, ProviderSeat, type CatalogStore, type NativePermission, type SeatServices } from './NewChat.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Panel and settings-card copy of the agent-bridge plugin. */
    'agent-bridge': ExternalEnginesKey
  }
}

/** Harness services the provider selector reads; optional, so the plugin still loads without them. */
interface SeatContext {
  readonly modelDirectories: {
    directoryFor(sessionId: string): {
      readonly store: CatalogStore
      load(): Promise<unknown>
      select(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
    }
  }
  readonly conversation: {
    serializeDraftAttachments(ids: readonly string[]): Promise<{ readonly attachments: readonly ({ readonly type: 'image'; readonly mediaType: string; readonly data: string; readonly name?: string } | { readonly type: 'file'; readonly receiptId: string })[] }>
    releaseDraftAttachment(id: string): void
  }
  readonly sessions: {
    readonly list: {
      getSnapshot(): { readonly byId: Readonly<Record<string, { readonly cwd?: string; readonly blank?: boolean } | undefined>> }
      subscribe(listener: () => void): () => void
    }
    create(options: { readonly cwd: string }): Promise<string>
    refresh(): Promise<void>
  }
  readonly remote: {
    readonly session: {
      rename(request: { readonly sessionId: string; readonly title: string }): Promise<RemoteOutcome>
      selectModel(selection: { readonly sessionId: string; readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): Promise<RemoteOutcome>
      prompt(request: { readonly requestId: string; readonly sessionId: string; readonly mode: 'queue'; readonly content: readonly { readonly type: 'text'; readonly text: string }[]; readonly clientTimeZone: string }): Promise<RemoteOutcome>
    }
  }
}

/** Result of a harness Remote call. */
type RemoteOutcome = { readonly ok: true } | { readonly ok: false; readonly error: { readonly message: string } }

/** The conversation slots the provider selector registers in; their types belong to the harness conversation package. */
interface SeatSlots {
  inject(name: string, factory: () => unknown): () => void
  register(options: Record<string, unknown>, component: unknown): unknown
  entries(name: string): readonly { readonly component: unknown; readonly inject?: (sessionId: string) => unknown; readonly store?: { create(): { readonly actions: { openSection(id: string): void } } } }[]
}

/** The harness method that delivers a composer message. */
interface ConversationSend {
  sendSession(session: { readonly sessionId: string }, text: string, attachmentIds: readonly string[], mode: unknown, signal?: AbortSignal, accept?: () => void): Promise<{ kind: 'success' | 'error'; text?: string }>
}

/** Takes the place of the harness permission control, which moves into the selector footer. */
const HiddenPermission = (): null => null

/** Services this plugin requires. */
export const inject =['slots', 'locale', 'layout', 'configForms', 'uiWorkspace']

/** Entry id of the plugin row the bundle patch inserts; its config is this plugin's settings. */
const ENTRY_ID = 'agent-bridge'
/** Package name keying the bundle's configuration page on the Plugins page. */
const PACKAGE_NAME = 'dsh-agent-bridge'

/** One action a context-menu contribution resolves to (dsh 0.2.2 `ui-context-menu`). */
interface MenuAction {
  readonly id: string
  readonly label: string
  readonly icon?: { readonly key: string }
  readonly separatorBefore?: boolean
  readonly run: () => void
}

/** The part of the dsh 0.2.2 `contextMenus` service the plugin uses; older dsh builds have no such service. */
interface ContextMenus {
  register(contribution: {
    id: string
    target: string
    order: number
    observe?: () => readonly unknown[]
    /** Receives the target's value, as `open` captured it. */
    resolve: (value: ExternalMenuTarget['value']) => readonly MenuAction[]
  }): () => void
  open(target: ExternalMenuTarget, point: unknown): void
  close(): void
  readonly active: { getSnapshot(): { kind?: string; value?: { sessionId?: unknown } } | null | undefined }
}

function toRow(wire: SessionRowWire): SessionRow {
  return { id: wire.id, title: wire.title, cwd: wire.cwd, updatedAt: wire.updatedAt, branch: wire.branch, unread: wire.unread }
}

/**
 * Register the panel-list entry, the page, and the configuration page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  // The settings shell keeps its open tab in a store that only its slot entry exposes.
  const openSettings = (): void => {
    const shell = (slots as unknown as SeatSlots).entries('sidebar.settings')[0]?.store?.create()
    shell?.actions.openSection('agent-bridge')
  }
  const canOpenSettings = (): boolean => (slots as unknown as SeatSlots).entries('sidebar.settings')[0]?.store !== undefined
  applyEngineMarks(ctx)
  const store = createSessionsStore()
  let defaultCwd = ''
  let wireRows: readonly SessionRow[] = []
  /** Rows created in this page session; kept until the engine lists them (Codex does not list a fork before its first own turn). */
  const created = new Map<string, SessionRow>()
  let codexEnabled = false
  let piEnabled = false
  let running = new Set<string>()
  const isZh = (): boolean => ctx.locale.getSnapshot().active.startsWith('zh')
  const draftRows = (): SessionRow[] => [
    { id: NEW_SESSION_ID, title: isZh() ? '＋ 新建 Claude 会话' : '+ New Claude session', cwd: defaultCwd, updatedAt: Date.now() },
    ...codexEnabled ? [{ id: NEW_CODEX_SESSION_ID, title: isZh() ? '＋ 新建 Codex 会话' : '+ New Codex session', cwd: defaultCwd, updatedAt: Date.now() }] : [],
    ...piEnabled ? [{ id: NEW_PI_SESSION_ID, title: isZh() ? '＋ 新建 Pi 会话' : '+ New Pi session', cwd: defaultCwd, updatedAt: Date.now() }] : [],
  ]
  const transcript = createTranscriptController({
    onCreated(id, cwd, prompt) {
      const row = { id, title: prompt.slice(0, 80), cwd, updatedAt: Date.now() }
      created.set(id, row)
      wireRows = [row, ...wireRows.filter(existing => existing.id !== id)]
      rows = [...draftRows(), ...wireRows]
      selectedId = id
      publish()
    },
    onSwitched(fromId, id, cwd, prompt) {
      const row = { id, title: prompt.slice(0, 80), cwd, updatedAt: Date.now() }
      created.delete(fromId)
      created.set(id, row)
      wireRows = [row, ...wireRows.filter(existing => existing.id !== id && existing.id !== fromId)]
      rows = [...draftRows(), ...wireRows]
      selectedId = id
      publish()
    },
    onTurnEnded() { void refresh() },
    onTurnStarted() { void refresh() },
    onRenamed(id, title) {
      const row = created.get(id)
      if (row !== undefined) created.set(id, { ...row, title })
    },
    onDeleted(id) {
      selectedId = undefined
      dropRow(id)
    },
  })
  let rows: readonly SessionRow[] = []
  let pinned: readonly string[] = []
  let selectedId: string | undefined
  const publish = (): void => {
    store.set({ rows, pinned, ...selectedId === undefined ? {} : { selectedId } })
  }
  /** Remove an archived or deleted row at once; the re-list that follows takes a few seconds with many sessions. */
  const dropRow = (id: string): void => {
    created.delete(id)
    wireRows = wireRows.filter(row => row.id !== id)
    rows = rows.filter(row => row.id !== id)
    publish()
    void refresh()
  }
  const postJson = (path: string, body: unknown): Promise<Response> => fetch(path, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const pinRow = (id: string, pin: boolean): void => {
    pinned = pin ? [...pinned.filter(other => other !== id), id] : pinned.filter(other => other !== id)
    publish()
    void postJson(PIN_PATH, { id, pinned: pin }).then((response) => {
      if (!response.ok) console.warn('agent-bridge: pin failed', response.status)
      void refresh()
    })
  }
  const archiveRow = (id: string): void => {
    if (selectedId === id) clearSelection()
    void postJson(ARCHIVE_PATH, { id, archived: true }).then((response) => {
      if (response.ok) dropRow(id)
      else console.warn('agent-bridge: archive failed', response.status)
    })
  }
  const forkRow = (id: string, title: string): void => {
    void transcript.fork(id, `${title} (fork)`, rows.find(row => row.id === id)?.cwd ?? '').then((forked) => {
      if (forked === undefined) console.warn('agent-bridge: fork failed', id)
      else ctx.layout.selectPanel(PANEL_ID as MainPanelId)
    })
  }
  const renameRow = async (id: string, title: string): Promise<void> => {
    const response = await postJson(MANAGE_PATH, { id, action: 'rename', title } satisfies ManageBodyWire)
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`)
    const row = created.get(id)
    if (row !== undefined) created.set(id, { ...row, title })
    wireRows = wireRows.map(other => other.id === id ? { ...other, title } : other)
    rows = rows.map(other => other.id === id ? { ...other, title } : other)
    publish()
    void refresh()
  }
  let pendingCwd: string | undefined
  const takePendingCwd = (): string | undefined => { const value = pendingCwd; pendingCwd = undefined; return value }
  const branchStates = new Map<string, BranchStateWire>()
  let nativeBranchTargets: () => readonly BranchTargetWire[] = () => []
  let branchesReadAt = 0
  const publishIndicators = (): void => {
    const next = new Map<string, RowIndicator>()
    for (const [key, branch] of branchStates) next.set(key, { unread: false, branch })
    for (const row of wireRows) {
      const key = `${EXTERNAL_PREFIX}${row.id}`
      next.set(key, { unread: row.unread === true, branch: branchStates.get(key) ?? 'none' })
    }
    publishRowIndicators(next)
  }
  const refreshBranches = async (): Promise<void> => {
    branchesReadAt = Date.now()
    const targets: BranchTargetWire[] = [
      ...wireRows.map(row => ({ key: `${EXTERNAL_PREFIX}${row.id}`, cwd: row.cwd, ...row.branch === undefined ? {} : { branch: row.branch } })),
      ...nativeBranchTargets(),
    ]
    try {
      const response = await postJson(BRANCH_STATUS_PATH, { targets })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const { states } = await response.json() as { states: Record<string, BranchStateWire> }
      branchStates.clear()
      for (const [key, state] of Object.entries(states)) branchStates.set(key, state)
      publishIndicators()
    } catch (error) {
      console.warn('agent-bridge: branch states failed', error)
    }
  }
  const markSeen = (id: string): void => {
    if (isDraft(id)) return
    wireRows = wireRows.map(row => row.id === id ? { ...row, unread: false } : row)
    publishIndicators()
    void postJson(SEEN_PATH, { id }).catch((error: unknown) => { console.warn('agent-bridge: seen state failed', error) })
  }
  const open = (id: string): void => {
    selectedId = id
    markSeen(id)
    publish()
    transcript.open(id)
    ctx.layout.selectPanel(PANEL_ID as MainPanelId)
  }
  const clearSelection = (): void => {
    selectedId = undefined
    transcript.close()
    publish()
  }
  const refresh = async (): Promise<void> => {
    try {
      const response = await fetch(SESSIONS_PATH, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json() as { sessions: SessionRowWire[]; running: string[]; pinned?: string[]; defaultCwd: string; codexEnabled: boolean; piEnabled: boolean; warnings: string[] }
      const previouslyRunning = running
      running = new Set(body.running)
      for (const id of endedSince(previouslyRunning, running)) {
        const known = [...wireRows, ...rows].find(row => row.id === id)
        notifyEnded(known?.title ?? id, isZh() ? '回合已结束' : 'The turn has ended')
      }
      defaultCwd = body.defaultCwd
      codexEnabled = body.codexEnabled
      piEnabled = body.piEnabled
      pinned = body.pinned ?? []
      for (const warning of body.warnings) console.warn('agent-bridge:', warning)
      const listed = body.sessions.map(wire => ({ ...toRow(wire), running: running.has(wire.id) }))
      for (const id of [...created.keys()]) if (listed.some(row => row.id === id) && !id.startsWith('codex:')) created.delete(id)
      wireRows = [...[...created.values()].filter(row => !listed.some(item => item.id === row.id)), ...listed]
      rows = [...draftRows(), ...wireRows]
      publish()
      // The open session has no unseen activity.
      if (selectedId !== undefined && wireRows.some(row => row.id === selectedId && row.unread === true)) markSeen(selectedId)
      publishIndicators()
      if (Date.now() - branchesReadAt > 60_000) void refreshBranches()
    } catch (error) {
      console.warn('agent-bridge: session list failed', error)
    }
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-bridge: dictionaries')
  const t = ctx.locale.bind(NS)
  // The shipped Workspace browser has no external session source; the hub bundle's build adds one.
  const registerSource = (ctx.uiWorkspace as { registerSessionSource?: (source: ExternalSessionSource) => () => void })
    .registerSessionSource
  let contextMenus: ContextMenus | undefined
  const renameRequest: { current?: ((id: string, title: string) => void) | undefined } = {}
  const openMenu = (target: ExternalMenuTarget, point: unknown, mode?: unknown): void => {
    if (contextMenus === undefined) return
    const active = contextMenus.active.getSnapshot()
    if (mode === 'toggle' && active?.kind === target.kind && active.value?.sessionId === target.value.sessionId) contextMenus.close()
    else contextMenus.open(target, point)
  }
  // Where the rows live: the hub's session source, the shipped browser grafted in place, or our own page.
  const mode = createModeStore(typeof registerSource === 'function' ? 'browser' : 'page')
  if (mode.getSnapshot() === 'browser') {
    ctx.effect(() => registerSource!.call(ctx.uiWorkspace, { snapshot: store, open }), 'agent-bridge: session source')
  } else {
    ctx.effect(() => {
      const graftSlots: GraftSlots = slots
      let undo: (() => void) | undefined
      let removeEntry: (() => void) | undefined
      const tryGraft = (): void => {
        if (undo !== undefined) return
        undo = graftWorkspaceBrowser(graftSlots, { snapshot: store, open, pin: pinRow, archive: archiveRow, rename: renameRow, panelId: PANEL_ID, openMenu, renameRequest })
        if (undo === undefined) return
        removeEntry?.()
        removeEntry = undefined
        mode.set('browser')
      }
      tryGraft()
      if (undo === undefined) {
        removeEntry = slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID as MainPanelId,
          order: 50,
          label: () => t('list.title'),
          locale: NS,
        }, ({ size }: { size: number }) => IconChats({ size })))
      }
      const unsubscribe = graftSlots.subscribe('sidebar.workspaces', tryGraft)
      return () => {
        unsubscribe()
        removeEntry?.()
        undo?.()
      }
    }, 'agent-bridge: Workspace browser rows or panel list entry')
    ctx.effect(() => slots.inject('sidebar.session.row.leading', () => slots.register({
      name: 'sidebar.session.row.leading',
      id: 'agent-bridge.mark',
      order: -100,
    }, EngineMark)), 'agent-bridge: engine mark on browser rows')
    ctx.effect(() => slots.inject('sidebar.session.row.trailing', () => slots.register({
      name: 'sidebar.session.row.trailing',
      id: 'agent-bridge.indicators',
      locale: NS,
    }, RowIndicators)), 'agent-bridge: unread and branch indicators on browser rows')
  }
  const scope = ctx.configForms.get<ExternalEnginesSection>(ENTRY_ID)
  const alwaysAllow = async (tool: string): Promise<void> => {
    const current = scope.getSnapshot().value?.allowedTools ?? []
    if (!current.includes(tool)) await scope.set('allowedTools', [...current, tool])
  }
  let startDshSession: ((request: DshSwitchRequest) => Promise<string | undefined>) | undefined
  ctx.effect(() => slots.inject('main', () => slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({
      hooks: { selection: store, transcript }, controller: transcript, startDshSession: async (request: DshSwitchRequest) => startDshSession === undefined ? 'DeepSeek Harness is not ready' : await startDshSession(request), getDefaultCwd: () => defaultCwd, codexEnabled: () => codexEnabled, openSettings: canOpenSettings() ? openSettings : undefined, alwaysAllow, clearSelection, openSession: open, takePendingCwd,
      // The frame marks a collapsed sidebar column on its root; ctx.layout only offers the toggle.
      sidebar: { collapsed: () => document.querySelector('[data-sidebar-collapsed]') !== null, toggle: () => { ctx.layout.toggleSidebar() } },
      leave: () => { ctx.layout.selectPanel(null) },
    }),
  }, withMode(mode, ExternalPanel, SessionsPage))), 'agent-bridge: main panel')

  ctx.effect(() => slots.inject('plugins.bundle.config', () => slots.register({
    name: 'plugins.bundle.config',
    key: PACKAGE_NAME,
    locale: NS,
    inject: () => ({ hooks: { scope }, save: async (field: string, value: unknown) => { await scope.set(field, value) } }),
  }, SettingsCard)), 'agent-bridge: configuration page')
  ctx.effect(() => slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'agent-bridge',
    order: 30,
    label: () => t('about.nav'),
    locale: NS,
    inject: () => ({ getDefaultCwd: () => defaultCwd, codexEnabled: () => codexEnabled }),
  }, AboutSection)), 'agent-bridge: settings tab')
  // dsh 0.2.2 resolves the row menu from the context-menu registry; external rows open the plugin's own target family there.
  ctx.inject(['contextMenus'] as never, (menuCtx: ClientContext) => {
    const menus = (menuCtx as unknown as { contextMenus: ContextMenus }).contextMenus
    contextMenus = menus
    menuCtx.effect(() => () => { if (contextMenus === menus) contextMenus = undefined }, 'agent-bridge: context menu service')
    const rowOf = (value: ExternalMenuTarget['value']): string | undefined => {
      const raw = value.sessionId.slice(EXTERNAL_PREFIX.length)
      return isDraft(raw) ? undefined : raw
    }
    const action = (id: string, order: number, resolve: (value: ExternalMenuTarget['value'], raw: string) => readonly MenuAction[]): void => {
      menuCtx.effect(() => menus.register({
        id: `agent-bridge.${id}`, target: EXTERNAL_MENU_KIND, order,
        observe: () => [store, ctx.locale],
        resolve: (value) => {
          const raw = rowOf(value)
          return raw === undefined ? [] : resolve(value, raw)
        },
      }), `agent-bridge: ${id} row menu`)
    }
    action('pin', 100, (_value, raw) => {
      const isPinned = pinned.includes(raw)
      return [{ id: 'pin', label: t(isPinned ? 'menu.unpin' : 'menu.pin'), icon: { key: isPinned ? 'workspace.unpin' : 'workspace.pin' }, run: () => { pinRow(raw, !isPinned) } }]
    })
    action('rename', 200, (value) => {
      const request = renameRequest.current
      if (request === undefined) return []
      return [{ id: 'rename', label: t('menu.rename'), icon: { key: 'workspace.rename' }, run: () => { request(value.sessionId, String(value.displayTitle ?? '')) } }]
    })
    action('fork', 300, (value, raw) => engineOfSession(raw) === 'pi' && running.has(raw) ? [] : [{ id: 'fork', label: t('menu.fork'), icon: { key: 'workspace.fork' }, run: () => { forkRow(raw, String(value.displayTitle ?? '')) } }])
    action('archive', 600, (_value, raw) => [{ id: 'archive', label: t('menu.archive'), icon: { key: 'workspace.archive' }, separatorBefore: true, run: () => { archiveRow(raw) } }])
  })
  const engines = createEngineStore()
  const startChat = (provider: string, text: string, cwd: string, extras: SendExtras): void => {
    pendingCwd = cwd
    open(draftIdFor(provider))
    void transcript.send(text, cwd, extras)
  }
  // The native seat's directory resolves through the caller's context, so remote.session must be injected here as well.
  ctx.inject(['sessions', 'modelDirectories', 'conversation', 'remote', 'remote.session'] as never, (seatCtx: ClientContext) => {
    const { modelDirectories, sessions, conversation } = seatCtx as unknown as SeatContext
    const known = new Map<string, SeatServices>()
    const servicesFor = (sessionId: string): { services: SeatServices } => {
      const existing = known.get(sessionId)
      if (existing !== undefined) return { services: existing }
      let directory: ReturnType<SeatContext['modelDirectories']['directoryFor']> | undefined
      try {
        directory = modelDirectories.directoryFor(sessionId)
      } catch (error) {
        console.warn('agent-bridge: model directory is not ready', error)
      }
      const services: SeatServices = {
        ...directory === undefined ? {} : { catalog: directory.store },
        loadCatalog: () => { directory?.load().catch((error: unknown) => { console.warn('agent-bridge: model catalog failed', error) }) },
        selectModel: (selection) => { directory?.select(selection).catch((error: unknown) => { console.warn('agent-bridge: model selection failed', error) }) },
        engines, openSettings: canOpenSettings() ? openSettings : undefined,
        nativePermission: () => {
          const entry = seatSlots.entries('conversation.input.permission').find(item => item.component !== HiddenPermission && item.inject !== undefined)
          const injected = entry?.inject?.(sessionId) as { hooks?: { permissionCatalog?: NativePermission['catalog'] }; select?: NativePermission['select'] } | undefined
          return injected?.hooks?.permissionCatalog === undefined || injected.select === undefined ? undefined : { catalog: injected.hooks.permissionCatalog, select: injected.select }
        },
        getCwd: () => sessions.list.getSnapshot().byId[sessionId]?.cwd ?? defaultCwd,
        subscribeSessions: listener => sessions.list.subscribe(listener),
        isBlank: () => sessions.list.getSnapshot().byId[sessionId]?.blank === true,
        codexEnabled: () => codexEnabled,
        subscribeBridge: listener => store.subscribe(listener),
      }
      if (directory !== undefined) known.set(sessionId, services)
      return { services }
    }
    seatCtx.effect(() => {
      const { remote } = seatCtx as unknown as SeatContext
      nativeBranchTargets = () => Object.entries(sessions.list.getSnapshot().byId).flatMap(([key, session]) => session?.cwd === undefined || session.blank === true ? [] : [{ key, cwd: session.cwd }])
      void refreshBranches()
      /** A DSH build that refuses the history falls back to a new session whose first message carries it as text. */
      const emptySessionWithCatchup = async (fromId: string, text: string, cwd: string): Promise<{ sessionId: string; prompt: string } | string> => {
        const response = await fetch(`${CATCHUP_PATH}?${new URLSearchParams({ id: fromId }).toString()}`, { credentials: 'same-origin' })
        if (!response.ok) return ((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`
        const { catchup } = await response.json() as { catchup: string }
        return { sessionId: await sessions.create({ cwd }), prompt: composeSwitchPrompt(text, catchup) }
      }
      startDshSession = async ({ fromId, title, text, cwd, modelId, effort }) => {
        try {
          const provider = modelId.slice(0, modelId.indexOf('/'))
          const model = modelId.slice(provider.length + 1)
          const imported = await fetch(DSH_IMPORT_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: fromId, cwd, provider, model, ...effort === '' ? {} : { effort } } satisfies DshImportBodyWire) })
          let target: { sessionId: string; prompt: string } | string
          if (imported.ok) {
            target = { sessionId: (await imported.json() as { sessionId: string }).sessionId, prompt: text }
            await sessions.refresh()
            const renamed = await remote.session.rename({ sessionId: target.sessionId, title })
            if (!renamed.ok) console.warn('agent-bridge: imported session title failed', renamed.error.message)
          } else {
            console.warn('agent-bridge: history import failed, using catch-up text', await imported.text())
            target = await emptySessionWithCatchup(fromId, text, cwd)
          }
          if (typeof target === 'string') return target
          const { sessionId } = target
          const selected = await remote.session.selectModel({ sessionId, provider, model, ...effort === '' ? {} : { reasoningEffort: effort } })
          if (!selected.ok) return selected.error.message
          const sent = await remote.session.prompt({ requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: target.prompt }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
          if (!sent.ok) return sent.error.message
          ;(ctx.uiWorkspace as unknown as { openSession(id: string): void }).openSession(sessionId)
          return undefined
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      }
      return () => { startDshSession = undefined; nativeBranchTargets = () => [] }
    }, 'agent-bridge: switch to a DSH session')
    const seatSlots = slots as unknown as SeatSlots
    seatCtx.effect(() => seatSlots.inject('conversation.input.model', () => seatSlots.register({
      name: 'conversation.input.model', priority: -1, locale: NS, inject: servicesFor,
    }, ProviderSeat)), 'agent-bridge: model seat')
    seatCtx.effect(() => seatSlots.inject('conversation.input.permission', () => seatSlots.register({
      name: 'conversation.input.permission', priority: -1,
    }, HiddenPermission)), 'agent-bridge: permission moves to the selector')
    // The native composer stays on screen; only the send of a blank session with Claude or Codex selected is routed here.
    seatCtx.effect(() => {
      const prototype = Object.getPrototypeOf(conversation) as ConversationSend
      const original = prototype.sendSession
      if (typeof original !== 'function') {
        console.warn('agent-bridge: this DSH build has no conversation.sendSession; new chats stay with DSH')
        return () => {}
      }
      prototype.sendSession = function (this: ConversationSend, session, text, attachmentIds, mode, signal, accept) {
        const engine = engines.getSnapshot()
        if (engine === 'dsh' || !currentProviders().some(item => item.id === engine) || !isEngineEnabled(currentModelPrefs(), engine) || sessions.list.getSnapshot().byId[session.sessionId]?.blank !== true) return original.call(this, session, text, attachmentIds, mode, signal, accept)
        return startFromComposer(engine, session.sessionId, text, attachmentIds, accept)
      }
      return () => { prototype.sendSession = original }
    }, 'agent-bridge: new-chat send routing')
    const startFromComposer = async (engine: string, sessionId: string, text: string, attachmentIds: readonly string[], accept: (() => void) | undefined): Promise<{ kind: 'success' | 'error'; text?: string }> => {
      const { attachments } = await conversation.serializeDraftAttachments(attachmentIds)
      const images = attachments.flatMap(item => item.type === 'image' ? [{ name: item.name ?? 'image', mime: item.mediaType, base64: item.data }] : [])
      if (images.length !== attachments.length) return { kind: 'error', text: t('picker.filesUnsupported') }
      const response = await fetch(`${CHOICE_PATH}?${new URLSearchParams({ engine }).toString()}`, { credentials: 'same-origin' })
      const choice = await response.json() as ChoiceWire
      const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd ?? defaultCwd
      const effort = engineLabels(engine, await loadInfo(engine, cwd).catch(() => undefined), choice).effortId
      startChat(engine, text.trim() === '' ? t('composer.seeAttached') : text, cwd, {
        ...choice.model === '' ? {} : { model: choice.model }, ...effort === '' ? {} : { effort },
        ...choice.permission === undefined || choice.permission === '' ? {} : { permission: choice.permission },
        ...choice.speed === undefined ? {} : { speed: choice.speed },
        ...images.length === 0 ? {} : { attachments: images },
      })
      accept?.()
      for (const id of attachmentIds) conversation.releaseDraftAttachment(id)
      return { kind: 'success' }
    }
  })
  ctx.effect(() => () => { transcript.close() }, 'agent-bridge: transcript teardown')
  // Re-list when the row limit changes and when the tab becomes visible again (sessions created in a terminal).
  let lastLimit = scope.getSnapshot().value?.sessionLimit
  ctx.effect(() => scope.subscribe(() => {
    const limit = scope.getSnapshot().value?.sessionLimit
    if (limit === lastLimit) return
    lastLimit = limit
    void refresh()
  }), 'agent-bridge: relist on settings change')
  ctx.effect(() => {
    const branches = window.setInterval(() => { void refreshBranches() }, 120_000)
    // Sessions also change in other apps, so the unread state cannot wait for a turn here.
    const list = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 30_000)
    return () => { window.clearInterval(branches); window.clearInterval(list) }
  }, 'agent-bridge: follow branch and unread states')
  ctx.effect(() => {
    const timer = window.setInterval(() => { if (running.size > 0) void refresh() }, 4000)
    return () => { window.clearInterval(timer) }
  }, 'agent-bridge: follow running sessions')
  ctx.effect(() => {
    const onNew = (event: Event): void => {
      pendingCwd = (event as CustomEvent<{ cwd: string }>).detail.cwd
      open(NEW_SESSION_ID)
    }
    window.addEventListener('agent-bridge:new-session', onNew)
    return () => { window.removeEventListener('agent-bridge:new-session', onNew) }
  }, 'agent-bridge: new session in a directory')
  ctx.effect(() => {
    const onRefresh = (): void => { void refresh() }
    window.addEventListener('agent-bridge:refresh', onRefresh)
    return () => { window.removeEventListener('agent-bridge:refresh', onRefresh) }
  }, 'agent-bridge: relist on request')
  ctx.effect(() => {
    const onVisible = (): void => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, 'agent-bridge: relist on focus')
  void refresh()
}
