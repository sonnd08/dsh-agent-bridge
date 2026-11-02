/**
 * Pi sessions. The session list and transcripts come from Pi's JSONL session files; each turn and each
 * session command runs its own `pi --mode rpc` child, so no process holds a session between turns and the
 * `pi` CLI can keep using it. Pi runs tool calls without asking, so the only prompts are extension dialogs.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { capped } from './codex.ts'
import { modelLabel } from './defaults.ts'
import { LineSplitter } from './lines.ts'
import { LiveHub, type Subscriber } from './live.ts'
import {
  PI_ID_PREFIX, type BlockWire, type InfoWire, type MessageWire, type ModelWire, type PermissionWire, type SearchHitWire, type SessionRowWire, type UsageWire,
} from './protocol.ts'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- session entries and RPC records are read field by field at the file and process boundaries

/** @returns the folder Pi stores sessions in, following its environment overrides. */
export function piSessionDir(): string {
  const sessions = process.env['PI_CODING_AGENT_SESSION_DIR']
  if (sessions !== undefined && sessions !== '') return sessions
  const agent = process.env['PI_CODING_AGENT_DIR']
  return join(agent === undefined || agent === '' ? join(homedir(), '.pi', 'agent') : agent, 'sessions')
}

async function sessionFiles(): Promise<string[]> {
  const dir = piSessionDir()
  const names = await readdir(dir, { recursive: true }).catch(() => [] as string[])
  return names.filter(name => name.endsWith('.jsonl')).map(name => join(dir, name))
}

/**
 * @param id - session id (no prefix).
 * @returns the session file, or undefined when there is none yet.
 */
export async function findPiFile(id: string): Promise<string | undefined> {
  return (await sessionFiles()).find(file => file.endsWith(`_${id}.jsonl`))
}

function parseEntries(text: string): Json[] {
  const entries: Json[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line) as Json)
    } catch {
      // Pi may be writing the last line right now; the next read gets it whole.
    }
  }
  return entries
}

/** Entries of the active branch in order: the last entry and its ancestors. Other branches stay in the file. */
function activePath(entries: readonly Json[]): Json[] {
  const byId = new Map(entries.filter(entry => typeof entry['id'] === 'string' && entry['type'] !== 'session').map(entry => [String(entry['id']), entry]))
  const path: Json[] = []
  let current = [...byId.values()].at(-1)
  while (current !== undefined) {
    path.push(current)
    byId.delete(String(current['id']))
    current = typeof current['parentId'] === 'string' ? byId.get(current['parentId']) : undefined
  }
  return path.reverse()
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((part: Json) => part['type'] !== 'image').map((part: Json) => part['type'] === 'text' ? String(part['text'] ?? '') : `[${String(part['type'])}]`).join('\n')
}

function contentImages(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part: Json) => part['type'] === 'image' ? [`data:${String(part['mimeType'] ?? 'image/png')};base64,${String(part['data'] ?? '')}`] : [])
}

/** The tool cards draw a command from `command`, Codex's name for it. */
const toolName = (name: string): string => name === 'bash' ? 'command' : name

function assistantBlocks(message: Json): BlockWire[] {
  const blocks = ((message['content'] as Json[] | undefined) ?? []).flatMap((part): BlockWire[] => {
    switch (part['type']) {
      case 'text':
        return [{ type: 'text', text: String(part['text'] ?? '') }]
      case 'thinking':
        return part['thinking'] === undefined || part['thinking'] === '' ? [] : [{ type: 'thinking', text: String(part['thinking']) }]
      case 'toolCall': {
        const input = JSON.stringify(part['arguments'] ?? {})
        return [{
          type: 'tool_use', name: toolName(String(part['name'] ?? 'tool')), input: input.length > 400 ? `${input.slice(0, 400)}…` : input, id: String(part['id']),
          args: Object.fromEntries(Object.entries((part['arguments'] as Json | undefined) ?? {}).map(([key, value]) => [key, typeof value === 'string' ? capped(value) : value])),
        }]
      }
      default:
        return []
    }
  })
  return blocks.length === 0 && typeof message['errorMessage'] === 'string' ? [{ type: 'text', text: message['errorMessage'] }] : blocks
}

function toMessage(entry: Json): MessageWire | undefined {
  if (entry['type'] !== 'message') return undefined
  const id = String(entry['id'])
  const message = entry['message'] as Json
  switch (message['role']) {
    case 'user':
      return { id, role: 'user', blocks: [{ type: 'text', text: contentText(message['content']) }] }
    case 'assistant':
      return { id, role: 'assistant', blocks: assistantBlocks(message) }
    case 'toolResult': {
      const images = contentImages(message['content'])
      return { id, role: 'user', blocks: [{
        type: 'tool_result', text: capped(contentText(message['content'])), forId: String(message['toolCallId']),
        ...images.length === 0 ? {} : { images },
        ...message['isError'] === true ? { isError: true } : {},
      }] }
    }
    default:
      return undefined
  }
}

async function readPath(id: string): Promise<Json[]> {
  const file = await findPiFile(id)
  return file === undefined ? [] : activePath(parseEntries(await readFile(file, 'utf8')))
}

/**
 * @param id - session id (no prefix).
 * @returns the messages of the active branch; empty before Pi has written the session file.
 */
export async function readPiMessages(id: string): Promise<MessageWire[]> {
  return (await readPath(id)).flatMap(entry => toMessage(entry) ?? [])
}

/**
 * @param id - session id (no prefix).
 * @returns token totals of the active branch, or undefined when no assistant message is recorded.
 */
export async function readPiUsage(id: string): Promise<UsageWire | undefined> {
  const usages = (await readPath(id)).flatMap((entry): Json[] => entry['message']?.['role'] === 'assistant' && entry['message']['usage'] !== undefined ? [entry['message']['usage']] : [])
  if (usages.length === 0) return undefined
  const total = (key: string): number => usages.reduce((sum, usage) => sum + Number(usage[key] ?? 0), 0)
  return { input: total('input'), output: total('output'), cacheRead: total('cacheRead'), cacheWrite: total('cacheWrite') }
}

/** Rows already read, by file; a row is read again when its file's time or size changes. */
const rowCache = new Map<string, { readonly stamp: string; readonly row: SessionRowWire | undefined }>()

function rowOf(text: string, updatedAt: number): SessionRowWire | undefined {
  const entries = parseEntries(text)
  const header = entries[0]
  if (header?.['type'] !== 'session') return undefined
  const named = entries.findLast(entry => entry['type'] === 'session_info' && typeof entry['name'] === 'string')?.['name'] as string | undefined
  const firstUser = entries.find(entry => entry['type'] === 'message' && entry['message']?.['role'] === 'user')
  const title = named ?? (firstUser === undefined ? '' : contentText(firstUser['message']['content']).slice(0, 200))
  return { id: `${PI_ID_PREFIX}${String(header['id'])}`, title: title === '' ? String(header['id']) : title, cwd: String(header['cwd'] ?? ''), updatedAt }
}

/**
 * List sessions, newest first.
 * @param limit - maximum number of rows.
 * @returns rows whose ids carry the Pi prefix.
 */
export async function listPiRows(limit: number): Promise<SessionRowWire[]> {
  const stats = await Promise.all((await sessionFiles()).map(async file => ({ file, info: await stat(file).catch(() => undefined) })))
  const newest = stats.flatMap(({ file, info }) => info === undefined ? [] : [{ file, updatedAt: info.mtimeMs, stamp: `${info.mtimeMs}:${info.size}` }]).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
  const rows: SessionRowWire[] = []
  for (const { file, updatedAt, stamp } of newest) {
    let cached = rowCache.get(file)
    if (cached?.stamp !== stamp) {
      const text = await readFile(file, 'utf8').catch(() => undefined)
      if (text === undefined) continue
      cached = { stamp, row: rowOf(text, updatedAt) }
      rowCache.set(file, cached)
    }
    if (cached.row !== undefined) rows.push(cached.row)
  }
  return rows
}

/**
 * Look for text in the messages of the given sessions.
 * @param rows - sessions to search, in order.
 * @param term - text to look for, ignoring case.
 * @param limit - maximum number of hits.
 * @returns one hit per matching session.
 */
export async function searchPi(rows: readonly SessionRowWire[], term: string, limit: number): Promise<SearchHitWire[]> {
  const needle = term.toLowerCase()
  const hits: SearchHitWire[] = []
  for (const row of rows) {
    if (hits.length >= limit) break
    const texts = (await readPiMessages(row.id.slice(PI_ID_PREFIX.length))).flatMap(message => message.blocks.flatMap(block => block.type === 'text' || block.type === 'thinking' ? [block.text] : []))
    const text = texts.find(item => item.toLowerCase().includes(needle))
    if (text === undefined) continue
    const at = text.toLowerCase().indexOf(needle)
    hits.push({ id: row.id, title: row.title, snippet: text.slice(Math.max(0, at - 40), at + needle.length + 80).replace(/\s+/g, ' '), cwd: row.cwd })
  }
  return hits
}

/** How long Pi may take to answer one command, startup included; a run's model work is not part of this. */
const COMMAND_DEADLINE_MS = 60_000
/** How long a child may take to exit after its input closes or a turn is aborted. */
const EXIT_GRACE_MS = 5000
/** Tail of the error output kept to explain a child that exits unexpectedly. */
const STDERR_LIMIT = 2000

/** One `pi --mode rpc` child: commands correlated by id, session events handed to `onEvent`. */
class PiChild {
  private readonly child: ChildProcess
  private readonly lines = new LineSplitter()
  private nextId = 1
  private readonly pending = new Map<string, { resolve: (data: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private stderr = ''
  private exited = false

  constructor(
    executable: string, args: readonly string[], cwd: string,
    private readonly onEvent: (record: Json) => void,
    private readonly onExit: (child: PiChild, detail: string) => void,
  ) {
    this.child = spawn(executable, ['--mode', 'rpc', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdin?.on('error', () => {
      // Pi exited with a write in flight; the exit handler below reports that.
    })
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_LIMIT) })
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => {
      for (const line of this.lines.push(chunk)) this.dispatch(line)
    })
    this.child.on('error', (error) => { this.finish(error.message) })
    this.child.on('exit', (code, signal) => {
      this.finish(`pi exited (${signal ?? code ?? 'unknown'})${this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`}`)
    })
  }

  private finish(detail: string): void {
    if (this.exited) return
    this.exited = true
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(detail))
    }
    this.pending.clear()
    this.onExit(this, detail)
  }

  private dispatch(line: string): void {
    let record: Json
    try {
      record = JSON.parse(line) as Json
    } catch {
      // stdout is reserved for protocol records, so a line that is not JSON carries nothing to act on.
      return
    }
    if (record['type'] !== 'response') {
      this.onEvent(record)
      return
    }
    const waiter = this.pending.get(String(record['id']))
    if (waiter === undefined) return
    this.pending.delete(String(record['id']))
    clearTimeout(waiter.timer)
    if (record['success'] === true) waiter.resolve((record['data'] ?? {}) as Json)
    else waiter.reject(new Error(String(record['error'] ?? `pi refused ${String(record['command'])}`)))
  }

  /**
   * Write one record that gets no awaited response.
   * @param record - the record.
   */
  send(record: Json): void {
    if (!this.exited) this.child.stdin?.write(`${JSON.stringify(record)}\n`)
  }

  /**
   * Run one command.
   * @param type - command type.
   * @param fields - command fields.
   * @returns the response's data.
   */
  call(type: string, fields: Json = {}): Promise<Json> {
    if (this.exited) return Promise.reject(new Error('pi has exited'))
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`pi did not answer ${type} in time`))
      }, COMMAND_DEADLINE_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, type, ...fields })
    })
  }

  /** Ask for an orderly exit, and stop the child if it has not exited after the grace period. */
  close(): void {
    this.child.stdin?.end()
    this.killAfterGrace()
  }

  /** Stop the child if it has not exited after the grace period. */
  killAfterGrace(): void {
    setTimeout(() => { this.kill() }, EXIT_GRACE_MS).unref()
  }

  /** Stop the child now. */
  kill(): void {
    if (!this.exited) this.child.kill()
  }
}

/** Options of one Pi turn. */
export interface PiTurnOptions {
  /** Session to continue; absent starts a new one. */
  readonly sessionId?: string
  readonly cwd: string
  readonly text: string
  /** `provider/id`; undefined keeps the session's model. */
  readonly model?: string
  readonly effort?: string
  readonly images?: readonly { readonly mime: string; readonly base64: string }[]
}

/** The user's answer to a pending extension dialog. */
export type PiDecision =
  | { readonly behavior: 'allow'; readonly answers?: Readonly<Record<string, string>> }
  | { readonly behavior: 'deny' }

interface Run {
  readonly child: PiChild
  readonly pending: Map<string, (decision: PiDecision) => void>
  interrupted: boolean
  /** Failure of the latest assistant message; a later retry that succeeds clears it. */
  error?: string
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'] as const
const EXTRA_THINKING_LEVELS = ['xhigh', 'max'] as const

/** A null entry of `thinkingLevelMap` removes a level; the two extra levels exist only when the map names them. */
function effortsOf(model: Json): string[] {
  if (model['reasoning'] !== true) return []
  const map = (model['thinkingLevelMap'] ?? {}) as Record<string, string | null | undefined>
  return [
    ...THINKING_LEVELS.filter(level => map[level] !== null),
    ...EXTRA_THINKING_LEVELS.filter(level => map[level] !== null && map[level] !== undefined),
  ]
}

/** Pi sessions: live turns, extension dialogs, and the session commands that need Pi itself. */
export class PiEngine {
  private readonly hub = new LiveHub()
  private readonly runs = new Map<string, Run>()
  private readonly children = new Set<PiChild>()

  /**
   * @param executable - path of the `pi` executable.
   */
  constructor(private readonly executable: string) {}

  private open(args: readonly string[], cwd: string, onEvent: (record: Json) => void, onExit: (detail: string) => void): PiChild {
    const child = new PiChild(this.executable, args, cwd, onEvent, (ended, detail) => {
      this.children.delete(ended)
      onExit(detail)
    })
    this.children.add(child)
    return child
  }

  /**
   * Start a turn, creating the session when none is named.
   * @param options - turn options.
   * @returns the session id.
   */
  async start(options: PiTurnOptions): Promise<string> {
    const id = options.sessionId ?? randomUUID()
    // A new session has no file until its first message, so this comes before the lookup that would call it gone.
    if (this.runs.has(id)) throw new Error('a turn is already running in this session')
    const file = options.sessionId === undefined ? undefined : await findPiFile(options.sessionId)
    if (options.sessionId !== undefined && file === undefined) throw new Error('this Pi session no longer exists')
    if (this.runs.has(id)) throw new Error('a turn is already running in this session')
    const child = this.open([
      ...file === undefined ? ['--session-id', id] : ['--session', file],
      ...options.model === undefined || options.model === '' ? [] : ['--model', options.model],
      ...options.effort === undefined || options.effort === '' ? [] : ['--thinking', options.effort],
    ], options.cwd, (record) => {
      if (this.runs.get(id)?.child === child) this.onEvent(id, record)
    }, (detail) => {
      // The child of a finished turn can exit while the next turn of this session runs; only the current child ends a turn.
      const run = this.runs.get(id)
      if (run?.child === child) this.finish(id, run.interrupted ? 'interrupted' : 'error', detail)
    })
    this.runs.set(id, { child, pending: new Map(), interrupted: false })
    this.hub.begin(id)
    try {
      const accepted = await child.call('prompt', {
        message: options.text,
        ...options.images === undefined || options.images.length === 0 ? {} : { images: options.images.map(image => ({ type: 'image', data: image.base64, mimeType: image.mime })) },
      })
      // An extension command consumed the prompt, so no run started and no settled event will come.
      if (accepted['disposition'] === 'handled') this.finish(id, 'ok')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.finish(id, 'error', detail)
      child.kill()
      throw new Error(detail)
    }
    return id
  }

  private finish(id: string, status: 'ok' | 'error' | 'interrupted', error?: string): void {
    const run = this.runs.get(id)
    if (run === undefined) return
    for (const answer of [...run.pending.values()]) answer({ behavior: 'deny' })
    this.hub.emit(id, status === 'error' ? { kind: 'ended', status, error: error ?? 'the turn failed' } : { kind: 'ended', status })
    this.runs.delete(id)
    this.hub.end(id)
    run.child.close()
  }

  private onEvent(id: string, record: Json): void {
    const run = this.runs.get(id)
    if (run === undefined) return
    switch (record['type']) {
      case 'message_update':
        if (record['assistantMessageEvent']?.['type'] === 'text_delta') this.hub.emit(id, { kind: 'delta', text: String(record['assistantMessageEvent']['delta'] ?? '') })
        break
      case 'message_end': {
        const message = record['message'] as Json
        if (message['role'] === 'assistant') {
          if (message['stopReason'] === 'error') run.error = String(message['errorMessage'] ?? 'the model request failed')
          else delete run.error
        }
        if (message['role'] !== 'system') this.hub.emit(id, { kind: 'message' })
        break
      }
      case 'agent_settled':
        if (run.interrupted || record['aborted'] === true) this.finish(id, 'interrupted')
        else if (run.error === undefined) this.finish(id, 'ok')
        else this.finish(id, 'error', run.error)
        break
      case 'extension_ui_request':
        this.onDialog(id, run, record)
        break
      default:
        break
    }
  }

  /** Confirm and select dialogs become cards. The cards have no text field, so input and editor dialogs are cancelled at once. */
  private onDialog(id: string, run: Run, request: Json): void {
    const requestId = String(request['id'])
    const title = String(request['title'] ?? '')
    const respond = (fields: Json): void => { run.child.send({ type: 'extension_ui_response', id: requestId, ...fields }) }
    let permission: PermissionWire
    let reply: (decision: PiDecision) => Json
    switch (request['method']) {
      case 'confirm':
        permission = { requestId, tool: 'confirm', title, input: String(request['message'] ?? '') }
        reply = decision => ({ confirmed: decision.behavior === 'allow' })
        break
      case 'select':
        permission = {
          requestId, tool: 'select', title, input: '',
          questions: [{ question: title, header: 'Pi', multiSelect: false, options: ((request['options'] as unknown[] | undefined) ?? []).map(option => ({ label: String(option), description: '' })) }],
        }
        reply = decision => decision.behavior === 'allow' && decision.answers?.[title] !== undefined ? { value: decision.answers[title] } : { cancelled: true }
        break
      case 'input':
      case 'editor':
        respond({ cancelled: true })
        return
      default:
        return
    }
    const remove = (): boolean => {
      if (!run.pending.delete(requestId)) return false
      this.hub.emit(id, { kind: 'permission_done', requestId })
      return true
    }
    run.pending.set(requestId, (decision) => { if (remove()) respond(reply(decision)) })
    // Pi resolves a dialog with a timeout by itself, so the card must not outlive it.
    if (typeof request['timeout'] === 'number') setTimeout(remove, request['timeout']).unref()
    this.hub.emit(id, { kind: 'permission', permission })
  }

  /**
   * @param id - session id (no prefix).
   * @returns whether a turn is running.
   */
  isRunning(id: string): boolean {
    return this.runs.has(id)
  }

  /**
   * Resolve a pending extension dialog.
   * @param id - session id (no prefix).
   * @param requestId - request id from the permission event.
   * @param decision - the user's decision.
   * @returns false when nothing was pending under that id.
   */
  answer(id: string, requestId: string, decision: PiDecision): boolean {
    const answer = this.runs.get(id)?.pending.get(requestId)
    if (answer === undefined) return false
    answer(decision)
    return true
  }

  /**
   * Abort the running turn; a child that does not settle after the grace period is stopped.
   * @param id - session id (no prefix).
   * @returns false when no turn is running.
   */
  interrupt(id: string): boolean {
    const run = this.runs.get(id)
    if (run === undefined) return false
    run.interrupted = true
    for (const answer of [...run.pending.values()]) answer({ behavior: 'deny' })
    run.child.send({ type: 'abort' })
    run.child.killAfterGrace()
    return true
  }

  /**
   * @param id - session id (no prefix).
   * @param subscriber - event callback.
   * @returns the unsubscribe function.
   */
  subscribe(id: string, subscriber: Subscriber): () => void {
    return this.hub.subscribe(id, subscriber)
  }

  private async onSession<T>(id: string, work: (child: PiChild) => Promise<T>): Promise<T> {
    const file = await findPiFile(id)
    if (file === undefined) throw new Error('this Pi session no longer exists')
    const cwd = String(parseEntries(await readFile(file, 'utf8'))[0]?.['cwd'] ?? '')
    if (statSync(cwd, { throwIfNoEntry: false })?.isDirectory() !== true) throw new Error(`the working directory no longer exists: ${cwd}`)
    const child = this.open(['--session', file], cwd, () => {}, () => {})
    try {
      return await work(child)
    } finally {
      child.close()
    }
  }

  /**
   * @param id - source session id (no prefix).
   * @returns the id of the new session, a copy of the source's active branch.
   */
  async fork(id: string): Promise<string> {
    return await this.onSession(id, async (child) => {
      if ((await child.call('clone'))['cancelled'] === true) throw new Error('a Pi extension cancelled the fork')
      return String((await child.call('get_state'))['sessionId'])
    })
  }

  /**
   * @param id - session id (no prefix).
   * @param name - new name.
   */
  async rename(id: string, name: string): Promise<void> {
    await this.onSession(id, child => child.call('set_session_name', { name }))
  }

  /**
   * Delete the session file, as Pi's own documentation describes.
   * @param id - session id (no prefix).
   */
  async delete(id: string): Promise<void> {
    const file = await findPiFile(id)
    if (file === undefined) throw new Error('this Pi session no longer exists')
    await rm(file)
  }

  /**
   * @param cwd - folder to ask about; project settings can change what Pi offers.
   * @returns models, commands, and the configured defaults.
   */
  async readInfo(cwd: string): Promise<InfoWire> {
    const child = this.open(['--no-session'], cwd, () => {}, () => {})
    try {
      const [state, models, commands] = await Promise.all([child.call('get_state'), child.call('get_available_models'), child.call('get_commands')])
      const current = state['model'] as Json | undefined
      const currentValue = current === undefined ? undefined : `${String(current['provider'])}/${String(current['id'])}`
      const list: ModelWire[] = (models['models'] as Json[]).map((model) => {
        const value = `${String(model['provider'])}/${String(model['id'])}`
        return { value, name: String(model['name'] ?? model['id']), description: String(model['provider']), efforts: effortsOf(model), ...value === currentValue ? { isDefault: true } : {} }
      })
      return {
        models: list,
        commands: (commands['commands'] as Json[]).map(command => ({ name: String(command['name']), description: String(command['description'] ?? ''), argumentHint: '' })),
        mcp: [],
        defaults: {
          ...currentValue === undefined ? {} : { model: modelLabel(currentValue, list) },
          ...typeof state['thinkingLevel'] === 'string' ? { effort: state['thinkingLevel'] } : {},
        },
      }
    } finally {
      child.close()
    }
  }

  /** Stop every child (plugin teardown). */
  closeAll(): void {
    for (const child of [...this.children]) child.kill()
  }
}
