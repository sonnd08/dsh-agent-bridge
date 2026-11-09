/**
 * dsh-agent-bridge, Host half. Serves Claude Code, Codex and Pi sessions to the browser half over the
 * authenticated Connection Fetch channel: the session list, transcripts, live turns, session management,
 * and a change feed for the transcript file.
 * @module dsh-agent-bridge
 */
import { authorizeEngineCall } from './engine-access.ts'
import { loginTarget, LoginFlows, pollLogin, readLoginStatus, type EngineLogin } from './login.ts'
import { dropCachedInfo, infoCachePrefix, infoEngine, parseId, prefixed, type EngineId } from './engine-id.ts'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  deleteClaudeSession, findClaudeFile, forkClaudeSession, listClaudeRows, serializeClaudeSdk, readClaudeGoal, readClaudeMessages, readClaudeUsage, renameClaudeSession, searchClaude,
} from './claude.ts'
import { CodexEngine } from './codex.ts'
import { listPiRows, PiEngine, findPiFile, readPiMessages, readPiUsage, searchPi } from './pi.ts'
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk'
import { baseOptions, probeInfo, probeTools, RunManager, SCREEN_SERVER, type TurnOptions } from './run.ts'
import { readTasks, tasksAction } from './taskmaster.ts'
import { voiceAction } from './voice.ts'
import { watchStream } from './watch.ts'
import { resolveCommand } from './commands.ts'
import { readAbout } from './about.ts'
import { claudePermission, codexPermission, parsePreset } from './permissions.ts'
import { startHeapWatch } from './diagnostics.ts'
import { createSingleFlight } from './single-flight.ts'
import { parseModelPrefs } from './model-prefs.ts'
import { completedPrefix, forkedLink, mergeUnlistedForks } from './fork.ts'
import { allTurns, importEvents, type SeedEvent } from './dsh-import.ts'
import { BranchStatusReader } from './branch-status.ts'
import { handoffFileName, handoffNote, renderHandoff } from './handoff.ts'
import { claudeDriver, createEngineHost, ENGINE_TOOL, type EngineModel, type ProxyExecution } from './native-engine.ts'
import { codexDriver } from './native-codex.ts'
import { routeOf } from './native-routes.ts'
import { lastUsedModel } from './used-model.ts'
import { hasTurnSince, historyTurnLimit, importSelection, importStep, isQuiet, markResync, mirrorNeedsRead, nativeThreadRowIds, planMirror } from './mirror.ts'
import { choiceFromUsed } from './client/model-names.ts'
import { engineCatalog, visibleRows } from './client/model-names.ts'

/** Chats read for import in each engine; the session list limit applies if it is higher. */
const MIRROR_LIST_LIMIT = 300
import { DEFAULT_EFFORT } from './model-prefs.ts'
import { claudeExtrasOf, codexLaunchOf, expandHome, parseInstance } from './instances.ts'
import { cleanTitle, composeSwitchPrompt, hiddenThreadIds, stripCatchup, isCommand, linkOf, mergeLinkedMessages, planSwitch, readableCatchup, recordSwitch, removeThread, renderCatchup, withoutCatchup, type ThreadLink } from './links.ts'
import { changeSkill, defaultStatePath, listSkills, mcpChange, prepareAttachments, readGitConfig, Scheduler, StateStore, writeGitConfig, handoffDir } from './extras.ts'
import {
  browseDirs, fsAction, gitClone, gitWorktreeAction, gitWorktrees, readImage,
  gitAction, gitBranches, gitCompare, gitDiff, gitDraftMessage, gitLog, gitRemote, gitShow, gitStatus, HttpError, listDir, readText, TerminalManager, writeText,
} from './workbench.ts'
import {
  LOGIN_PATH, type LoginBodyWire, type LoginWire, ABOUT_PATH, ANSWER_PATH, ARCHIVE_PATH, BRANCH_STATUS_PATH, type BranchStateWire, type BranchTargetWire, CATCHUP_PATH, SEEN_PATH, DSH_IMPORT_PATH, type DshImportBodyWire, MIRROR_PATH, type MirrorSyncWire, INSTANCES_PATH, MODEL_PREFS_PATH, providerId, withInstanceId, type InstanceBodyWire, type ProviderInstanceWire, PIN_PATH, CHOICE_PATH, DRAFT_PATH, GIT_CONFIG_PATH, INFO_PATH, MCP_PATH, SEARCH_PATH, SKILLS_PATH,
  type ChoiceWire, type InfoWire, type McpBodyWire, type SkillBodyWire,
  FS_LIST_PATH, FS_READ_PATH, FS_WRITE_PATH, GIT_ACTION_PATH, GIT_BRANCHES_PATH, GIT_DIFF_PATH, GIT_LOG_PATH, GIT_STATUS_PATH,
  FS_ACTION_PATH, FS_BROWSE_PATH, FS_IMAGE_PATH, type FsActionWire,
  TASKS_PATH, VOICE_PATH, type TasksBodyWire, type VoiceBodyWire,
  CLONE_PATH, GIT_WORKTREES_PATH, SCHEDULE_PATH, type ScheduleBodyWire, type WorktreeBodyWire,
  GIT_COMPARE_PATH, GIT_MESSAGE_PATH, GIT_REMOTE_PATH, GIT_SHOW_PATH,
  TERM_CLOSE_PATH, TERM_INPUT_PATH, TERM_OPEN_PATH, TERM_RESIZE_PATH, TERM_STREAM_PATH, type GitActionWire, type TermEventWire,
  type EngineName, INTERRUPT_PATH, LIVE_PATH, MANAGE_PATH, SCREEN_STATUS_PATH, SEND_PATH, SESSIONS_PATH, SESSION_PATH, WATCH_PATH,
  type AnswerBodyWire, type GoalWire, type LiveEventWire, type ManageBodyWire, type MessageWire, type SessionRowWire, type SendBodyWire, type SessionWire,
} from './protocol.ts'

/** Stable plugin name (matches the `cordis.patch.yml` row id). */
export const name = 'agent-bridge'

/** Plugin settings; every field is also editable from the plugin's configuration page. */
export interface Settings {
  /** Master switch; false makes every route answer 404. */
  enabled: boolean
  /** Maximum number of Claude Code sessions listed, newest first. */
  sessionLimit: number
  /** Polling interval of the transcript-file watcher, in milliseconds. */
  watchIntervalMs: number
  /** Executable the SDK starts for each turn (the proxy wrapper); empty uses the SDK's bundled binary. */
  claudeExecutable: string
  /** Working directory offered for new sessions; empty uses the home directory. */
  defaultCwd: string
  /** Permission mode of turns started from dsh. */
  permissionMode: 'default' | 'acceptEdits' | 'plan'
  /** dsh memory file appended to the system prompt of new sessions; empty disables the bridge. */
  memoryFile: string
  /** Add the Peekaboo screen-control MCP server to every turn. */
  computerUse: boolean
  /** Add the Playwright browser MCP server to every turn. */
  browserUse: boolean
  /** Speech backend (OpenAI-compatible); empty disables voice. */
  voiceBaseUrl: string
  /** Environment variable holding the backend key. */
  voiceApiKeyEnv: string
  voiceSttModel: string
  voiceTtsModel: string
  voiceTtsVoice: string
  /** Command that runs `task-master-ai` (`npx` fetches the pinned version). */
  taskmasterCommand: string
  /** Show the browser window instead of running it headless. */
  browserHeaded: boolean
  /** Peekaboo executable. */
  peekabooCommand: string
  /** Show Codex sessions and allow starting them. */
  codexEnabled: boolean
  /** `codex` executable that provides `app-server`. */
  codexExecutable: string
  /** Most recent Codex turns read when a session opens; older turns are left out. */
  codexHistoryTurns: number
  /** Approval policy of Codex turns started from dsh. */
  codexApprovalPolicy: 'untrusted' | 'on-request'
  /** Sandbox of Codex turns started from dsh. */
  codexSandbox: 'read-only' | 'workspace-write'
  /** Show Pi sessions and allow starting them. Off by default because Pi runs commands and edits files without asking. */
  piEnabled: boolean
  /** `pi` executable; each turn starts its RPC mode. Pi runs tool calls without asking. */
  piExecutable: string
  /** Heap size in MB that makes the Host write a heap snapshot under `<state folder>/heap`; 0 turns the watch off. */
  heapWatchMb: number
  /** Tools approved without asking (Claude Code permission-rule syntax, e.g. `Bash(git status)`). */
  allowedTools: string[]
}

/**
 * The whole entry config is one volatile reference: a settings edit is committed into the running plugin
 * instead of remounting it, so turns in progress survive it.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  sessionLimit: Schema.natural().min(1).default(100),
  watchIntervalMs: Schema.natural().min(50).default(500),
  claudeExecutable: Schema.string().default('claude'),
  defaultCwd: Schema.string().default(''),
  permissionMode: Schema.union(['default', 'acceptEdits', 'plan'] as const).default('default'),
  memoryFile: Schema.string().default(''),
  computerUse: Schema.boolean().default(true),
  browserUse: Schema.boolean().default(true),
  taskmasterCommand: Schema.string().default('npx'),
  voiceBaseUrl: Schema.string().default(''),
  voiceApiKeyEnv: Schema.string().default('VOICE_API_KEY'),
  voiceSttModel: Schema.string().default('whisper-1'),
  voiceTtsModel: Schema.string().default('tts-1'),
  voiceTtsVoice: Schema.string().default('alloy'),
  browserHeaded: Schema.boolean().default(false),
  peekabooCommand: Schema.string().default('peekaboo'),
  codexEnabled: Schema.boolean().default(true),
  codexExecutable: Schema.string().default('codex'),
  codexHistoryTurns: Schema.natural().min(1).default(20),
  codexApprovalPolicy: Schema.union(['untrusted', 'on-request'] as const).default('untrusted'),
  codexSandbox: Schema.union(['read-only', 'workspace-write'] as const).default('workspace-write'),
  piEnabled: Schema.boolean().default(false),
  piExecutable: Schema.string().default('pi'),
  heapWatchMb: Schema.natural().default(0),
  allowedTools: Schema.array(Schema.string()).default([]),
}).volatile()

/** The config the host passes to `apply`. */
export type Config = Volatile<Settings>

/** Services this plugin requires. */
export const inject = ['connection']

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function idOf(request: Request): EngineId | undefined {
  return parseId(new URL(request.url, 'http://host').searchParams.get('id') ?? '')
}

/** What the routes need from an engine; each engine provides one. */
interface Driver {
  /** @param full - read the whole chat and not only the recent part that a panel shows. */
  readMessages(id: string, full?: boolean): Promise<{ messages: MessageWire[]; recentTurns?: number }>
  readGoal(id: string): Promise<GoalWire | undefined>
  findFile(id: string): Promise<string | undefined>
  subscribe(id: string, subscriber: (event: LiveEventWire) => void): () => void
  isRunning(id: string): boolean
  interrupt(id: string): Promise<boolean>
  answer(id: string, requestId: string, body: AnswerBodyWire): boolean
  fork(id: string, title?: string): Promise<string>
  rename(id: string, title: string): Promise<void>
  delete(id: string): Promise<void>
}

async function watchResponse(request: Request, intervalMs: number, driverOf: (engine: EngineName, instance?: string) => Driver): Promise<Response> {
  const parsed = idOf(request)
  const file = parsed === undefined ? undefined : await driverOf(parsed.engine, parsed.instance).findFile(parsed.raw)
  if (file === undefined) return json({ error: 'unknown session' }, 404)
  return watchStream(file, intervalMs, request.signal)
}

function homedirOf(settings: Settings): string {
  return settings.defaultCwd === '' ? homedir() : settings.defaultCwd
}

function turnOptions(settings: Settings, sessionId: string | undefined, text: string, cwd: string, memory = '', extra: Pick<TurnOptions, 'model' | 'effort' | 'speed' | 'images' | 'configDir' | 'extraArgs'> & { readonly executable?: string } = {}): TurnOptions {
  return {
    ...extra,
    ...sessionId === undefined ? {} : { sessionId },
    cwd, text,
    executable: extra.executable ?? settings.claudeExecutable,
    permissionMode: settings.permissionMode,
    allowedTools: settings.allowedTools,
    computerUse: settings.computerUse,
    browserUse: settings.browserUse,
    browserHeaded: settings.browserHeaded,
    peekabooCommand: settings.peekabooCommand,
    memory,
    additionalDirectories: [handoffDir()],
  }
}

function liveResponse(request: Request, driverOf: (engine: EngineName, instance?: string) => Driver): Response {
  const parsed = idOf(request)
  if (parsed === undefined) return json({ error: 'unknown session' }, 404)
  const encoder = new TextEncoder()
  let release: (() => void) | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: LiveEventWire): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      release = driverOf(parsed.engine, parsed.instance).subscribe(parsed.raw, send)
      request.signal.addEventListener('abort', () => release?.(), { once: true })
    },
    cancel: () => release?.(),
  })
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}

/**
 * Register the routes.
 * @param ctx - plugin context.
 * @param config - configuration from the composition entry.
 */
/** Host services that create a DSH session with history; their types belong to the harness packages. */
interface DshHostServices {
  readonly agents: { create(options: { sessionId: string; seed: readonly SeedEvent[]; meta: { cwd: string; agentPreset?: string }; agentOptions: { provider: string; model: string; reasoningEffort?: string }; setup?: (agentCtx: Context) => Promise<void> }): Promise<{ readonly agent: { readonly id: string }; dispose(): Promise<void> }> }
  readonly agentPresets?: { resolve(id: undefined): Promise<{ readonly id: string }>; mount(agentCtx: Context, id: string): Promise<void> }
  readonly workspaceRegistry?: { list(): readonly { readonly path: string; attachSession(id: string): Promise<void> }[] }
}

export function apply(ctx: Context, config: Config): void {
  const current = (): Settings => {
    const settings = config.get() as Settings
    return {
      ...settings,
      claudeExecutable: resolveCommand(settings.claudeExecutable),
      codexExecutable: resolveCommand(settings.codexExecutable),
      piExecutable: resolveCommand(settings.piExecutable),
      peekabooCommand: resolveCommand(settings.peekabooCommand),
    }
  }
  const connection = ctx.connection
  const runs = new RunManager()
  let codexEngine: CodexEngine | undefined
  const codex = (): CodexEngine => {
    codexEngine ??= new CodexEngine(current().codexExecutable)
    return codexEngine
  }
  let piEngine: PiEngine | undefined
  const pi = (): PiEngine => {
    piEngine ??= new PiEngine(current().piExecutable)
    return piEngine
  }
  let syncNativeRoutes = (): void => {}
  let nativeHost: Pick<ReturnType<typeof createEngineHost>, 'armReplay' | 'isActive'> | undefined
  const store = new StateStore(process.env['AGENT_BRIDGE_STATE'] ?? defaultStatePath(), defaultStatePath('external-engines'))
  // Claude Code needs the folder to exist before it can be allowed to read it.
  void mkdir(handoffDir(), { recursive: true, mode: 0o700 }).catch((error: unknown) => { console.warn('agent-bridge: conversation folder failed', error) })
  const syncClaudeSerialization = (): void => { serializeClaudeSdk(store.get('instances').some(item => item.engine === 'claude')) }
  syncClaudeSerialization()
  const requireInstance = (id: string): ProviderInstanceWire => {
    const found = store.get('instances').find(item => item.id === id)
    if (found === undefined) throw new HttpError(404, `unknown provider instance ${id}`)
    return found
  }
  const codexEngines = new Map<string, CodexEngine>()
  const codexFor = (instance: string | undefined): CodexEngine => {
    if (instance === undefined) return codex()
    const known = codexEngines.get(instance)
    if (known !== undefined) return known
    const { executable, launch } = codexLaunchOf(requireInstance(instance), current().codexExecutable)
    const engine = new CodexEngine(executable, launch)
    codexEngines.set(instance, engine)
    return engine
  }
  /** What a Claude turn or probe of an added instance needs. */
  const claudeExtras = (instance: string | undefined): Pick<TurnOptions, 'configDir' | 'extraArgs'> & { readonly executable?: string } => {
    if (instance === undefined) return {}
    return claudeExtrasOf(requireInstance(instance))
  }
  const claudeHome = (instance: string | undefined): string | undefined => instance === undefined ? undefined : expandHome(requireInstance(instance).home)
  const terminals = new TerminalManager()
  ctx.effect(() => () => {
    terminals.closeAll()
    void runs.closeAll()
    void codexEngine?.closeAll()
    for (const engine of codexEngines.values()) void engine.closeAll()
    piEngine?.closeAll()
  }, 'agent-bridge: runs')
  const makeClaudeDriver = (home?: string): Driver => ({
    readMessages: async id => ({ messages: await readClaudeMessages(id, home) }),
    readGoal: id => readClaudeGoal(id, home),
    findFile: id => findClaudeFile(id, home),
    subscribe: (id, subscriber) => runs.subscribe(id, subscriber),
    isRunning: id => runs.isRunning(id),
    interrupt: id => runs.interrupt(id),
    answer: (id, requestId, body) => runs.answer(id, requestId, body.behavior === 'allow'
      ? { behavior: 'allow', ...body.answers === undefined ? {} : { answers: body.answers } }
      : { behavior: 'deny' }),
    fork: async (id, title) => {
      const prompt = runs.runningPrompt(id)
      const prefix = prompt === undefined ? {} : completedPrefix(await readClaudeMessages(id, home), prompt)
      if (prefix === undefined) throw new HttpError(409, 'this session has no completed turn to fork from')
      return await forkClaudeSession(id, home, { ...title === undefined ? {} : { title }, ...prefix })
    },
    rename: (id, title) => renameClaudeSession(id, title, home),
    delete: id => deleteClaudeSession(id, home),
  })
  const makeCodexDriver = (engine: () => CodexEngine): Driver => ({
    readMessages: async (id, full) => {
      const turns = historyTurnLimit(full === true, current().codexHistoryTurns)
      const page = await engine().readMessages(id, turns)
      return { messages: page.messages, ...page.earlierOmitted ? { recentTurns: turns } : {} }
    },
    readGoal: id => engine().readGoal(id),
    findFile: id => engine().findFile(id),
    subscribe: (id, subscriber) => engine().subscribe(id, subscriber),
    isRunning: id => engine().isRunning(id),
    interrupt: id => engine().interrupt(id),
    answer: (id, requestId, body) => engine().answer(id, requestId, body.behavior === 'allow'
      ? { behavior: 'allow', ...body.answers === undefined ? {} : { answers: body.answers }, ...body.remember === true ? { remember: true } : {} }
      : { behavior: 'deny' }),
    fork: async (id, title) => {
      const forked = await engine().fork(id)
      if (title !== undefined) await engine().rename(forked, title)
      return forked
    },
    rename: (id, title) => engine().rename(id, title),
    delete: id => engine().delete(id),
  })
  const piDriver: Driver = {
    readMessages: async id => ({ messages: await readPiMessages(id) }),
    readGoal: () => Promise.resolve(undefined),
    findFile: findPiFile,
    subscribe: (id, subscriber) => pi().subscribe(id, subscriber),
    isRunning: id => pi().isRunning(id),
    interrupt: id => Promise.resolve(pi().interrupt(id)),
    answer: (id, requestId, body) => pi().answer(id, requestId, body.behavior === 'allow'
      ? { behavior: 'allow', ...body.answers === undefined ? {} : { answers: body.answers } }
      : { behavior: 'deny' }),
    fork: id => pi().fork(id),
    rename: (id, title) => pi().rename(id, title),
    delete: id => pi().delete(id),
  }
  const drivers: Readonly<Record<EngineName, Driver>> = { claude: makeClaudeDriver(), codex: makeCodexDriver(codex), pi: piDriver }
  const instanceDrivers = new Map<string, Driver>()
  const driverOf = (engine: EngineName, instance?: string): Driver => {
    if (instance === undefined) return drivers[engine]
    const known = instanceDrivers.get(instance)
    if (known !== undefined) return known
    const made = engine === 'codex' ? makeCodexDriver(() => codexFor(instance)) : makeClaudeDriver(claudeHome(instance))
    instanceDrivers.set(instance, made)
    return made
  }
  const heapWatchMb = current().heapWatchMb
  const heapWatch = heapWatchMb > 0 ? startHeapWatch(join(dirname(defaultStatePath()), 'heap'), heapWatchMb) : undefined
  ctx.effect(() => () => { heapWatch?.stop() }, 'agent-bridge: heap watch')
  const route = (
    path: string, handler: (request: Request, config: Settings) => Promise<Response> | Response, label: string, method: 'GET' | 'POST' | 'BOTH' = 'GET',
  ): void => {
    ctx.effect(() => connection.fetch.register({
      path,
      methods: method === 'BOTH' ? ['GET', 'POST'] : [method],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (!current().enabled) return json({ error: 'disabled' }, 404)
        const left = heapWatch?.enter(label)
        try {
          return await handler(request, current())
        } catch (error) {
          if (error instanceof HttpError) return json({ error: error.message }, error.status)
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        } finally {
          left?.()
        }
      },
    }), `agent-bridge: ${label} route`)
  }
  route(SESSIONS_PATH, async (request, settings) => {
    const warnings: string[] = []
    let codexRows: SessionRowWire[] = []
    if (settings.codexEnabled) {
      try {
        codexRows = await codex().listRows(settings.sessionLimit)
      } catch (error) {
        warnings.push(`codex: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const archived = new Set(store.get('archived'))
    const wantArchived = query(request, 'archived') === '1'
    const piRows = settings.piEnabled ? await listPiRows(settings.sessionLimit) : []
    const instanceRows = (await Promise.all(store.get('instances').map(async (item): Promise<SessionRowWire[]> => {
      try {
        const listed = item.engine === 'codex' ? await codexFor(item.id).listRows(settings.sessionLimit) : await listClaudeRows(settings.sessionLimit, claudeHome(item.id))
        return listed.map(row => ({ ...row, id: withInstanceId(row.id, item.id) }))
      } catch (error) {
        warnings.push(`${item.id}: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }))).flat()
    const saved = store.get('unlistedForks')
    const { rows: all, unlisted } = mergeUnlistedForks([...await listClaudeRows(settings.sessionLimit), ...codexRows, ...piRows, ...instanceRows], saved)
    if (unlisted.length !== saved.length) store.set('unlistedForks', unlisted)
    const hidden = new Set([...hiddenThreadIds(store.get('links')), ...nativeThreadRowIds(store.get('engineThreads'), store.get('instances'))])
    const rows = all.filter(row => archived.has(row.id) === wantArchived && !hidden.has(row.id)).map(row => ({ ...row, title: cleanTitle(row.title) })).sort((a, b) => b.updatedAt - a.updatedAt)
    const running = rows.filter((row) => {
      const parsed = parseId(row.id)
      return parsed !== undefined && driverOf(parsed.engine, parsed.instance).isRunning(parsed.raw)
    }).map(row => row.id)
    const marks = store.get('seen')
    // A session is unread only after the first listing, so that a new install does not mark every row.
    if (!wantArchived && rows.some(row => marks[row.id] === undefined)) store.set('seen', Object.fromEntries(rows.map(row => [row.id, marks[row.id] ?? row.updatedAt])))
    const sessions = rows.map(row => ({ ...row, unread: marks[row.id] !== undefined && row.updatedAt > (marks[row.id] as number) && !running.includes(row.id) }))
    return json({ sessions, running, pinned: store.get('pinned'), defaultCwd: homedirOf(settings), codexEnabled: settings.codexEnabled, // A bare name means the command was not found, so no new-session entry is offered.
      piEnabled: settings.piEnabled && settings.piExecutable.includes('/'), warnings })
  }, 'sessions')
  // A transcript can be tens of megabytes; requests that arrive while it is being read share that read.
  const sessionReads = createSingleFlight<SessionWire>()
  /** Transcripts of a linked conversation; a thread that cannot be read must not hide the open one. */
  const linkedThreads = async (link: ThreadLink, openId: string, openMessages: readonly MessageWire[]): Promise<Record<string, readonly MessageWire[]>> => {
    const others = Object.values(link.threads).filter((id): id is string => id !== undefined && id !== openId)
    const read = await Promise.all(others.map(async (id): Promise<[string, readonly MessageWire[]]> => {
      const other = parseId(id)
      if (other === undefined) return [id, []]
      try {
        return [id, (await driverOf(other.engine, other.instance).readMessages(other.raw)).messages]
      } catch (error) {
        console.warn('agent-bridge: linked thread could not be read', id, error)
        return [id, []]
      }
    }))
    return { ...Object.fromEntries(read), [openId]: openMessages }
  }
  const forkThread = async (id: string, title?: string): Promise<string> => {
    const parsed = parseId(id)
    if (parsed === undefined) throw new HttpError(404, 'unknown session')
    return prefixed(parsed.engine, await driverOf(parsed.engine, parsed.instance).fork(parsed.raw, title), parsed.instance)
  }
  const readThread = async (id: string): Promise<readonly MessageWire[]> => {
    const parsed = parseId(id)
    if (parsed === undefined) throw new HttpError(404, 'unknown session')
    return (await driverOf(parsed.engine, parsed.instance).readMessages(parsed.raw)).messages
  }
  /** Fork one thread with its own engine. A conversation across providers forks every thread, so that the fork keeps the whole transcript and can switch. */
  const forkConversation = async (id: string, title?: string): Promise<string> => {
    const link = linkOf(store.get('links'), id)
    if (link === undefined) return await forkThread(id, title)
    const sources = await linkedThreads(link, id, await readThread(id))
    const forks: Record<string, string> = {}
    try {
      for (const thread of Object.values(link.threads)) forks[thread] = await forkThread(thread, thread === id ? title : undefined)
      const copies = Object.fromEntries(await Promise.all(Object.values(forks).map(async (fork): Promise<[string, readonly MessageWire[]]> => [fork, await readThread(fork)])))
      store.set('links', [...store.get('links'), forkedLink(link, forks, sources, copies)])
    } catch (error) {
      await Promise.allSettled(Object.values(forks).map(async (fork) => {
        const parsed = parseId(fork)
        if (parsed !== undefined) await driverOf(parsed.engine, parsed.instance).delete(parsed.raw)
      }))
      throw error
    }
    return forks[id] ?? id
  }
  const conversationMessages = async (parsed: EngineId, full = false): Promise<{ readonly messages: readonly MessageWire[]; readonly partial: boolean }> => {
    const page = await driverOf(parsed.engine, parsed.instance).readMessages(parsed.raw, full)
    const sessionId = prefixed(parsed.engine, parsed.raw, parsed.instance)
    const link = linkOf(store.get('links'), sessionId)
    return { messages: link === undefined ? page.messages : mergeLinkedMessages(link, sessionId, await linkedThreads(link, sessionId, page.messages)), partial: page.recentTurns !== undefined }
  }
  route(SEEN_PATH, async (request) => {
    const body = await request.json() as { id: string }
    store.set('seen', { ...store.get('seen'), [body.id]: Date.now() })
    return json({ ok: true })
  }, 'seen', 'POST')
  const branchReader = new BranchStatusReader(async (command, args, cwd) => (await promisify(execFile)(command === 'gh' ? resolveCommand('gh') : 'git', [...args], { cwd, timeout: 20_000, maxBuffer: 5_000_000 })).stdout)
  route(BRANCH_STATUS_PATH, async (request) => {
    const { targets } = await request.json() as { targets: readonly BranchTargetWire[] }
    const states: Record<string, BranchStateWire> = {}
    // Each row can start several git processes, so only a few rows run at one time.
    for (let start = 0; start < targets.length; start += 6) {
      await Promise.all(targets.slice(start, start + 6).map(async (target) => { states[target.key] = await branchReader.read(target.cwd, target.branch) }))
    }
    return json({ states })
  }, 'branch status', 'POST')
  // Claude Code as a DSH model provider: a chat stays one DSH session when the user changes model.
  ctx.inject(['llm', 'tools', 'agents'] as never, (native: Context) => {
    const services = native as unknown as {
      readonly llm: { registerAdapter(providers: string[], adapter: unknown): () => void }
      readonly tools: { register(tool: unknown): () => void }
      readonly agents: { get(id: string): { readonly session: { readonly header: { readonly cwd?: string } } } | undefined }
    }
    const host = createEngineHost({
      authorize: (call, exec, cwd) => {
        const session = exec.agent?.session
        const approval = ctx.get('approval' as never) as unknown as { readonly config: { readonly policy?: string }; overrideOf(session: unknown): string | undefined; request(request: unknown): Promise<string> } | undefined
        const sandbox = ctx.get('sandboxPolicy' as never) as unknown as { resolve(request: { session: unknown }): { readonly mode: string } } | undefined
        return authorizeEngineCall({
          trustedFolder: handoffDir(),
          modeOf: () => session === undefined ? undefined : sandbox?.resolve({ session }).mode,
          policyOf: () => session === undefined ? undefined : approval?.overrideOf(session) ?? approval?.config.policy ?? 'ask',
          ask: (reason) => {
            if (approval === undefined || exec.agent === undefined) throw new Error('this DSH build has no approval service')
            return approval.request({ agent: exec.agent, toolName: call.tool, ...exec.callId === undefined ? {} : { callId: exec.callId }, reason, signal: exec.signal })
          },
        }, call, cwd)
      },
      onRealTurn: (key) => {
        const marked = markResync(store.get('mirrors'), key)
        if (marked !== undefined) store.set('mirrors', marked)
      },
      cwdOf: sessionId => services.agents.get(sessionId)?.session.header.cwd ?? homedirOf(current()),
      threadOf: key => store.get('engineThreads')[key],
      saveThread: (key, thread) => { store.set('engineThreads', { ...store.get('engineThreads'), [key]: thread }) },
      writeHandoff: async (sessionId, text) => {
        await mkdir(handoffDir(), { recursive: true, mode: 0o700 })
        const path = join(handoffDir(), handoffFileName(`native:${sessionId}`))
        await writeFile(path, text, { mode: 0o600 })
        return path
      },
    })
    const modelsOf = async (engine: EngineName, provider: string, instance: string | undefined): Promise<readonly EngineModel[]> => {
      const settings = current()
      const info = await readInfo(settings, engine, instance, homedirOf(settings), false)
      const prefs = store.get('modelPrefs')
      return visibleRows(provider, engineCatalog(provider, info, prefs), prefs).map(row => ({
        id: row.id, name: row.name, efforts: row.efforts,
        ...row.efforts.some(level => level.id === DEFAULT_EFFORT) ? { defaultEffort: DEFAULT_EFFORT } : {},
      }))
    }
    const driverFor = (engine: EngineName, provider: string, instance: string | undefined) => engine === 'codex'
      ? codexDriver({ route: routeOf(provider), engine: () => codexFor(instance), listModels: () => modelsOf('codex', provider, instance), home: () => homedirOf(current()) })
      : claudeDriver({
        route: routeOf(provider),
        query: claudeQuery,
        options: ({ thread, cwd, text, model, effort }) => baseOptions(turnOptions(current(), thread, text, cwd, '', { model, ...effort === undefined ? {} : { effort }, ...claudeExtras(instance) })),
        listModels: () => modelsOf('claude', provider, instance),
      })
    const registered = new Map<string, () => void>()
    const syncRoutes = (): void => {
      const wanted = new Map<string, { engine: EngineName; instance: string | undefined }>([['claude', { engine: 'claude', instance: undefined }], ['codex', { engine: 'codex', instance: undefined }]])
      for (const item of store.get('instances')) wanted.set(item.id, { engine: item.engine, instance: item.id })
      for (const [provider, dispose] of registered) {
        if (!wanted.has(provider)) { dispose(); registered.delete(provider) }
      }
      for (const [provider, { engine, instance }] of wanted) {
        if (registered.has(provider)) continue
        const driver = driverFor(engine, provider, instance)
        registered.set(provider, native.effect(() => services.llm.registerAdapter([driver.route], host.adapterFor(driver)), `agent-bridge: ${provider} provider`) as unknown as () => void)
      }
    }
    syncRoutes()
    syncNativeRoutes = syncRoutes
    nativeHost = host
    native.effect(() => () => { syncNativeRoutes = () => {}; nativeHost = undefined }, 'agent-bridge: provider routes')
    native.effect(() => services.tools.register({
      name: ENGINE_TOOL,
      description: 'Internal record of a tool call that another coding engine already made. Never call this tool.',
      parameters: { type: 'object', properties: { tool: { type: 'string' }, input: {} }, required: ['tool'] },
      output: {
        schema: { type: 'object', properties: { output: { type: 'string' }, is_error: { type: 'boolean' } }, required: ['output', 'is_error'] },
        render: (_args: unknown, value: { output: string; is_error: boolean }) => [{ type: 'text', text: value.is_error ? `Error: ${value.output}` : value.output }],
      },
      execute: (args: unknown, exec: ProxyExecution) => host.executeProxy(args, exec),
    }), 'agent-bridge: engine tool proxy')
  })
  const dshHost = (): DshHostServices | undefined => {
    const host = { agents: ctx.get('agents' as never), agentPresets: ctx.get('agentPresets' as never), workspaceRegistry: ctx.get('workspaceRegistry' as never) } as unknown as DshHostServices
    return (host as Partial<DshHostServices>).agents === undefined ? undefined : host
  }
  const createImported = async (seed: readonly SeedEvent[], selection: { provider: string; model: string; reasoningEffort?: string }, cwd: string): Promise<string> => {
    const host = dshHost()
    if (host === undefined) throw new HttpError(501, 'this DSH build has no agent service')
    const presets = host.agentPresets
    const preset = presets === undefined ? undefined : await presets.resolve(undefined)
    const handle = await host.agents.create({
      sessionId: `session-${randomUUID()}`,
      seed,
      meta: { cwd, ...preset === undefined ? {} : { agentPreset: preset.id } },
      agentOptions: selection,
      ...presets === undefined || preset === undefined ? {} : { setup: async (agentCtx: Context) => { await presets.mount(agentCtx, preset.id) } },
    })
    const sessionId = handle.agent.id
    await host.workspaceRegistry?.list().find(workspace => workspace.path === cwd)?.attachSession(sessionId).catch((error: unknown) => { console.warn('agent-bridge: imported session is not in a workspace', error) })
    // An agent lives as long as its creator, and this plugin can reload at any time. The stored session is loaded by the DSH session controller on the next call.
    await handle.dispose()
    return sessionId
  }
  let mirrorRun: Promise<MirrorSyncWire> | undefined
  const mirrorChecked = new Map<string, number>()
  /** Import up to a few chats and find one new turn of each imported chat. */
  const syncMirrors = async (ready: Readonly<Record<string, string>>, settings: Settings): Promise<MirrorSyncWire> => {
    const created: { sessionId: string; title: string }[] = []
    const replays: { sessionId: string; user: string }[] = []
    const now = Date.now()
    if (store.get('mirrorSince') === 0) store.set('mirrorSince', now)
    const since = store.get('mirrorSince')
    const limit = Math.max(settings.sessionLimit, MIRROR_LIST_LIMIT)
    const instanceRows = (await Promise.all(store.get('instances').map(async (item) => {
      const listed = await (item.engine === 'codex' ? codexFor(item.id).listRows(limit) : listClaudeRows(limit, claudeHome(item.id))).catch(() => [])
      return listed.map(row => ({ ...row, id: withInstanceId(row.id, item.id) }))
    }))).flat()
    const codexRows = settings.codexEnabled ? await codex().listRows(limit).catch(() => []) : []
    const rows = [...await listClaudeRows(limit), ...codexRows, ...instanceRows].sort((a, b) => b.updatedAt - a.updatedAt)
    const owned = new Set(Object.values(store.get('engineThreads')))
    const hidden = new Set(hiddenThreadIds(store.get('links')))
    let imports = 0
    let more = false
    for (const row of rows) {
      const parsed = parseId(row.id)
      if (parsed === undefined || parsed.engine === 'pi' || hidden.has(row.id)) continue
      const driver = driverOf(parsed.engine, parsed.instance)
      const quiet = isQuiet(row.updatedAt, now) && !driver.isRunning(parsed.raw)
      const entry = store.get('mirrors')[row.id]
      if (entry === undefined) {
        const step = importStep({ quiet, updatedAt: row.updatedAt, since, lastChecked: mirrorChecked.get(row.id), owned: owned.has(parsed.raw), cwd: row.cwd, imports, isFolder: cwd => statSync(cwd, { throwIfNoEntry: false })?.isDirectory() === true })
        if (step === 'more') more = true
        if (step !== 'read') continue
        const file = await driver.findFile(parsed.raw)
        const used = file === undefined ? undefined : await lastUsedModel(parsed.engine, file)
        if (!hasTurnSince(used, since)) {
          mirrorChecked.set(row.id, row.updatedAt)
          continue
        }
        const info = await readInfo(settings, parsed.engine, parsed.instance, row.cwd, false).catch(() => undefined)
        const selection = importSelection(parsed.engine, parsed.instance, choiceFromUsed(used, info))
        const route = selection.provider
        const { messages } = await conversationMessages(parsed, true)
        const clean = withoutCatchup(messages)
        const seed = importEvents(clean, selection, now)
        if (seed.length === 0) {
          mirrorChecked.set(row.id, row.updatedAt)
          continue
        }
        imports += 1
        const sessionId = await createImported(seed, selection, row.cwd)
        store.set('engineThreads', { ...store.get('engineThreads'), [`${sessionId}|${route}`]: parsed.raw })
        store.set('mirrors', { ...store.get('mirrors'), [row.id]: { sessionId, route, synced: allTurns(clean).length, checkedAt: row.updatedAt } })
        created.push({ sessionId, title: cleanTitle(stripCatchup(row.title)) })
        continue
      }
      const key = `${entry.sessionId}|${entry.route}`
      if (nativeHost === undefined || !mirrorNeedsRead(entry, { updatedAt: row.updatedAt, quiet, active: nativeHost.isActive(key), currentRoute: ready[entry.sessionId] })) continue
      const turns = allTurns(withoutCatchup((await conversationMessages(parsed, true)).messages))
      const plan = planMirror(entry, turns, quiet, row.updatedAt)
      if (plan.replay !== undefined) nativeHost.armReplay(key, { user: plan.replay.user, assistant: plan.replay.assistant })
      if (plan.entry !== undefined) store.set('mirrors', { ...store.get('mirrors'), [row.id]: plan.entry })
      if (plan.replay !== undefined) replays.push({ sessionId: entry.sessionId, user: plan.replay.user })
      more = more || plan.more
    }
    return { created, replays, more }
  }
  route(MIRROR_PATH, async (request, settings) => {
    const body = await request.json() as { ready?: Record<string, string> }
    mirrorRun ??= syncMirrors(body.ready ?? {}, settings).finally(() => { mirrorRun = undefined })
    return json(await mirrorRun)
  }, 'mirror', 'POST')
  route(DSH_IMPORT_PATH, async (request) => {
    const body = await request.json() as DshImportBodyWire
    const parsed = parseId(body.id)
    if (parsed === undefined) return json({ error: 'unknown session' }, 404)
    if (dshHost() === undefined) return json({ error: 'this DSH build has no agent service' }, 501)
    const { messages } = await conversationMessages(parsed)
    const selection = { provider: body.provider, model: body.model, ...body.effort === undefined || body.effort === '' ? {} : { reasoningEffort: body.effort } }
    const seed = importEvents(withoutCatchup(messages), selection, Date.now())
    if (seed.length === 0) return json({ error: 'this conversation has no text to import' }, 422)
    return json({ sessionId: await createImported(seed, selection, body.cwd) })
  }, 'dsh import', 'POST')
  route(CATCHUP_PATH, async (request) => {
    const parsed = idOf(request)
    if (parsed === undefined) return json({ error: 'unknown session' }, 404)
    const { messages, partial } = await conversationMessages(parsed)
    const first = linkOf(store.get('links'), prefixed(parsed.engine, parsed.raw, parsed.instance))?.segments?.[0]?.thread
    return json({ catchup: readableCatchup(renderCatchup(first === undefined ? parsed.engine : parseId(first)?.engine ?? parsed.engine, messages, partial)) })
  }, 'catchup')
  route(SESSION_PATH, async (request) => {
    const parsed = idOf(request)
    if (parsed === undefined) return json({ error: 'unknown session' }, 404)
    const driver = driverOf(parsed.engine, parsed.instance)
    return json(await sessionReads.run(`${parsed.engine}:${parsed.raw}`, async () => {
      const goal = await driver.readGoal(parsed.raw)
      const usage = parsed.engine === 'claude' ? await readClaudeUsage(parsed.raw, claudeHome(parsed.instance)) : parsed.engine === 'pi' ? await readPiUsage(parsed.raw) : undefined
      const page = await driver.readMessages(parsed.raw)
      const used = await driver.findFile(parsed.raw).then(file => file === undefined ? undefined : lastUsedModel(parsed.engine, file)).catch((error: unknown) => {
        console.warn('agent-bridge: last model of the session is unknown', error)
        return undefined
      })
      const sessionId = prefixed(parsed.engine, parsed.raw, parsed.instance)
      const link = linkOf(store.get('links'), sessionId)
      const messages = link === undefined ? page.messages : mergeLinkedMessages(link, sessionId, await linkedThreads(link, sessionId, page.messages))
      return { messages: withoutCatchup(messages), ...used === undefined ? {} : { used }, ...page.recentTurns === undefined ? {} : { recentTurns: page.recentTurns }, ...goal === undefined ? {} : { goal }, ...usage === undefined ? {} : { usage } }
    }))
  }, 'session')
  route(WATCH_PATH, (request, settings) => watchResponse(request, settings.watchIntervalMs, driverOf), 'watch')
  route(LIVE_PATH, request => liveResponse(request, driverOf), 'live')
  const sendMessage = async (body: SendBodyWire, settings: Settings): Promise<{ id: string }> => {
    const parsed = body.id === undefined ? undefined : parseId(body.id)
    const engine = parsed?.engine ?? body.engine ?? 'claude'
    const instance = parsed === undefined ? body.instance : parsed.instance
    if (instance !== undefined && requireInstance(instance).engine !== engine) throw new HttpError(400, 'the provider instance belongs to another engine')
    // A resumed session runs in its own folder; the browser sends it, and a caller that does not is looked up.
    const claudeRows = async (limit: number): Promise<SessionRowWire[]> => (await listClaudeRows(limit, claudeHome(instance))).map(row => instance === undefined ? row : { ...row, id: withInstanceId(row.id, instance) })
    const rowsOf = parsed?.engine === 'claude' ? claudeRows : parsed?.engine === 'pi' ? listPiRows : undefined
    const knownCwd = body.cwd ?? (await rowsOf?.(Math.max(settings.sessionLimit, 1000)))?.find(row => row.id === body.id)?.cwd
    const cwd = knownCwd === undefined || knownCwd === '' ? homedirOf(settings) : knownCwd
    // The engines report a missing folder as a missing executable; say what is actually wrong.
    if (statSync(cwd, { throwIfNoEntry: false })?.isDirectory() !== true) throw new HttpError(400, `the working directory no longer exists: ${cwd}`)
    let preset
    try {
      preset = parsePreset(body.permission)
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error))
    }
    const attached = await prepareAttachments(body.attachments)
    const text = `${body.text}${attached.note}`
    const clearDraft = (): void => { store.set('drafts', Object.fromEntries(Object.entries(store.get('drafts')).filter(([key]) => key !== (body.id ?? '')))) }
    if (engine === 'codex') {
      if (!settings.codexEnabled) throw new HttpError(404, 'codex is disabled')
      const id = await codexFor(instance).start({
        ...parsed === undefined ? {} : { threadId: parsed.raw },
        cwd, text, ...codexPermission(preset, { approvalPolicy: settings.codexApprovalPolicy, sandbox: settings.codexSandbox }),
        ...body.model === undefined ? {} : { model: body.model }, ...body.effort === undefined ? {} : { effort: body.effort },
        ...body.speed === undefined ? {} : { speed: body.speed },
        images: attached.imagePaths,
      })
      clearDraft()
      return { id: prefixed('codex', id, instance) }
    }
    if (engine === 'pi') {
      if (!settings.piEnabled) throw new HttpError(404, 'pi is disabled')
      const id = await pi().start({
        ...parsed === undefined ? {} : { sessionId: parsed.raw },
        cwd, text,
        ...body.model === undefined ? {} : { model: body.model }, ...body.effort === undefined ? {} : { effort: body.effort },
        images: attached.images,
      })
      clearDraft()
      return { id: prefixed('pi', id) }
    }
    const memory = settings.memoryFile === '' ? '' : await readFile(settings.memoryFile, 'utf8')
    const id = await runs.start(turnOptions({ ...settings, permissionMode: claudePermission(preset, settings.permissionMode) as Settings['permissionMode'] }, parsed?.raw, text, cwd, memory, {
      ...body.model === undefined ? {} : { model: body.model }, ...body.effort === undefined ? {} : { effort: body.effort }, ...body.speed === undefined ? {} : { speed: body.speed }, images: attached.images, ...claudeExtras(instance),
    }))
    clearDraft()
    return { id: prefixed('claude', id, instance) }
  }
  // One switch per source thread at a time: a second one would create a second thread for the other provider.
  const switching = new Set<string>()
  /** A provider reads the file itself; if the file cannot be written, the text goes in the message. */
  const writeHandoff = async (source: EngineId, sourceId: string, plan: { readonly catchup: string; readonly unseen: number }): Promise<string> => {
    try {
      const { messages, partial } = await conversationMessages(source)
      const first = linkOf(store.get('links'), sourceId)?.segments?.[0]?.thread
      const handoff = renderHandoff(first === undefined ? source.engine : parseId(first)?.engine ?? source.engine, messages, partial)
      await mkdir(handoffDir(), { recursive: true, mode: 0o700 })
      const path = join(handoffDir(), handoffFileName(sourceId))
      await writeFile(path, handoff.text, { mode: 0o600 })
      return handoffNote(source.engine, path, handoff, plan.unseen)
    } catch (error) {
      console.warn('agent-bridge: conversation file failed, sending the text instead', error)
      return plan.catchup
    }
  }
  const sendSwitched = async (body: SendBodyWire, sourceId: string, settings: Settings): Promise<{ id: string }> => {
    const source = parseId(sourceId)
    const target = body.engine
    if (source === undefined || target === undefined || body.cwd === undefined || body.cwd === '') throw new HttpError(400, 'a switch needs a source session, an engine and a working directory')
    if (switching.has(sourceId) || driverOf(source.engine, source.instance).isRunning(source.raw)) throw new HttpError(409, 'a turn is running in this session')
    switching.add(sourceId)
    try {
      const { messages } = await driverOf(source.engine, source.instance).readMessages(source.raw)
      let plan
      try {
        plan = planSwitch(store.get('links'), sourceId, providerId(target, body.instance), messages)
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error))
      }
      const note = plan.unseen === 0 && !plan.gap ? '' : await writeHandoff(source, sourceId, plan)
      const sent = await sendMessage({ ...body, ...plan.targetId === undefined ? {} : { id: plan.targetId }, text: composeSwitchPrompt(body.text, note) }, settings)
      // A slash command carries no catch-up, so the next message still has to.
      store.set('links', recordSwitch(store.get('links'), sourceId, sent.id, isCommand(body.text) ? undefined : plan.deliveredThrough, plan.deliveredThrough))
      return sent
    } finally {
      switching.delete(sourceId)
    }
  }
  route(SEND_PATH, async (request, settings) => {
    const body = await request.json() as SendBodyWire
    return json(await (body.switchFrom === undefined ? sendMessage(body, settings) : sendSwitched(body, body.switchFrom, settings)))
  }, 'send', 'POST')
  const scheduler = new Scheduler(
    store,
    async (message) => {
      await sendMessage({ id: message.sessionId, cwd: message.cwd, text: message.text, ...message.model === undefined ? {} : { model: message.model }, ...message.effort === undefined ? {} : { effort: message.effort } }, current())
    },
    (sessionId) => { const parsed = parseId(sessionId); return parsed !== undefined && driverOf(parsed.engine, parsed.instance).isRunning(parsed.raw) },
  )
  scheduler.start()
  ctx.effect(() => () => { scheduler.stop() }, 'agent-bridge: scheduler')
  route(SCHEDULE_PATH, async (request) => {
    if (request.method === 'GET') {
      const id = query(request, 'id')
      return json({ messages: scheduler.list(id).map(({ id: messageId, sessionId, text, at, status, error }) => ({ id: messageId, sessionId, text, at, status, ...error === undefined ? {} : { error } })) })
    }
    const body = await request.json() as ScheduleBodyWire
    if (body.action === 'cancel') return json({ ok: scheduler.cancel(body.id) })
    if (parseId(body.sessionId) === undefined) throw new HttpError(404, 'unknown session')
    const created = scheduler.add({ sessionId: body.sessionId, cwd: body.cwd, text: body.text, at: body.at, ...body.model === undefined ? {} : { model: body.model }, ...body.effort === undefined ? {} : { effort: body.effort } })
    return json({ id: created.id })
  }, 'schedule', 'BOTH')
  route(ANSWER_PATH, async (request) => {
    const body = await request.json() as AnswerBodyWire
    const parsed = parseId(body.id)
    const found = parsed !== undefined && driverOf(parsed.engine, parsed.instance).answer(parsed.raw, body.requestId, body)
    return json({ ok: found }, found ? 200 : 404)
  }, 'answer', 'POST')
  route(MANAGE_PATH, async (request) => {
    const body = await request.json() as ManageBodyWire
    const parsed = parseId(body.id)
    if (parsed === undefined) return json({ error: 'unknown session' }, 404)
    const driver = driverOf(parsed.engine, parsed.instance)
    // Claude and Codex can fork a running session; Pi cannot.
    if (driver.isRunning(parsed.raw) && (body.action !== 'fork' || parsed.engine === 'pi')) return json({ error: 'a turn is running in this session' }, 409)
    switch (body.action) {
      case 'fork': {
        const forked = await forkConversation(body.id, body.title)
        if (parseId(forked)?.engine === 'codex') store.set('unlistedForks', [...store.get('unlistedForks'), { id: forked, title: body.title ?? '', cwd: body.cwd ?? '', updatedAt: Date.now() }])
        return json({ id: forked })
      }
      case 'rename':
        await driver.rename(parsed.raw, body.title ?? '')
        store.set('unlistedForks', store.get('unlistedForks').map(fork => fork.id === body.id ? { ...fork, title: body.title ?? '' } : fork))
        return json({ ok: true })
      case 'delete':
        await driver.delete(parsed.raw)
        store.set('links', removeThread(store.get('links'), body.id))
        await rm(join(handoffDir(), handoffFileName(body.id)), { force: true })
        store.set('unlistedForks', store.get('unlistedForks').filter(fork => fork.id !== body.id))
        store.set('seen', Object.fromEntries(Object.entries(store.get('seen')).filter(([id]) => id !== body.id)))
        return json({ ok: true })
    }
  }, 'manage', 'POST')
  route(SCREEN_STATUS_PATH, async (_request, settings) => {
    const { stdout } = await promisify(execFile)(settings.peekabooCommand, ['permissions', 'status', '--no-remote'], { timeout: 20_000 })
    const lines = stdout.split('\n').map(line => line.trim()).filter(line => /(Granted|Denied|Not)/i.test(line))
    if (!settings.computerUse) return json({ lines, tools: [], server: 'disabled' })
    const probe = await probeTools(turnOptions(settings, undefined, '', homedirOf(settings)))
    const tools = probe.tools.filter(tool => tool.startsWith(`mcp__${SCREEN_SERVER}__`)).map(tool => tool.slice(`mcp__${SCREEN_SERVER}__`.length))
    return json({ lines, tools, server: probe.mcpServers.find(server => server.name === SCREEN_SERVER)?.status ?? 'missing' })
  }, 'screen status')
  route(INTERRUPT_PATH, async (request) => {
    const body = await request.json() as { id: string }
    const parsed = parseId(body.id)
    const found = parsed !== undefined && await driverOf(parsed.engine, parsed.instance).interrupt(parsed.raw)
    return json({ ok: found }, found ? 200 : 404)
  }, 'interrupt', 'POST')
  const query = (request: Request, key: string): string => new URL(request.url).searchParams.get(key) ?? ''
  route(TERM_OPEN_PATH, async (request) => {
    const body = await request.json() as { cwd: string; cols?: number; rows?: number }
    return json({ tid: terminals.open(body.cwd, body.cols ?? 80, body.rows ?? 24) })
  }, 'terminal open', 'POST')
  route(TERM_STREAM_PATH, (request) => {
    const tid = query(request, 'tid')
    const encoder = new TextEncoder()
    let release: (() => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        release = terminals.subscribe(tid, (event: TermEventWire) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        })
        request.signal.addEventListener('abort', () => release?.(), { once: true })
      },
      cancel: () => release?.(),
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } })
  }, 'terminal stream')
  route(TERM_INPUT_PATH, async (request) => {
    const body = await request.json() as { tid: string; data: string }
    terminals.input(body.tid, body.data)
    return json({ ok: true })
  }, 'terminal input', 'POST')
  route(TERM_RESIZE_PATH, async (request) => {
    const body = await request.json() as { tid: string; cols: number; rows: number }
    terminals.resize(body.tid, body.cols, body.rows)
    return json({ ok: true })
  }, 'terminal resize', 'POST')
  route(TERM_CLOSE_PATH, async (request) => {
    terminals.close(((await request.json()) as { tid: string }).tid)
    return json({ ok: true })
  }, 'terminal close', 'POST')
  route(FS_LIST_PATH, async request => json({ entries: await listDir(query(request, 'cwd'), query(request, 'path')) }), 'fs list')
  route(FS_READ_PATH, async request => json(await readText(query(request, 'cwd'), query(request, 'path'))), 'fs read')
  route(FS_WRITE_PATH, async (request) => {
    const body = await request.json() as { cwd: string; path: string; content: string; baseMtimeMs?: number }
    return json(await writeText(body.cwd, body.path, body.content, body.baseMtimeMs))
  }, 'fs write', 'POST')
  route(FS_ACTION_PATH, async request => json(await fsAction(await request.json() as FsActionWire)), 'fs action', 'POST')
  route(FS_IMAGE_PATH, async request => json(await readImage(query(request, 'cwd'), query(request, 'path'))), 'fs image')
  route(FS_BROWSE_PATH, async request => json(await browseDirs(query(request, 'path'))), 'fs browse')
  route(GIT_STATUS_PATH, async request => json(await gitStatus(query(request, 'cwd'))), 'git status')
  route(GIT_DIFF_PATH, async request => json({
    diff: await gitDiff(query(request, 'cwd'), query(request, 'path'), query(request, 'staged') === '1', query(request, 'untracked') === '1'),
  }), 'git diff')
  route(GIT_LOG_PATH, async request => json({ commits: await gitLog(query(request, 'cwd')) }), 'git log')
  route(GIT_BRANCHES_PATH, async request => json(await gitBranches(query(request, 'cwd'))), 'git branches')
  route(GIT_REMOTE_PATH, async request => json(await gitRemote(query(request, 'cwd'))), 'git remote')
  route(GIT_SHOW_PATH, async request => json(await gitShow(query(request, 'cwd'), query(request, 'hash'))), 'git show')
  route(GIT_COMPARE_PATH, async request => json(await gitCompare(query(request, 'cwd'), query(request, 'base'), query(request, 'head'))), 'git compare')
  route(GIT_MESSAGE_PATH, async (request, settings) => json({ message: await gitDraftMessage(query(request, 'cwd'), settings.claudeExecutable) }), 'git message')
  route(GIT_ACTION_PATH, async request => json(await gitAction(await request.json() as GitActionWire)), 'git action', 'POST')
  const infoCache = new Map<string, { at: number; info: InfoWire }>()
  const infoLoads = new Map<string, Promise<InfoWire>>()
  const readInfo = async (settings: Settings, engine: EngineName, instance: string | undefined, asked: string, fresh: boolean): Promise<InfoWire> => {
    // A project folder that was deleted or moved must not break the lists: fall back to the home directory.
    const cwd = statSync(asked, { throwIfNoEntry: false })?.isDirectory() === true ? asked : homedir()
    const key = `${infoCachePrefix(engine, instance)}${cwd}`
    // Only the newest load of a key writes the cache; a forced load or an MCP change supersedes the running one.
    const load = (force: boolean): Promise<InfoWire> => {
      const running = infoLoads.get(key)
      if (running !== undefined && !force) return running
      const asking = (): Promise<InfoWire> => {
        if (engine === 'pi') return pi().readInfo(cwd)
        const codexEngine = (): CodexEngine => codexFor(instance)
        if (engine === 'codex') return codexEngine().listModels().then(async models => ({ models, commands: [], mcp: [], account: await codexEngine().readAccount(), defaults: await codexEngine().readDefaults(models) }))
        return probeInfo(turnOptions(settings, undefined, '', cwd, '', claudeExtras(instance)))
      }
      const started: Promise<InfoWire> = asking()
        .then((info) => { if (infoLoads.get(key) === started) infoCache.set(key, { at: Date.now(), info }); return info })
        .finally(() => { if (infoLoads.get(key) === started) infoLoads.delete(key) })
      infoLoads.set(key, started)
      return started
    }
    const cached = infoCache.get(key)
    if (cached === undefined || fresh) return await load(fresh)
    // Asking the engine takes seconds (Claude starts a process), so an old answer is served while a newer one loads.
    if (Date.now() - cached.at >= 20_000) load(false).catch(() => { /* the old answer stays until a load succeeds */ })
    return cached.info
  }
  route(INFO_PATH, async (request, settings) => {
    const engine = infoEngine(query(request, 'engine'))
    const asked = query(request, 'cwd') || homedirOf(settings)
    return json(await readInfo(settings, engine, query(request, 'instance') || undefined, asked, query(request, 'fresh') === '1'))
  }, 'info')
  const logins = new LoginFlows()
  ctx.effect(() => () => { logins.closeAll() }, 'agent-bridge: sign-in commands')
  /** @param provider - the engine and instance of a request. @returns how to ask that engine about its sign-in, and the key of its attempt. */
  const loginOf = (settings: Settings, wanted: string, instance: string | undefined): { key: string; login: EngineLogin } => {
    const target = loginTarget(wanted, instance, { claudeExecutable: settings.claudeExecutable, codexExecutable: settings.codexExecutable, findInstance: requireInstance })
    if (target === undefined) throw new HttpError(400, 'this provider has no sign-in command')
    return target
  }
  route(LOGIN_PATH, async (request, settings) => {
    if (request.method === 'POST') {
      const body = await request.json() as LoginBodyWire
      const { key, login } = loginOf(settings, body.engine, body.instance)
      if (body.action === 'cancel') {
        logins.cancel(key)
        return json(await readLoginStatus(login))
      }
      return json({ flow: logins.start(key, login, () => { dropCachedInfo(infoCache, body.engine, body.instance) }) } satisfies LoginWire)
    }
    const { key, login } = loginOf(settings, query(request, 'engine'), query(request, 'instance') || undefined)
    return json(await pollLogin(logins, key, login) satisfies LoginWire)
  }, 'login', 'BOTH')
  route(ABOUT_PATH, async (_request, settings) => json(await readAbout(settings)), 'about')
  route(SEARCH_PATH, async (request, settings) => {
    const term = query(request, 'q').trim()
    if (term.length < 2) return json({ hits: [] })
    const archived = new Set(store.get('archived'))
    const claudeRows = (await listClaudeRows(settings.sessionLimit)).filter(row => !archived.has(row.id))
    const hits = await searchClaude(claudeRows, term, 30)
    if (settings.codexEnabled) {
      for (const row of await codex().search(term, 20).catch(() => [])) {
        if (!archived.has(row.id)) hits.push({ id: row.id, title: row.title, snippet: '', cwd: row.cwd })
      }
    }
    if (settings.piEnabled) {
      const piRows = (await listPiRows(settings.sessionLimit)).filter(row => !archived.has(row.id))
      hits.push(...await searchPi(piRows, term, 30))
    }
    return json({ hits })
  }, 'search')
  route(DRAFT_PATH, async (request) => {
    if (request.method === 'GET') return json({ text: store.get('drafts')[query(request, 'id')] ?? '' })
    const body = await request.json() as { id: string; text: string }
    const drafts = { ...store.get('drafts') }
    if (body.text === '') delete drafts[body.id]
    else drafts[body.id] = body.text.slice(0, 100_000)
    store.set('drafts', drafts)
    return json({ ok: true })
  }, 'draft', 'BOTH')
  route(INSTANCES_PATH, async (request) => {
    if (request.method === 'GET') return json({ instances: store.get('instances') })
    const body = await request.json() as InstanceBodyWire
    if (body.action === 'remove') {
      store.set('instances', store.get('instances').filter(item => item.id !== body.id))
      syncNativeRoutes()
      instanceDrivers.delete(body.id)
      void codexEngines.get(body.id)?.closeAll()
      codexEngines.delete(body.id)
      syncClaudeSerialization()
      return json({ instances: store.get('instances') })
    }
    const parsed = parseInstance(body.instance, store.get('instances'))
    if ('error' in parsed) return json({ error: parsed.error }, 400)
    // Codex does not start, and cannot sign in, when CODEX_HOME names a missing folder.
    try {
      await mkdir(expandHome(parsed.instance.home), { recursive: true })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
    store.set('instances', [...store.get('instances'), parsed.instance])
    syncNativeRoutes()
    syncClaudeSerialization()
    return json({ instances: store.get('instances') })
  }, 'instances', 'BOTH')
  route(MODEL_PREFS_PATH, async (request) => {
    if (request.method === 'GET') return json(store.get('modelPrefs'))
    const prefs = parseModelPrefs(await request.json())
    if (prefs === undefined) return json({ error: 'invalid model preferences' }, 400)
    store.set('modelPrefs', prefs)
    return json({ ok: true })
  }, 'model preferences', 'BOTH')
  route(CHOICE_PATH, async (request) => {
    if (request.method === 'GET') return json(store.get('choices')[query(request, 'engine')] ?? { model: '', effort: '' })
    const body = await request.json() as { engine: unknown } & Record<keyof ChoiceWire, unknown>
    if (typeof body.engine !== 'string' || !/^(claude|codex|pi)(@[A-Za-z0-9_-]+)?$/.test(body.engine) || typeof body.model !== 'string' || typeof body.effort !== 'string' || body.model.length > 200 || body.effort.length > 50 || (body.speed !== undefined && (typeof body.speed !== 'string' || body.speed.length > 50))) {
      return json({ error: 'invalid choice' }, 400)
    }
    let permission
    try {
      permission = parsePreset(body.permission)
    } catch {
      // The reason is the one this answer already gives.
      return json({ error: 'invalid choice' }, 400)
    }
    store.set('choices', { ...store.get('choices'), [body.engine]: { model: body.model, effort: body.effort, ...permission === undefined ? {} : { permission }, ...typeof body.speed === 'string' ? { speed: body.speed } : {} } })
    return json({ ok: true })
  }, 'choice', 'BOTH')
  route(ARCHIVE_PATH, async (request) => {
    const body = await request.json() as { id: string; archived: boolean }
    if (parseId(body.id) === undefined) return json({ error: 'unknown session' }, 404)
    const set = new Set(store.get('archived'))
    if (body.archived) set.add(body.id)
    else set.delete(body.id)
    store.set('archived', [...set])
    return json({ ok: true })
  }, 'archive', 'POST')
  route(PIN_PATH, async (request) => {
    const body = await request.json() as { id: string; pinned: boolean }
    if (parseId(body.id) === undefined) return json({ error: 'unknown session' }, 404)
    const set = new Set(store.get('pinned'))
    if (body.pinned) set.add(body.id)
    else set.delete(body.id)
    store.set('pinned', [...set])
    return json({ ok: true })
  }, 'pin', 'POST')
  route(SKILLS_PATH, async (request) => {
    if (request.method === 'GET') return json({ skills: await listSkills(query(request, 'cwd')) })
    return json(await changeSkill(await request.json() as SkillBodyWire))
  }, 'skills', 'BOTH')
  route(MCP_PATH, async (request, settings) => {
    const result = await mcpChange(settings.claudeExecutable, await request.json() as McpBodyWire)
    infoCache.clear()
    infoLoads.clear()
    return json(result)
  }, 'mcp change', 'POST')
  route(GIT_CONFIG_PATH, async (request) => {
    if (request.method === 'GET') return json(await readGitConfig())
    const body = await request.json() as { name: string; email: string }
    return json(await writeGitConfig(body.name, body.email))
  }, 'git config', 'BOTH')
  route(GIT_WORKTREES_PATH, async (request) => {
    if (request.method === 'GET') return json({ worktrees: await gitWorktrees(query(request, 'cwd')) })
    return json(await gitWorktreeAction(await request.json() as WorktreeBodyWire))
  }, 'worktrees', 'BOTH')
  route(CLONE_PATH, async (request) => {
    const body = await request.json() as { url: string; parent: string; name: string }
    return json(await gitClone(body.url, body.parent, body.name))
  }, 'clone', 'POST')
  route(TASKS_PATH, async (request, settings) => {
    if (request.method === 'GET') return json(await readTasks(query(request, 'cwd'), query(request, 'tag') || undefined))
    return json(await tasksAction(await request.json() as TasksBodyWire, settings.taskmasterCommand))
  }, 'tasks', 'BOTH')
  route(VOICE_PATH, async (request, settings) => {
    if (request.method === 'GET') return json({ enabled: settings.voiceBaseUrl.trim() !== '' })
    return json(await voiceAction(await request.json() as VoiceBodyWire, {
      baseUrl: settings.voiceBaseUrl, apiKeyEnv: settings.voiceApiKeyEnv, sttModel: settings.voiceSttModel, ttsModel: settings.voiceTtsModel, ttsVoice: settings.voiceTtsVoice,
    }))
  }, 'voice', 'BOTH')
}
