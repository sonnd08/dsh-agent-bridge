/**
 * Connects Codex to the DSH provider adapter. Codex runs its own tools; each tool item is recorded through the proxy.
 * @module dsh-agent-bridge/native-codex
 */
import { capped, type CodexEngine, type CodexThreadEvent, type Json } from './codex.ts'
import type { EngineDriver, EngineHandle, EngineModel, EngineSink, EngineTurn, ToolOutcome } from './native-engine.ts'

/** What a Codex driver needs from the plugin. */
export interface CodexDriverDeps {
  readonly route: string
  engine(): CodexEngine
  listModels(): Promise<readonly EngineModel[]>
  home(): string
}

interface ToolView { readonly name: string; readonly input: unknown }

function toolView(item: Json): ToolView | undefined {
  switch (item['type']) {
    case 'commandExecution': return { name: 'command', input: { command: String(item['command'] ?? ''), ...typeof item['cwd'] === 'string' ? { cwd: item['cwd'] } : {} } }
    case 'fileChange': return { name: 'fileChange', input: { paths: ((item['changes'] as Json[] | undefined) ?? []).map(change => String(change['path'])) } }
    case 'mcpToolCall':
    case 'dynamicToolCall': return { name: String(item['tool'] ?? item['type']), input: item['arguments'] ?? {} }
    case 'webSearch': return { name: 'webSearch', input: { query: String(item['query'] ?? '') } }
    default: return undefined
  }
}

function toolOutcome(item: Json): ToolOutcome {
  switch (item['type']) {
    case 'commandExecution': {
      const failed = item['status'] !== 'completed' || (typeof item['exitCode'] === 'number' && item['exitCode'] !== 0)
      return { text: capped(String(item['aggregatedOutput'] ?? '')), isError: failed }
    }
    case 'fileChange': return {
      text: capped(((item['changes'] as Json[] | undefined) ?? []).map(change => `${String(change['path'])}\n${String(change['diff'] ?? '')}`).join('\n')),
      isError: item['status'] !== 'completed',
    }
    default: {
      const text = JSON.stringify(item['result'] ?? item['error'] ?? item)
      return { text: capped(text), isError: item['error'] !== undefined && item['error'] !== null }
    }
  }
}

/** Translates the events of one Codex turn into run events. */
export class CodexTurnReader {
  private open: { readonly id: string; readonly block: 'text' | 'reasoning' } | undefined
  private readonly seen = new Set<string>()
  private readonly streamed = new Set<string>()

  /**
   * @param sink - the receiver of the run events.
   * @param answer - answers an approval request.
   */
  constructor(private readonly sink: EngineSink, private readonly answer: (requestId: string, allow: boolean) => void) {}

  private text(id: string, block: 'text' | 'reasoning', delta: string): void {
    if (this.open?.id !== id) {
      if (this.open !== undefined) this.sink.push({ kind: 'stop' })
      this.open = { id, block }
      this.sink.push({ kind: 'start', block })
    }
    this.streamed.add(id)
    this.sink.push({ kind: 'delta', text: delta })
  }

  private tool(item: Json): void {
    const id = String(item['id'])
    const view = toolView(item)
    if (view === undefined || this.seen.has(id)) return
    this.seen.add(id)
    if (this.open !== undefined) { this.sink.push({ kind: 'stop' }); this.open = undefined }
    this.sink.push({ kind: 'tool', id, name: view.name, input: view.input })
    this.sink.push({ kind: 'step-end' })
  }

  /** @param event - one thread event. @returns whether the turn has ended. */
  read({ method, params }: CodexThreadEvent): boolean {
    switch (method) {
      case 'item/started':
        this.tool(params['item'] as Json)
        return false
      case 'item/agentMessage/delta':
        this.text(String(params['itemId']), 'text', String(params['delta'] ?? ''))
        return false
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.text(String(params['itemId']), 'reasoning', String(params['delta'] ?? ''))
        return false
      case 'item/completed': {
        const item = params['item'] as Json
        const id = String(item['id'])
        if (this.open?.id === id) {
          this.sink.push({ kind: 'stop' })
          this.open = undefined
        } else if (item['type'] === 'agentMessage' && !this.streamed.has(id) && String(item['text'] ?? '') !== '') {
          this.text(id, 'text', String(item['text']))
          this.sink.push({ kind: 'stop' })
          this.open = undefined
        }
        if (toolView(item) !== undefined) {
          this.tool(item)
          this.sink.settle(id, toolOutcome(item))
        }
        return false
      }
      case 'thread/tokenUsage/updated': {
        const last = (params['tokenUsage'] as Json | undefined)?.['last'] as Json | undefined
        if (last === undefined) return false
        const cached = Number(last['cachedInputTokens'] ?? 0)
        this.sink.push({ kind: 'usage', input: Number(last['inputTokens'] ?? 0) - cached, output: Number(last['outputTokens'] ?? 0), cacheRead: cached, cacheWrite: 0 })
        return false
      }
      case 'approval': {
        const requestId = String(params['requestId'])
        // A DSH chat has no form for a question from the engine.
        if (params['request'] === 'item/tool/requestUserInput') { this.answer(requestId, false); return false }
        void this.sink.approve(String(params['itemId'])).then((allow) => { this.answer(requestId, allow) })
        return false
      }
      case 'turn/completed': {
        const turn = params['turn'] as Json
        if (this.open !== undefined) { this.sink.push({ kind: 'stop' }); this.open = undefined }
        this.sink.push(turn['status'] === 'failed' ? { kind: 'done', error: String(turn['error']?.['message'] ?? 'Codex failed this turn.') } : { kind: 'done' })
        return true
      }
      default:
        return false
    }
  }
}

/**
 * Create a Codex driver. Codex asks before it runs a command that it does not trust; DSH gives that answer through the proxy.
 * @param deps - plugin services.
 * @returns the driver.
 */
export function codexDriver(deps: CodexDriverDeps): EngineDriver {
  const access = { approvalPolicy: 'untrusted', sandbox: 'danger-full-access' } as const
  return {
    route: deps.route,
    name: 'Codex',
    listModels: () => deps.listModels(),
    oneShot: (prompt, model) => deps.engine().ask(deps.home(), prompt, model),
    begin: async ({ thread, cwd, prompt, model, effort, sink }: EngineTurn): Promise<EngineHandle> => {
      const engine = deps.engine()
      const threadId = await engine.prepareThread({ ...thread === undefined ? {} : { threadId: thread }, cwd, model, ...access })
      sink.onThread(threadId)
      const reader = new CodexTurnReader(sink, (requestId, allow) => { engine.answer(threadId, requestId, allow ? { behavior: 'allow' } : { behavior: 'deny' }) })
      const stop = engine.watch(threadId, (event) => { if (reader.read(event)) stop() })
      await engine.start({ threadId, cwd, text: prompt, model, ...effort === undefined ? {} : { effort }, ...access }).catch((error: unknown) => {
        stop()
        sink.push({ kind: 'done', error: error instanceof Error ? error.message : String(error) })
      })
      return { interrupt: async () => { await engine.interrupt(threadId) } }
    },
  }
}
