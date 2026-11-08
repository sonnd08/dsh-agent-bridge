/**
 * Browser-side owner of one external session's transcript, change feed, and live turn.
 * Lives in the apply world so the panel component only reads a snapshot. The transcript file is the
 * source of truth: live events only trigger refetches and show what has not been written yet.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ANSWER_PATH, ARCHIVE_PATH, INTERRUPT_PATH, LIVE_PATH, MANAGE_PATH, engineOfSession, instanceOfSession, isDraftId, SEND_PATH, SESSION_PATH, WATCH_PATH,
  type AnswerBodyWire, type GoalWire, type LiveEventWire, type ManageBodyWire, type MessageWire, type PermissionWire, type SendBodyWire, type SessionWire, type UsageWire, type UsedModelWire, type AttachmentWire, type EngineName, type PermissionPreset,
} from '../protocol.ts'

/** Transcript and live-turn state the panel renders. */
export interface TranscriptState {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed'
  readonly sessionId?: string
  readonly messages: readonly MessageWire[]
  /** True once the session file changed elsewhere after the transcript was loaded. */
  readonly staleElsewhere: boolean
  /** True while a turn started from this browser or another is running. */
  readonly running: boolean
  /** Assistant text streamed so far and not yet in the file. */
  readonly partial: string
  /** Prompt just sent and not yet in the file. */
  readonly pendingUser?: string | undefined
  /** When this browser sent the running turn, in epoch milliseconds; unknown for a turn started elsewhere. */
  readonly startedAt?: number | undefined
  readonly permissions: readonly PermissionWire[]
  /** Active /goal read from the transcript file. */
  readonly goal?: GoalWire | undefined
  /** Token totals of the session, when the engine records them. */
  readonly usage?: UsageWire | undefined
  readonly used?: UsedModelWire | undefined
  /** Number of recent turns shown when older ones were left out. */
  readonly recentTurns?: number | undefined
  readonly error?: string | undefined
}

/** Observable session owner. */
export interface TranscriptController extends HostObservable<TranscriptState> {
  /**
   * Show a session (or the new-session draft) and follow it.
   * @param sessionId - external session id, or the draft id.
   */
  open(sessionId: string): void
  /** Reload the open session and clear the stale flag. */
  reload(): void
  /** Close every feed and return to idle. */
  close(): void
  /**
   * Send a user message; creates the session when the draft is open.
   * @param text - the message.
   * @param cwd - working directory for a new session.
   * @param extras - model, effort and attachments of this turn.
   */
  send(text: string, cwd: string, extras?: SendExtras): Promise<void>
  /** Move the open session out of the list (it can be restored from the settings card). */
  archive(): Promise<void>
  /**
   * Answer a pending permission request or question.
   * @param requestId - request id.
   * @param behavior - allow or deny.
   * @param answers - AskUserQuestion answers keyed by question text.
   * @param remember - keep the approval for the rest of the session (Codex).
   */
  answer(requestId: string, behavior: 'allow' | 'deny', answers?: Record<string, string>, remember?: boolean): Promise<void>
  /** Interrupt the running turn. */
  interrupt(): Promise<void>
  /**
   * Show an error in the open session.
   * @param message - the error text.
   */
  fail(message: string): void
  /**
   * Fork a session with the engine of that session, and open the fork.
   * @param id - session to fork; it does not have to be the open session.
   * @param title - title of the fork.
   * @param cwd - folder of the session.
   * @returns the id of the fork, or undefined if the fork failed.
   */
  fork(id: string, title: string, cwd: string): Promise<string | undefined>
  /**
   * Rename or delete the open session.
   * @param action - the operation.
   * @param title - new title for `rename`.
   */
  manage(action: Exclude<ManageBodyWire['action'], 'fork'>, title?: string): Promise<void>
}

/** Per-turn choices that ride along with a message. */
export interface SendExtras {
  readonly model?: string
  readonly effort?: string
  readonly permission?: PermissionPreset
  readonly speed?: string
  readonly attachments?: readonly AttachmentWire[]
  /** The other provider to send to; with `switchFrom`, the conversation moves there. */
  readonly engine?: EngineName
  readonly instance?: string
  /** The open session, when the message moves the conversation to `engine`. */
  readonly switchFrom?: string
}

/** Callbacks into the plugin entry. */
export interface TranscriptHooks {
  /** A send on the draft created this session. */
  onCreated(id: string, cwd: string, prompt: string): void
  /** A send moved the conversation to the other provider's thread. */
  onSwitched(fromId: string, id: string, cwd: string, prompt: string): void
  /** A turn ended or the stored sessions changed; the session list should be refreshed. */
  onTurnEnded(): void
  /** A turn was accepted by the host; the list should show it as running. */
  onTurnStarted(): void
  /** The open session was deleted. */
  onDeleted(id: string): void
  /** The open session was renamed. */
  onRenamed(id: string, title: string): void
}

/** @param id - external session id. @returns whether it is a new-session draft. */
export function isDraft(id: string | undefined): boolean {
  return isDraftId(id)
}

const IDLE: TranscriptState = Object.freeze({
  status: 'idle', messages: [], staleElsewhere: false, running: false, partial: '', permissions: [],
})

async function post(path: string, body: unknown): Promise<Response> {
  return await fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

/**
 * Create a session owner.
 * @param hooks - callbacks into the plugin entry.
 * @returns the controller.
 */
export function createTranscriptController(hooks: TranscriptHooks): TranscriptController {
  let state: TranscriptState = IDLE
  let watch: EventSource | undefined
  let live: EventSource | undefined
  let generation = 0
  let pendingBase = 0
  const listeners = new Set<() => void>()
  const publish = (next: TranscriptState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }
  const patch = (changes: Partial<TranscriptState>): void => { publish({ ...state, ...changes }) }
  const query = (id: string): string => `?id=${encodeURIComponent(id)}`
  const closeFeeds = (): void => {
    watch?.close()
    live?.close()
    watch = undefined
    live = undefined
  }

  const fetchMessages = async (id: string, mine: number): Promise<boolean> => {
    const response = await fetch(`${SESSION_PATH}${query(id)}`, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as SessionWire
    if (mine !== generation) return false
    const written = body.messages.length > pendingBase
    patch({ status: 'ready', messages: body.messages, goal: body.goal, usage: body.usage, used: body.used, recentTurns: body.recentTurns, ...written ? { pendingUser: undefined } : {} })
    return true
  }
  // At most one transcript request runs; refreshes asked for meanwhile collapse into one more request after it.
  let refreshing: { mine: number; again: boolean; done: Promise<boolean> } | undefined
  const refresh = (id: string, mine: number): Promise<boolean> => {
    if (refreshing?.mine === mine) {
      refreshing.again = true
      return refreshing.done
    }
    const current = { mine, again: false, done: Promise.resolve(false) }
    current.done = (async () => {
      try {
        let ok: boolean
        do {
          current.again = false
          ok = await fetchMessages(id, mine)
        } while (current.again && mine === generation)
        return ok
      } finally {
        if (refreshing === current) refreshing = undefined
      }
    })()
    refreshing = current
    return current.done
  }
  const startWatch = (id: string, mine: number): void => {
    watch?.close()
    const opened = new EventSource(`${WATCH_PATH}${query(id)}`)
    watch = opened
    opened.onmessage = () => {
      if (mine === generation && !state.running) patch({ staleElsewhere: true })
    }
  }
  const settle = async (id: string, mine: number): Promise<void> => {
    try {
      if (await refresh(id, mine)) startWatch(id, mine)
    } catch (error) {
      console.warn('agent-bridge: transcript load failed', error)
    }
  }
  const startLive = (id: string, mine: number): void => {
    live?.close()
    const opened = new EventSource(`${LIVE_PATH}${query(id)}`)
    live = opened
    opened.onmessage = (message: MessageEvent<string>) => {
      if (mine !== generation) return
      const event = JSON.parse(message.data) as LiveEventWire
      switch (event.kind) {
        case 'idle':
          if (state.running) {
            patch({ running: false, partial: '', pendingUser: undefined, startedAt: undefined, permissions: [] })
            hooks.onTurnEnded()
            void settle(id, mine)
          }
          break
        case 'delta':
          patch({ running: true, partial: state.partial + event.text })
          break
        case 'message':
          patch({ running: true, partial: '' })
          void refresh(id, mine).catch(() => {})
          break
        case 'permission':
          patch({ running: true, permissions: [...state.permissions.filter(p => p.requestId !== event.permission.requestId), event.permission] })
          break
        case 'permission_done':
          patch({ permissions: state.permissions.filter(p => p.requestId !== event.requestId) })
          break
        case 'ended':
          patch({
            running: false, partial: '', pendingUser: undefined, startedAt: undefined, permissions: [],
            ...event.status === 'error' ? { error: event.error ?? 'error' } : {},
          })
          hooks.onTurnEnded()
          void settle(id, mine)
          break
      }
    }
  }
  const load = (id: string, carried?: Pick<TranscriptState, 'messages' | 'pendingUser' | 'startedAt'>): void => {
    generation += 1
    const mine = generation
    closeFeeds()
    pendingBase = carried?.messages.length ?? 0
    if (isDraft(id)) {
      publish({ ...IDLE, status: 'ready', sessionId: id })
      return
    }
    publish({ ...IDLE, status: 'loading', sessionId: id, ...carried === undefined ? {} : { ...carried, running: true } })
    startLive(id, mine)
    void refresh(id, mine)
      .then((ok) => { if (ok) startWatch(id, mine) })
      .catch((error: unknown) => {
        if (mine !== generation) return
        // A thread that a switch just created can be unreadable for a moment; the live turn refreshes the transcript.
        if (carried !== undefined) {
          patch({ status: 'ready' })
          startWatch(id, mine)
          return
        }
        console.warn('agent-bridge: transcript load failed', error)
        patch({ status: 'failed' })
      })
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open: load,
    reload() {
      if (state.sessionId !== undefined) load(state.sessionId)
    },
    close() {
      generation += 1
      closeFeeds()
      publish(IDLE)
    },
    async send(text, cwd, extras) {
      const current = state.sessionId
      if (current === undefined || state.running) return
      const draft = isDraft(current)
      pendingBase = state.messages.length
      patch({ running: true, pendingUser: text, startedAt: Date.now(), partial: '', error: undefined })
      try {
        const switching = extras?.switchFrom !== undefined
        const body: SendBodyWire = { ...draft ? { text, cwd, engine: engineOfSession(current), ...instanceOfSession(current) === undefined ? {} : { instance: instanceOfSession(current) as string } } : switching ? { text, cwd } : { id: current, text, ...cwd === '' ? {} : { cwd } }, ...extras }
        const response = await post(SEND_PATH, body)
        if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`)
        const { id } = await response.json() as { id: string }
        hooks.onTurnStarted()
        if (switching) {
          hooks.onSwitched(current, id, cwd, text)
          // The transcript stays on screen while the merged one loads.
          load(id, { messages: state.messages, pendingUser: text, startedAt: state.startedAt })
          return
        }
        if (draft) {
          const mine = generation
          hooks.onCreated(id, cwd, text)
          if (mine === generation) {
            patch({ sessionId: id })
            startLive(id, mine)
          }
        }
      } catch (error) {
        patch({ running: false, pendingUser: undefined, startedAt: undefined, error: error instanceof Error ? error.message : String(error) })
      }
    },
    async answer(requestId, behavior, answers, remember) {
      if (state.sessionId === undefined) return
      const body: AnswerBodyWire = {
        id: state.sessionId, requestId, behavior,
        ...answers === undefined ? {} : { answers }, ...remember === true ? { remember } : {},
      }
      await post(ANSWER_PATH, body)
    },
    fail(message) {
      patch({ error: message })
    },
    async fork(id, title, cwd) {
      const response = await post(MANAGE_PATH, { id, action: 'fork', title, cwd } satisfies ManageBodyWire)
      if (!response.ok) {
        patch({ error: ((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}` })
        return undefined
      }
      const { id: forked } = await response.json() as { id: string }
      hooks.onCreated(forked, cwd, title)
      load(forked)
      return forked
    },
    async manage(action, title) {
      const current = state.sessionId
      if (current === undefined || isDraft(current) || state.running) return
      const body: ManageBodyWire = { id: current, action, ...title === undefined ? {} : { title } }
      const response = await post(MANAGE_PATH, body)
      if (!response.ok) {
        patch({ error: ((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}` })
        return
      }
      if (action === 'delete') {
        generation += 1
        closeFeeds()
        publish(IDLE)
        hooks.onDeleted(current)
      } else {
        hooks.onRenamed(current, title ?? '')
        hooks.onTurnEnded()
      }
    },
    async archive() {
      const current = state.sessionId
      if (current === undefined || isDraft(current) || state.running) return
      const response = await post(ARCHIVE_PATH, { id: current, archived: true })
      if (!response.ok) { patch({ error: `HTTP ${response.status}` }); return }
      generation += 1
      closeFeeds()
      publish(IDLE)
      hooks.onDeleted(current)
    },
    async interrupt() {
      if (state.sessionId === undefined) return
      await post(INTERRUPT_PATH, { id: state.sessionId })
    },
  }
}
