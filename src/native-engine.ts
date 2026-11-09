/**
 * Runs Claude Code and Codex as model providers of a DSH session, so that a chat stays one session when the user changes model.
 * The engine runs its own tools. Each tool call is recorded through the `engine_tool` proxy, which waits for the
 * engine's result, so that DSH draws, stores and forks the work like its own.
 * @module dsh-agent-bridge/native-engine
 */
import { explainTurnError } from './login.ts'
import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { renderHandoff, handoffNote } from './handoff.ts'
import type { BlockWire, EngineName, MessageWire } from './protocol.ts'
import { composeSwitchPrompt } from './links.ts'
import { CLAUDE_ROUTE } from './native-routes.ts'

/** Provider route of the default Claude Code in the DSH catalog. */
export const CLAUDE_PROVIDER = CLAUDE_ROUTE
/** Context size that DSH uses for an engine's models. */
const ENGINE_CONTEXT_WINDOW = 1_000_000
/** Name of the proxy tool that records an engine's tool calls. */
export const ENGINE_TOOL = 'engine_tool'
/** Each DSH turn is one engine process, so work that outlives a turn has no turn to report to. */
const NO_BACKGROUND_TASKS = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'

/** The fields of a DSH request message that the bridge reads. */
export interface RequestMessageLike {
  readonly id?: string
  readonly role: string
  readonly content: readonly { readonly type: string; readonly text?: string; readonly id?: string; readonly name?: string; readonly arguments?: string }[]
  readonly source?: { readonly kind?: string; readonly provider?: string }
}

/** One DSH stream chunk. */
export type EngineChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta' | 'reasoning-delta'; index: number; text: string }
  | { type: 'block-end'; index: number; block: Record<string, unknown> }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
  | { type: 'finish'; reason: { kind: 'stop' | 'tool-calls' } }

/** The fields of a DSH model request that the bridge reads. */
export interface EngineRequest {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly messages: readonly RequestMessageLike[]
  readonly signal?: AbortSignal
  readonly sessionId?: string
  readonly purpose?: string
}

/** What the adapter needs from the plugin. */
export interface EngineHostDeps {
  cwdOf(sessionId: string): string
  threadOf(key: string): string | undefined
  saveThread(key: string, thread: string): void
  writeHandoff(sessionId: string, text: string): Promise<string>
  /** @param key - session and route of an engine turn that starts from DSH. */
  onRealTurn(key: string): void
}

/** What a Claude Code driver needs from the plugin. */
export interface ClaudeDriverDeps {
  readonly route: string
  query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }): Query
  /** Claude options for a turn in a folder, resuming a thread if one is given. */
  options(request: { readonly thread?: string; readonly cwd: string; readonly text: string; readonly model: string; readonly effort?: string }): Options
  listModels(): Promise<readonly EngineModel[]>
}

/** One step of an engine turn, in the order that the engine reported it. */
export type RunEvent =
  | { kind: 'start'; block: 'text' | 'reasoning' }
  | { kind: 'delta'; text: string }
  | { kind: 'stop' }
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'step-end' }
  | { kind: 'usage'; input: number; output: number; cacheRead: number; cacheWrite: number }
  | { kind: 'done'; error?: string }

/** A model that an engine offers. */
export interface EngineModel {
  readonly id: string
  readonly name: string
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
  readonly defaultEffort?: string
}

/** Receives the steps of one engine turn. */
export interface EngineSink {
  push(event: RunEvent): void
  settle(id: string, outcome: ToolOutcome): void
  /** @returns whether DSH started the tool call: false means that DSH refused it, or the turn ended first. */
  approve(id: string): Promise<boolean>
  onThread(thread: string): void
}

/** One turn to run. */
export interface EngineTurn {
  readonly thread?: string
  readonly cwd: string
  readonly prompt: string
  readonly model: string
  readonly effort?: string
  readonly sink: EngineSink
}

/** A running turn. */
export interface EngineHandle { interrupt(): Promise<void> }

/** Connects one engine to the provider adapter. */
export interface EngineDriver {
  readonly route: string
  readonly name: string
  listModels(): Promise<readonly EngineModel[]>
  begin(turn: EngineTurn): Promise<EngineHandle>
  /** @param prompt - the text. @param model - the model. @returns the reply of a turn that is not part of a chat, such as a title request. */
  oneShot(prompt: string, model: string): Promise<string>
}

/** The result of an engine's tool call. */
export interface ToolOutcome { readonly text: string; readonly isError: boolean }

class EventQueue {
  private readonly items: RunEvent[] = []
  private waiter: ((event: RunEvent) => void) | undefined
  push(event: RunEvent): void {
    if (this.waiter === undefined) { this.items.push(event); return }
    const resolve = this.waiter
    this.waiter = undefined
    resolve(event)
  }

  next(): Promise<RunEvent> {
    const item = this.items.shift()
    return item === undefined ? new Promise((resolve) => { this.waiter = resolve }) : Promise.resolve(item)
  }
}

/** One engine turn, which spans several DSH steps. */
class EngineRun {
  readonly queue = new EventQueue()
  readonly outcomes = new Map<string, ToolOutcome>()
  readonly waiters = new Map<string, (outcome: ToolOutcome) => void>()
  readonly approvals = new Map<string, (allow: boolean) => void>()
  readonly accepted = new Set<string>()
  handle: EngineHandle | undefined

  /** @param key - the session and provider of this run. */
  constructor(readonly key: string) {}

  /** @param id - tool call. @param outcome - the engine's result. */
  settle(id: string, outcome: ToolOutcome): void {
    const waiter = this.waiters.get(id)
    if (waiter === undefined) this.outcomes.set(id, outcome)
    else { this.waiters.delete(id); waiter(outcome) }
  }

  /** @param id - tool call. @returns the engine's result, when it arrives. */
  outcome(id: string): Promise<ToolOutcome> {
    const known = this.outcomes.get(id)
    return known === undefined ? new Promise((resolve) => { this.waiters.set(id, resolve) }) : Promise.resolve(known)
  }

  /** @param id - tool call. @returns whether DSH started the call. */
  approve(id: string): Promise<boolean> {
    return this.accepted.has(id) ? Promise.resolve(true) : new Promise((resolve) => { this.approvals.set(id, resolve) })
  }

  /** A call that DSH did not run was refused there, so the engine must not run it. */
  denyWaiting(): void {
    for (const [id, decide] of this.approvals) { this.approvals.delete(id); decide(false) }
  }
}

function textOfResult(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.flatMap((block: { type?: string; text?: string }) => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('\n') : ''
}

/**
 * Translate one SDK message into run events and tool results. Work of a subagent is left out: it is part of its Agent call.
 * @param message - the SDK message.
 * @param run - the receiving run.
 * @param onThread - called with the engine's thread id.
 */
export function applySdkMessage(message: SDKMessage, run: { readonly queue: { push(event: RunEvent): void }; settle(id: string, outcome: ToolOutcome): void }, onThread: (thread: string) => void): void {
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init') onThread(message.session_id)
      return
    case 'stream_event': {
      if (message.parent_tool_use_id !== null) return
      const { event } = message
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'text') run.queue.push({ kind: 'start', block: 'text' })
        else if (event.content_block.type === 'thinking') run.queue.push({ kind: 'start', block: 'reasoning' })
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') run.queue.push({ kind: 'delta', text: event.delta.text })
        else if (event.delta.type === 'thinking_delta') run.queue.push({ kind: 'delta', text: event.delta.thinking })
      } else if (event.type === 'content_block_stop') {
        run.queue.push({ kind: 'stop' })
      } else if (event.type === 'message_start') {
        const { usage } = event.message
        run.queue.push({ kind: 'usage', input: usage.input_tokens, output: 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 })
      } else if (event.type === 'message_delta') {
        run.queue.push({ kind: 'usage', input: 0, output: event.usage.output_tokens, cacheRead: 0, cacheWrite: 0 })
      } else if (event.type === 'message_stop') {
        run.queue.push({ kind: 'step-end' })
      }
      return
    }
    case 'assistant':
      if (message.parent_tool_use_id !== null) return
      for (const block of message.message.content) {
        if (block.type === 'tool_use') run.queue.push({ kind: 'tool', id: block.id, name: block.name, input: block.input })
      }
      return
    case 'user': {
      if (message.parent_tool_use_id !== null || typeof message.message.content === 'string') return
      for (const block of message.message.content) {
        if (block.type === 'tool_result') run.settle(block.tool_use_id, { text: textOfResult(block.content), isError: block.is_error === true })
      }
      return
    }
    case 'result':
      run.queue.push(message.is_error ? { kind: 'done', error: message.subtype === 'success' ? message.result : message.errors.join('\n') } : { kind: 'done' })
      return
    default:
      return
  }
}

function typedText(message: RequestMessageLike): string {
  return message.content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('\n')
}

const isTyped = (message: RequestMessageLike): boolean => message.role === 'user' && (message.source?.kind === 'user' || message.source === undefined)

function wireOf(message: RequestMessageLike, index: number): MessageWire | undefined {
  if (message.role !== 'assistant' && !isTyped(message)) return undefined
  const blocks = message.content.flatMap((block): BlockWire[] => {
    if (block.type === 'text' && block.text !== undefined) return [{ type: 'text', text: block.text }]
    if (block.type !== 'tool-call') return []
    const call = JSON.parse(block.arguments ?? '{}') as { tool?: string; input?: Record<string, unknown> }
    return [{ type: 'tool_use', name: block.name === ENGINE_TOOL ? call.tool ?? ENGINE_TOOL : block.name ?? '', input: '', id: block.id ?? '', ...call.input === undefined ? {} : { args: call.input } }]
  })
  return blocks.length === 0 ? undefined : { id: message.id ?? String(index), role: message.role as 'user' | 'assistant', blocks }
}

/**
 * Find what the engine must receive for this turn.
 * @param messages - the DSH request history.
 * @param provider - the engine's provider route.
 * @param hasThread - whether the engine already has a thread for this session.
 * @returns the text the user typed, and the messages that the engine has not seen.
 */
export function turnInput(messages: readonly RequestMessageLike[], provider: string, hasThread: boolean): { readonly text: string; readonly unseen: readonly MessageWire[] } {
  const lastReply = messages.findLastIndex(message => message.role === 'assistant')
  const text = messages.slice(lastReply + 1).filter(isTyped).map(typedText).filter(part => part !== '').join('\n\n')
  const lastOwn = hasThread ? messages.findLastIndex(message => message.role === 'assistant' && message.source?.provider === provider) : -1
  const unseen = messages.slice(lastOwn + 1, lastReply + 1).flatMap((message, index) => {
    const wire = wireOf(message, index)
    return wire === undefined ? [] : [wire]
  })
  return { text, unseen }
}

/** The fields of a DSH tool execution that the proxy reads. */
export interface ProxyExecution { readonly rootCallId: string; readonly signal: AbortSignal }

/**
 * Create a Claude Code driver.
 * @param deps - plugin services.
 * @returns the driver.
 */
export function claudeDriver(deps: ClaudeDriverDeps): EngineDriver {
  return {
    route: deps.route,
    name: 'Claude Code',
    listModels: () => deps.listModels(),
    begin: ({ thread, cwd, prompt, model, effort, sink }) => {
      const canUseTool: CanUseTool = async (_tool, input, context) => await sink.approve(context.toolUseID)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'The user denied this tool call.' }
      const base = deps.options({ ...thread === undefined ? {} : { thread }, cwd, text: prompt, model, ...effort === undefined ? {} : { effort } })
      const query = deps.query({
        prompt,
        options: { ...base, env: { ...base.env ?? process.env, [NO_BACKGROUND_TASKS]: '1' }, permissionMode: 'default', includePartialMessages: true, canUseTool, disallowedTools: [...base.disallowedTools ?? [], 'AskUserQuestion'] },
      })
      const target = { queue: { push: (event: RunEvent) => { sink.push(event) } }, settle: (id: string, outcome: ToolOutcome) => { sink.settle(id, outcome) } }
      void (async () => {
        let ended = false
        try {
          for await (const message of query) {
            applySdkMessage(message, target, (id) => { sink.onThread(id) })
            // A process that stays after its turn writes to the thread that the next turn resumes.
            if (message.type === 'result') { ended = true; query.close(); break }
          }
          if (!ended) sink.push({ kind: 'done', error: 'Claude Code stopped before the turn ended.' })
        } catch (error) {
          sink.push({ kind: 'done', error: error instanceof Error ? error.message : String(error) })
        }
      })()
      return Promise.resolve({ interrupt: async () => { await query.interrupt() } })
    },
    oneShot: async (prompt, model) => {
      const base = deps.options({ cwd: process.env['HOME'] ?? '/', text: prompt, model })
      let text = ''
      for await (const message of deps.query({ prompt, options: { ...base, persistSession: false, maxTurns: 1, tools: [] } })) {
        if (message.type === 'result' && message.subtype === 'success') text = message.result
      }
      return text
    },
  }
}

/**
 * Create the shared part of the engine providers.
 * @param deps - plugin services.
 * @returns a factory of DSH adapters, and the body of the proxy tool that all adapters share.
 */
export function createEngineHost(deps: EngineHostDeps): {
  adapterFor: (driver: EngineDriver) => Record<string, unknown>
  armReplay: (key: string, replay: { readonly user: string; readonly assistant: string }) => void
  isActive: (key: string) => boolean
  executeProxy: (args: unknown, exec: ProxyExecution) => Promise<{ output: string; is_error: boolean }>
} {
  const active = new Map<string, EngineRun>()
  const toolRuns = new Map<string, EngineRun>()
  const replays = new Map<string, { readonly user: string; readonly assistant: string }>()
  const keyOf = (sessionId: string, provider: string): string => `${sessionId}|${provider}`

  const stopRun = (run: EngineRun): void => {
    if (active.get(run.key) === run) active.delete(run.key)
    void run.handle?.interrupt().catch(() => { /* The turn has ended, so nothing is left to stop. */ })
  }

  const start = async (driver: EngineDriver, request: EngineRequest, sessionId: string, key: string): Promise<EngineRun> => {
    const thread = deps.threadOf(key)
    const { text, unseen } = turnInput(request.messages, request.provider, thread !== undefined)
    let prompt = text
    if (unseen.length > 0) {
      const handoff = renderHandoff('previous model' as EngineName, unseen, false)
      prompt = composeSwitchPrompt(text, handoffNote('previous model' as EngineName, await deps.writeHandoff(sessionId, handoff.text), handoff, unseen.length))
    }
    const run = new EngineRun(key)
    run.handle = await driver.begin({
      ...thread === undefined ? {} : { thread },
      cwd: deps.cwdOf(sessionId),
      prompt,
      model: request.model,
      ...request.reasoningEffort === undefined ? {} : { effort: request.reasoningEffort },
      sink: {
        push: (event) => {
          if (event.kind === 'done') run.denyWaiting()
          run.queue.push(event)
        },
        settle: (id, outcome) => { run.settle(id, outcome) },
        approve: id => run.approve(id),
        onThread: (id) => { deps.saveThread(key, id) },
      },
    })
    return run
  }

  async function* oneShot(driver: EngineDriver, request: EngineRequest): AsyncGenerator<EngineChunk> {
    const text = await driver.oneShot(request.messages.map(typedText).filter(part => part !== '').join('\n\n'), request.model)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  async function* stream(driver: EngineDriver, request: EngineRequest): AsyncGenerator<EngineChunk> {
    if (request.purpose !== undefined || request.sessionId === undefined) {
      yield* oneShot(driver, request)
      return
    }
    const key = keyOf(request.sessionId, request.provider)
    const replay = replays.get(key)
    replays.delete(key)
    // A turn that already ran outside DSH is shown as it was written: the engine must not answer it again.
    if (replay !== undefined && turnInput(request.messages, request.provider, true).text === replay.user) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: replay.assistant }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: replay.assistant } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const existing = active.get(key)
    if (existing !== undefined) existing.denyWaiting()
    else deps.onRealTurn(key)
    const run = existing ?? await start(driver, request, request.sessionId, key)
    active.set(key, run)
    const stop = (): void => { stopRun(run) }
    request.signal?.addEventListener('abort', stop, { once: true })
    let index = 0
    let open: { block: 'text' | 'reasoning'; text: string } | undefined
    const tools: { id: string; name: string; input: unknown }[] = []
    let stepEnded = false
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    function* flushTools(): Generator<EngineChunk> {
      for (const tool of tools) {
        toolRuns.set(tool.id, run)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'block-end', index, block: { type: 'tool-call', id: tool.id, name: ENGINE_TOOL, arguments: JSON.stringify({ tool: tool.name, input: tool.input }) } }
        index += 1
      }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
    try {
      for (;;) {
        const event = await run.queue.next()
        request.signal?.throwIfAborted()
        switch (event.kind) {
          case 'start':
            open = { block: event.block, text: '' }
            yield { type: 'block-start', index, blockType: event.block }
            break
          case 'delta':
            if (open !== undefined) {
              open.text += event.text
              yield { type: open.block === 'text' ? 'text-delta' : 'reasoning-delta', index, text: event.text }
            }
            break
          case 'stop':
            if (open !== undefined) {
              yield { type: 'block-end', index, block: { type: open.block, text: open.text } }
              index += 1
              open = undefined
            }
            break
          case 'usage':
            usage.inputTokens += event.input
            usage.outputTokens += event.output
            usage.cacheReadTokens += event.cacheRead
            usage.cacheWriteTokens += event.cacheWrite
            break
          case 'tool':
            tools.push(event)
            // The SDK can report the call after the message end, so a finished step closes on the call.
            if (stepEnded) { yield* flushTools(); return }
            break
          case 'step-end':
            if (tools.length > 0) { yield* flushTools(); return }
            stepEnded = true
            break
          case 'done':
            active.delete(key)
            if (event.error !== undefined) throw new Error(explainTurnError(driver.name, event.error))
            yield { type: 'usage', usage }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
        }
      }
    } catch (error) {
      stop()
      throw error
    } finally {
      request.signal?.removeEventListener('abort', stop)
    }
  }

  const executeProxy = async (_args: unknown, exec: ProxyExecution): Promise<{ output: string; is_error: boolean }> => {
    const run = toolRuns.get(exec.rootCallId)
    toolRuns.delete(exec.rootCallId)
    if (run === undefined) return { output: 'This tool only records calls that another engine already made. Do not call it.', is_error: true }
    run.accepted.add(exec.rootCallId)
    const decide = run.approvals.get(exec.rootCallId)
    if (decide !== undefined) { run.approvals.delete(exec.rootCallId); decide(true) }
    // The model stream has ended while a tool runs, so the Stop button reaches the engine only through this call.
    const stopped = new Promise<ToolOutcome>((resolve) => {
      const onAbort = (): void => { stopRun(run); resolve({ text: 'The user stopped this tool call.', isError: true }) }
      if (exec.signal.aborted) onAbort()
      else exec.signal.addEventListener('abort', onAbort, { once: true })
    })
    const outcome = await Promise.race([run.outcome(exec.rootCallId), stopped])
    return { output: outcome.text, is_error: outcome.isError }
  }

  const adapterFor = (driver: EngineDriver): Record<string, unknown> => {
    const describe = (model: EngineModel | undefined, id: string) => ({
      id,
      name: model?.name ?? id,
      ...model === undefined || model.efforts.length === 0 ? {} : { reasoning: { efforts: model.efforts, ...model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort } } },
    })
    // The engine compacts its own thread, so DSH only needs a window that a chat does not fill.
    const resolved = async (provider: string, id: string) => {
      const models = await driver.listModels().catch(() => [])
      return { provider, ...describe(models.find(model => model.id === id), id), context: { contextWindow: ENGINE_CONTEXT_WINDOW } }
    }
    const run = (request: EngineRequest): AsyncGenerator<EngineChunk> => stream(driver, request)
    return {
      providerInfo: (provider: string) => ({ id: provider, name: driver.name }),
      providerRetryPolicy: () => undefined,
      imageRequestPricing: () => undefined,
      imageRequestTarget: (_provider: string, _model: string, image: { width: number; height: number; bytes: number }) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
      listModels: async (provider: string) => (await driver.listModels().catch(() => [])).map(model => ({ id: model.id, name: model.name, provider })),
      resolveModel: resolved,
      prepareCall: async (provider: string, model: string) => ({ model: await resolved(provider, model), stream: run }),
      stream: run,
    }
  }

  return { adapterFor, armReplay: (key, replay) => { replays.set(key, replay) }, isActive: key => active.has(key), executeProxy }
}
