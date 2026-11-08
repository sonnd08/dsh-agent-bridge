/** Folds the tool calls between two pieces of assistant text into one row, and finds the words of that row. */
import type { TimelineItem, TimelineMessage } from './timeline.ts'
import type { Translate } from './ToolCard.tsx'

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>

/** What a fold can hold. */
export type RunItem = Extract<TimelineItem, { kind: 'tool' | 'thinking' | 'todos' }>

/** Consecutive work of one assistant turn, drawn as one row. */
export interface ToolRun {
  readonly kind: 'run'
  readonly id: string
  readonly items: readonly RunItem[]
}

/** A timeline message whose tool calls can be folded. */
export interface FoldedMessage extends Omit<TimelineMessage, 'items'> {
  readonly items: readonly (TimelineItem | ToolRun)[]
}

type WorkKind = 'command' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'other'

const COMMAND_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'command'])
const WORK_KINDS: Readonly<Record<string, WorkKind>> = {
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', fileChange: 'edit',
  Read: 'read', Glob: 'search', Grep: 'search', LS: 'search',
  WebFetch: 'web', WebSearch: 'web', Agent: 'agent', Task: 'agent',
}
/** Calls that only manage the agent's own session; the user gains nothing from a row for them. */
const INTERNAL_TOOL = /^(ToolSearch$|mcp__ccd_turn__|mcp__ccd_session__mark_chapter$)/

/** Pull a string argument. */
export function argOf(args: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = args?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * @param name - tool name as the engine wrote it.
 * @returns the last part of an MCP tool name; other names stay the same.
 */
export function shortToolName(name: string): string {
  if (name === 'command') return 'Bash'
  return name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name
}

/**
 * One-line description of a tool call.
 * @param name - tool name.
 * @param args - structured input, when the engine supplied it.
 * @param fallback - text summary of the input; raw JSON is left out.
 * @returns the text shown beside the tool name.
 */
export function summarizeTool(name: string, args: Readonly<Record<string, unknown>> | undefined, fallback: string): string {
  const pick = COMMAND_TOOLS.has(name)
    ? argOf(args, 'description') ?? argOf(args, 'command')
    : argOf(args, 'action_summary') ?? argOf(args, 'file_path') ?? argOf(args, 'path') ?? argOf(args, 'pattern') ?? argOf(args, 'url') ?? argOf(args, 'query')
      ?? argOf(args, 'description') ?? argOf(args, 'prompt') ?? argOf(args, 'command')
  const text = pick ?? (/^\s*[{[]/.test(fallback) ? '' : fallback)
  return text.split('\n')[0] ?? ''
}

/**
 * @param item - one tool call.
 * @returns the name and description of the call, for a row title.
 */
export function toolLine(item: ToolItem): string {
  if (item.use === undefined) return (item.result?.text ?? '').split('\n')[0] ?? ''
  return `${shortToolName(item.use.name)}  ${summarizeTool(item.use.name, item.use.args, item.use.input)}`.trim()
}

function isHidden(item: RunItem): boolean {
  return item.kind === 'tool' && item.use !== undefined && item.result?.isError !== true && INTERNAL_TOOL.test(item.use.name)
}

function isRunItem(item: TimelineItem): item is RunItem {
  return item.kind !== 'text'
}

function toolsOf(items: readonly RunItem[]): ToolItem[] {
  return items.filter((item): item is ToolItem => item.kind === 'tool')
}

/** @param verb - Git command. @returns a pattern that also accepts `git -C <folder>` and `git -c <setting>`. */
function gitCommand(verb: string): RegExp {
  return new RegExp(`\\bgit\\s+(?:-[Cc]\\s+(?:"[^"]*"|'[^']*'|\\S+)\\s+)*${verb}\\b`)
}

interface Outcome {
  readonly key: 'tools.prCreated' | 'tools.prMerged' | 'tools.committed' | 'tools.pushed'
  readonly n?: string
}

/** Results that a person looks for in a run. A pull request is the end of the work, so it replaces commit and push. */
function outcomesOf(items: readonly RunItem[]): Outcome[] {
  const pullRequests: Outcome[] = []
  const commits = new Set<Outcome['key']>()
  for (const { use, result } of toolsOf(items)) {
    if (use === undefined || result === undefined || result.isError === true || !COMMAND_TOOLS.has(use.name)) continue
    const command = argOf(use.args, 'command') ?? use.input
    if (/\bgh\s+pr\s+create\b/.test(command)) {
      const n = /\/pull\/(\d+)/.exec(result.text)?.[1]
      if (n !== undefined) pullRequests.push({ key: 'tools.prCreated', n })
    }
    if (/\bgh\s+pr\s+merge\b/.test(command)) {
      const n = /\bgh\s+pr\s+merge\s+(\d+)/.exec(command)?.[1] ?? /(?:\/pull\/|#)(\d+)/.exec(result.text)?.[1]
      if (n !== undefined) pullRequests.push({ key: 'tools.prMerged', n })
    }
    if (gitCommand('commit').test(command)) commits.add('tools.committed')
    if (gitCommand('push').test(command)) commits.add('tools.pushed')
  }
  return pullRequests.length > 0 ? pullRequests : [...commits].map(key => ({ key }))
}

function workKind(name: string): WorkKind {
  return COMMAND_TOOLS.has(name) ? 'command' : WORK_KINDS[name] ?? 'other'
}

/**
 * Words of a finished run: its results if it has any, else its largest kinds of work.
 * @param items - the run.
 * @param t - translator.
 * @returns the title.
 */
export function runTitle(items: readonly RunItem[], t: Translate): string {
  const comma = t('tools.comma')
  const outcomes = outcomesOf(items)
  if (outcomes.length > 0) return outcomes.map(({ key, n }) => n === undefined ? t(key) : t(key, { n })).join(comma)
  const counts = new Map<WorkKind, number>()
  for (const { use } of toolsOf(items)) {
    const kind = use === undefined ? 'other' : workKind(use.name)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const kinds = [...counts].sort((a, b) => b[1] - a[1]).map(([kind]) => t(`tools.kind.${kind}`))
  const title = kinds.slice(0, 3).map((label, index) => index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)).join(comma)
  return kinds.length > 3 ? t('tools.more', { title }) : title
}

/**
 * @param items - the run.
 * @returns the newest call, which a run that is still working shows.
 */
export function activeLine(items: readonly RunItem[]): string {
  const last = toolsOf(items).at(-1)
  return last === undefined ? '' : toolLine(last)
}

function finish(id: string, items: readonly RunItem[]): readonly (RunItem | ToolRun)[] {
  const tools = toolsOf(items)
  if (tools.length === 0 || (tools.length === 1 && items.length === 1 && outcomesOf(items).length === 0)) return items
  return [{ kind: 'run', id, items }]
}

/**
 * Fold the work between two pieces of text. An engine writes each call as its own message, so a run crosses messages.
 * A run of one call stays an ordinary row, unless it has a result to name.
 * @param messages - messages from `buildTimeline`.
 * @returns the messages to draw; a message left with nothing is removed.
 */
export function foldToolRuns(messages: readonly TimelineMessage[]): FoldedMessage[] {
  const folded: { message: TimelineMessage; items: (TimelineItem | ToolRun)[] }[] = []
  let open: { owner: (TimelineItem | ToolRun)[]; id: string; items: RunItem[] } | undefined
  const close = (): void => {
    if (open !== undefined) open.owner.push(...finish(open.id, open.items))
    open = undefined
  }
  for (const message of messages) {
    const entry: (typeof folded)[number] = { message, items: [] }
    folded.push(entry)
    if (message.role !== 'assistant' || message.switchedTo !== undefined) close()
    if (message.role !== 'assistant') {
      entry.items.push(...message.items)
      continue
    }
    message.items.forEach((item, index) => {
      if (!isRunItem(item)) {
        close()
        entry.items.push(item)
      } else if (!isHidden(item)) {
        open ??= { owner: entry.items, id: `${message.id}:${String(index)}`, items: [] }
        open.items.push(item)
      }
    })
  }
  close()
  return folded.filter(entry => entry.items.length > 0).map(({ message, items }) => ({ ...message, items }))
}
