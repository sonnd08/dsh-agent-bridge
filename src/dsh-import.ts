/**
 * Turns a Claude or Codex conversation into the event log of a new DSH session, so that the session
 * shows the old messages, images and tool steps, and sends them to the model as real history.
 * @module dsh-agent-bridge/dsh-import
 */
import { randomUUID } from 'node:crypto'
import type { ImageAttachment } from './import-images.ts'
import { ENGINE_TOOL, type MessageWire } from './protocol.ts'

/** Model of the new session; imported replies are recorded under it. */
export interface ImportRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
}

/** One event of a DSH session log, as `agents.create` validates it. */
export interface SeedEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: Record<string, unknown>
  readonly surfaceOp?: 'append'
  readonly sourceEventSeqs?: readonly number[]
}

/** One tool call of an imported turn, with its result. */
export interface ImportTool {
  readonly id: string
  readonly name: string
  readonly input: unknown
  output: string
  isError: boolean
  /** Images that the tool returned, as `data:` URLs. */
  images?: string[]
}

/** The text and the tool calls of one model request. */
export interface ImportStep {
  text: string
  readonly tools: ImportTool[]
}

/** One message that the user wrote and the reply after it. */
export interface ImportTurn {
  readonly user: string
  assistant: string
  /** Images that the user attached, as `data:` URLs. */
  images?: string[]
  /** The steps of the reply; absent when the reply used no tool. */
  steps?: ImportStep[]
}

/** Most characters of text history a new session receives; the newest turns are kept. */
const IMPORT_CHARACTERS = 400_000

/** Most characters of tool calls and results a new session receives; older turns keep only their text. */
const IMPORT_TOOL_CHARACTERS = 300_000

/** Most images a new session receives; the newest images are kept. */
const IMPORT_IMAGES = 100

/** Most characters of the output of one tool call. */
const TOOL_OUTPUT_CHARACTERS = 8_000

/** System message of the imported history, until DSH writes its own system prompt. */
const IMPORT_SYSTEM_TEXT = 'This conversation started with another coding agent. The earlier messages are its history.'

/** Text that shows where an image was when the chat cannot show the image itself. */
const IMAGE_NOTE = '[image]'

/** Result text of a tool call that has no output. */
const NO_OUTPUT = '(no output)'

/** Text that Claude Code adds to a user message, which the user did not write. */
const HARNESS_NOTE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** Line that Claude Code adds after an image, with the local path of the image. */
const IMAGE_SOURCE_NOTE = /^\[Image: source: [^\]\n]*\]$/gm

/** @param message - one message. @returns the images of its own blocks, as `data:` URLs. */
function imagesOf(message: MessageWire): string[] {
  return message.blocks.flatMap(block => block.type === 'image' ? [block.src] : [])
}

/** @param message - one message. @returns its text; tool calls, tool results, thinking and harness notes are left out. */
function textOf(message: MessageWire): string {
  const text = message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').replace(HARNESS_NOTE, '')
  return (imagesOf(message).length > 0 ? text.replace(IMAGE_SOURCE_NOTE, '') : text).trim()
}

function capped(text: string): string {
  return text.length > TOOL_OUTPUT_CHARACTERS ? `${text.slice(0, TOOL_OUTPUT_CHARACTERS)}…` : text
}

/** Add the blocks of one assistant message to the steps of a turn. A text after a tool call starts a new step. */
function addSteps(turn: ImportTurn, message: MessageWire, calls: Map<string, ImportTool>): void {
  const steps = turn.steps ?? []
  turn.steps = steps
  for (const block of message.blocks) {
    if (block.type === 'text') {
      const text = block.text.replace(HARNESS_NOTE, '').trim()
      if (text === '') continue
      const last = steps.at(-1)
      if (last === undefined || last.tools.length > 0) steps.push({ text, tools: [] })
      else last.text = last.text === '' ? text : `${last.text}\n\n${text}`
    } else if (block.type === 'tool_use') {
      if (block.id !== undefined && block.id !== '' && calls.has(block.id)) continue
      const tool: ImportTool = { id: block.id === undefined || block.id === '' ? randomUUID() : block.id, name: block.name, input: block.args ?? block.input, output: '', isError: false }
      calls.set(tool.id, tool)
      const last = steps.at(-1)
      if (last === undefined) steps.push({ text: '', tools: [tool] })
      else last.tools.push(tool)
    }
  }
}

/** Put the results in a user message on their tool calls. */
function addResults(message: MessageWire, calls: ReadonlyMap<string, ImportTool>): void {
  for (const block of message.blocks) {
    if (block.type !== 'tool_result' || block.forId === undefined) continue
    const tool = calls.get(block.forId)
    if (tool === undefined) continue
    const images = block.images ?? []
    tool.output = capped((images.length > 0 ? block.text.replace(IMAGE_SOURCE_NOTE, '') : block.text).trim())
    tool.isError = block.isError === true
    if (images.length > 0) tool.images = [...images]
  }
}

/**
 * Group a transcript by the messages the user wrote.
 * @param messages - transcript, oldest first.
 * @returns all turns, oldest first.
 */
export function allTurns(messages: readonly MessageWire[]): ImportTurn[] {
  const turns: ImportTurn[] = []
  const calls = new Map<string, ImportTool>()
  for (const message of messages) {
    const text = textOf(message)
    if (message.role === 'user') {
      addResults(message, calls)
      const images = imagesOf(message)
      if (text !== '' || images.length > 0) turns.push({ user: text, assistant: '', ...images.length === 0 ? {} : { images } })
      continue
    }
    const current = turns.at(-1)
    if (current === undefined) continue
    if (text !== '') current.assistant = current.assistant === '' ? text : `${current.assistant}\n\n${text}`
    addSteps(current, message, calls)
  }
  for (const turn of turns) {
    if (turn.steps?.some(step => step.tools.length > 0) !== true) delete turn.steps
  }
  return turns
}

/**
 * @param messages - transcript, oldest first.
 * @returns the newest turns that fit the size limit, oldest first.
 */
export function importTurns(messages: readonly MessageWire[]): ImportTurn[] {
  const turns = allTurns(messages)
  let used = 0
  let first = turns.length
  while (first > 0) {
    const turn = turns[first - 1] as ImportTurn
    used += turn.user.length + turn.assistant.length
    if (used > IMPORT_CHARACTERS) break
    first -= 1
  }
  return turns.slice(first)
}

/** @returns the newest turns whose tool calls fit the limit. The other turns keep only their text. */
function turnsWithTools(turns: readonly ImportTurn[]): ReadonlySet<ImportTurn> {
  const kept = new Set<ImportTurn>()
  let used = 0
  for (const turn of [...turns].reverse()) {
    if (turn.steps === undefined) continue
    used += turn.steps.flatMap(step => step.tools).reduce((sum, tool) => sum + tool.output.length + (JSON.stringify(tool.input) ?? '').length, 0)
    if (used > IMPORT_TOOL_CHARACTERS) break
    kept.add(turn)
  }
  return kept
}

/**
 * @param messages - transcript, oldest first.
 * @returns the images that a new session receives, as `data:` URLs, newest first.
 */
export function importImageSources(messages: readonly MessageWire[]): string[] {
  const turns = importTurns(messages)
  const withTools = turnsWithTools(turns)
  const sources = new Set<string>()
  for (const turn of [...turns].reverse()) {
    const tools = withTools.has(turn) ? (turn.steps ?? []).flatMap(step => step.tools).reverse() : []
    for (const image of [...tools.flatMap(tool => [...tool.images ?? []].reverse()), ...[...turn.images ?? []].reverse()]) {
      if (sources.size >= IMPORT_IMAGES) return [...sources]
      sources.add(image)
    }
  }
  return [...sources]
}

/** @returns the content blocks of a text and its images. An image that was not saved stays as a short note. */
function contentOf(text: string, images: readonly string[], saved: ReadonlyMap<string, ImageAttachment>): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = text === '' ? [] : [{ type: 'text', text }]
  for (const image of images) {
    const attachment = saved.get(image)
    blocks.push(attachment === undefined ? { type: 'text', text: IMAGE_NOTE } : { type: 'image', attachment })
  }
  return blocks.length === 0 ? [{ type: 'text', text: IMAGE_NOTE }] : blocks
}

/**
 * Build the seed of a new DSH session. Every turn is complete, so that the first real message starts a new turn.
 * @param messages - transcript, oldest first, without catch-up blocks.
 * @param route - model of the new session.
 * @param now - time of the events, in milliseconds.
 * @param images - references of the saved images, by `data:` URL.
 * @returns the events, contiguous from seq 0; empty when the transcript has no text.
 */
export function importEvents(messages: readonly MessageWire[], route: ImportRoute, now: number, images: ReadonlyMap<string, ImageAttachment> = new Map()): SeedEvent[] {
  const events: SeedEvent[] = []
  const append = (type: string, data: Record<string, unknown>, surface = false, sourceEventSeqs?: readonly number[]): number => {
    const seq = events.length
    events.push({ type, seq, time: now, data, ...surface ? { surfaceOp: 'append' as const } : {}, ...sourceEventSeqs === undefined ? {} : { sourceEventSeqs } })
    return seq
  }
  const { provider, model, reasoningEffort } = route
  const assistantMessage = (turn: number, step: number, content: readonly Record<string, unknown>[]): void => {
    append('assistant/message', { turn, step, message: { id: randomUUID(), role: 'assistant', content, source: { kind: 'model', provider, model } }, stream: [] }, true)
  }
  const turns = importTurns(messages)
  const withTools = turnsWithTools(turns)
  turns.forEach((item, index) => {
    const { user, assistant } = item
    const turn = index + 1
    append('turn/start', { turn })
    append('step/start', { turn, step: 1 })
    // DSH refuses to reload a log whose first surface message is not a system message; the first real step replaces this text.
    if (index === 0) append('system/message', { turn, step: 1, message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text: IMPORT_SYSTEM_TEXT }], source: { kind: 'system-prompt' } } }, true)
    append('user/message', { id: randomUUID(), role: 'user', content: contentOf(user, item.images ?? [], images), source: { kind: 'user', rpcId: randomUUID() } }, true)
    if (index === 0) append('request/header', { header: { config: { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } } }, reason: 'initial' })
    if (item.steps !== undefined && withTools.has(item)) {
      item.steps.forEach((step, stepIndex) => {
        const number = stepIndex + 1
        if (stepIndex > 0) append('step/start', { turn, step: number })
        const calls = step.tools.map(tool => ({ tool, callId: tool.id, argumentsText: JSON.stringify({ tool: tool.name, input: tool.input }) }))
        assistantMessage(turn, number, [
          ...step.text === '' ? [] : [{ type: 'text', text: step.text }],
          ...calls.map(({ callId, argumentsText }) => ({ type: 'tool-call', id: callId, name: ENGINE_TOOL, arguments: argumentsText })),
        ])
        for (const { tool, callId, argumentsText } of calls) {
          const callSeq = append('tool/call', { turn, step: number, callId, name: ENGINE_TOOL, arguments: argumentsText })
          const text = tool.output === '' && tool.images === undefined ? NO_OUTPUT : tool.output
          append('tool/result', {
            turn, step: number,
            message: { id: randomUUID(), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: contentOf(tool.isError ? `Error: ${text}` : text, tool.images ?? [], images), isError: tool.isError },
          }, true, [callSeq])
        }
        append('step/end', { turn, step: number })
      })
    } else {
      if (assistant !== '') assistantMessage(turn, 1, [{ type: 'text', text: assistant }])
      append('step/end', { turn, step: 1 })
    }
    append('turn/end', { turn, reason: { kind: 'completed' } })
  })
  return events
}
