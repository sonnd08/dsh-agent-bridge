/**
 * Decides which Claude Code and Codex chats become DSH chats, and which of their turns a DSH chat has not shown yet.
 * @module dsh-agent-bridge/mirror
 */
import type { ImportStep, ImportTurn } from './dsh-import.ts'
import { routeOf } from './native-routes.ts'
import { CLAUDE_ID_PREFIX, CODEX_ID_PREFIX, withInstanceId, type EngineName, type ProviderInstanceWire, type UsedModelWire } from './protocol.ts'

/** A chat is imported or updated only after its file has not changed for this time, so that a running turn is not cut. */
export const MIRROR_QUIET_MS = 20_000

/** Most chats imported by one sync. */
export const MIRROR_IMPORTS_PER_SYNC = 5

/** The DSH chat of one Claude Code or Codex chat. */
export interface MirrorEntry {
  readonly sessionId: string
  readonly route: string
  /** Number of turns of the engine chat that the DSH chat holds. */
  readonly synced: number
  /** File time of the last check. */
  readonly checkedAt: number
  /** A turn ran from DSH, so the engine file holds it already and it must not show twice. */
  readonly resync?: boolean
}

/** A turn to show in a DSH chat. */
export interface MirrorReplay {
  readonly user: string
  readonly assistant: string
  readonly synced: number
  /** Images that the user attached, as `data:` URLs. */
  readonly images?: readonly string[]
  /** The steps of the reply; absent when the reply used no tool. */
  readonly steps?: readonly ImportStep[]
}

/**
 * @param updatedAt - file time of the engine chat.
 * @param now - current time in milliseconds.
 * @returns whether the file has been quiet long enough.
 */
export function isQuiet(updatedAt: number, now: number): boolean {
  return now - updatedAt >= MIRROR_QUIET_MS
}

/**
 * Find the next turn that a DSH chat has not shown. A turn with no reply text is passed over.
 * @param synced - turns that the DSH chat holds.
 * @param turns - all turns of the engine chat, oldest first.
 * @returns the turn and the count after it; undefined when nothing is left.
 */
export function nextReplay(synced: number, turns: readonly ImportTurn[]): MirrorReplay | undefined {
  for (let index = synced; index < turns.length; index += 1) {
    const turn = turns[index] as ImportTurn
    if (turn.assistant !== '') return { user: turn.user, assistant: turn.assistant, synced: index + 1, ...turn.images === undefined ? {} : { images: turn.images }, ...turn.steps === undefined ? {} : { steps: turn.steps } }
  }
  return undefined
}

/** What the sync knows about a chat that has no DSH chat yet. */
export interface ImportCandidate {
  /** The file is quiet and no turn runs. */
  readonly quiet: boolean
  /** File time of the chat. */
  readonly updatedAt: number
  /** Time of the first sync; only later turns import a chat. */
  readonly since: number
  /** File time at which the chat was last found to have no new turn. */
  readonly lastChecked: number | undefined
  /** A DSH chat already uses this engine thread. */
  readonly owned: boolean
  readonly cwd: string
  /** Called only when the other checks pass, because it reads the disk. */
  isFolder(cwd: string): boolean
  /** Chats that this sync has imported so far. */
  readonly imports: number
}

/**
 * Decide what the sync does with a chat that has no DSH chat yet.
 * @param candidate - the chat.
 * @returns `read` to read its file for a new turn, `more` when the limit of this sync leaves it for the next sync, else `skip`.
 */
export function importStep(candidate: ImportCandidate): 'skip' | 'read' | 'more' {
  if (!candidate.quiet) return 'skip'
  // A file time can change with no new turn, so the time of the last turn decides.
  if (candidate.updatedAt <= candidate.since || candidate.lastChecked === candidate.updatedAt || candidate.owned) return 'skip'
  if (candidate.cwd === '' || !candidate.isFolder(candidate.cwd)) return 'skip'
  return candidate.imports >= MIRROR_IMPORTS_PER_SYNC ? 'more' : 'read'
}

/**
 * @param used - model and time of the last turn in the file; undefined when the file has none.
 * @param since - time of the first sync.
 * @returns whether the last turn is later than the first sync.
 */
export function hasTurnSince(used: UsedModelWire | undefined, since: number): used is UsedModelWire {
  return used?.at !== undefined && used.at > since
}

/**
 * @param engine - the engine of the chat.
 * @param instance - the added provider instance of the chat.
 * @param choice - the model and effort to use.
 * @returns the model selection of the new DSH chat.
 */
export function importSelection(engine: EngineName, instance: string | undefined, choice: { readonly model: string; readonly effort: string }): { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } {
  return { provider: routeOf(instance ?? engine), model: choice.model, ...choice.effort === '' ? {} : { reasoningEffort: choice.effort } }
}

/** What the sync knows about an imported chat before it reads the turns. */
export interface MirrorCheck {
  readonly updatedAt: number
  readonly quiet: boolean
  /** An engine turn from DSH still runs in the DSH chat. */
  readonly active: boolean
  /** The current provider of the DSH chat; undefined when the chat is not idle or not known. */
  readonly currentRoute: string | undefined
}

/**
 * @param entry - the imported chat.
 * @param check - the state of the chat.
 * @returns whether the sync reads the turns of the chat now. A chat on another provider gets no outside turn.
 */
export function mirrorNeedsRead(entry: MirrorEntry, check: MirrorCheck): boolean {
  if (check.updatedAt <= entry.checkedAt && entry.resync !== true) return false
  if (check.active || check.currentRoute !== entry.route) return false
  return entry.resync !== true || check.quiet
}

/** What to do with an imported chat after its turns are read. */
export interface MirrorPlan {
  /** The new state of the chat, when it changes. */
  readonly entry?: MirrorEntry
  /** The turn to show now. */
  readonly replay?: MirrorReplay
  /** More complete turns wait for the next sync. */
  readonly more: boolean
}

/**
 * Decide what an imported chat does after a read. A turn with a later message after it is complete, so an active chat
 * replays finished turns and holds back only the last one. The file time stays old while turns wait, so that the next sync finds them.
 * @param entry - the imported chat.
 * @param turns - all turns of the engine chat, oldest first.
 * @param quiet - the file is quiet and no turn runs.
 * @param updatedAt - file time of the chat.
 * @returns the plan.
 */
export function planMirror(entry: MirrorEntry, turns: readonly ImportTurn[], quiet: boolean, updatedAt: number): MirrorPlan {
  if (entry.resync === true) return { entry: { sessionId: entry.sessionId, route: entry.route, synced: turns.length, checkedAt: updatedAt }, more: false }
  const complete = quiet ? turns : turns.slice(0, -1)
  const replay = nextReplay(entry.synced, complete)
  if (replay === undefined) return { ...quiet ? { entry: { ...entry, synced: turns.length, checkedAt: updatedAt } } : {}, more: false }
  return { entry: { ...entry, synced: replay.synced, ...quiet && replay.synced >= turns.length ? { checkedAt: updatedAt } : {} }, replay, more: replay.synced < complete.length }
}

/**
 * Note that a turn ran from DSH: the engine file holds it already, so it must not show twice.
 * @param mirrors - imported chats by row id.
 * @param key - `sessionId|route` of the turn.
 * @returns the changed map; undefined when the chat is not imported.
 */
export function markResync(mirrors: Readonly<Record<string, MirrorEntry>>, key: string): Record<string, MirrorEntry> | undefined {
  const [sessionId, route] = key.split('|')
  const found = Object.entries(mirrors).find(([, entry]) => entry.sessionId === sessionId && entry.route === route)
  return found === undefined ? undefined : { ...mirrors, [found[0]]: { ...found[1], resync: true } }
}

/**
 * A native chat is listed by DSH, so the engine thread behind it must not get a row too.
 * @param engineThreads - engine threads by `sessionId|route`.
 * @param instances - the added provider instances.
 * @returns the row ids to hide.
 */
export function nativeThreadRowIds(engineThreads: Readonly<Record<string, string>>, instances: readonly ProviderInstanceWire[]): string[] {
  return Object.entries(engineThreads).flatMap(([key, thread]) => {
    const route = key.split('|')[1] ?? ''
    const instance = instances.find(item => item.id === route)
    const plain = [`${CLAUDE_ID_PREFIX}${thread}`, `${CODEX_ID_PREFIX}${thread}`]
    return instance === undefined ? plain : plain.map(id => withInstanceId(id, instance.id))
  })
}

/**
 * @param full - the caller needs the whole chat, because it counts the turns.
 * @param recent - the number of recent turns that a panel shows.
 * @returns the number of turns to read.
 */
export function historyTurnLimit(full: boolean, recent: number): number {
  return full ? Number.POSITIVE_INFINITY : recent
}
