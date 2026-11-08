/**
 * Turns the text of a Claude or Codex conversation into the event log of a new DSH session, so that the session
 * shows the old messages and sends them to the model as real history.
 * @module dsh-agent-bridge/dsh-import
 */
import { randomUUID } from 'node:crypto'
import type { MessageWire } from './protocol.ts'

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
}

interface ImportTurn {
  readonly user: string
  assistant: string
}

/** Most characters of history a new session receives; the newest turns are kept. */
const IMPORT_CHARACTERS = 400_000

/** System message of the imported history, until DSH writes its own system prompt. */
const IMPORT_SYSTEM_TEXT = 'This conversation started with another coding agent. The earlier messages are its history.'

/** @param message - one message. @returns its text blocks; tool calls, tool results and thinking are left out. */
function textOf(message: MessageWire): string {
  return message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
}

/**
 * Group a transcript by the messages the user wrote.
 * @param messages - transcript, oldest first.
 * @returns the newest turns that fit the size limit, oldest first.
 */
export function importTurns(messages: readonly MessageWire[]): ImportTurn[] {
  const turns: ImportTurn[] = []
  for (const message of messages) {
    const text = textOf(message)
    if (text === '') continue
    if (message.role === 'user') {
      turns.push({ user: text, assistant: '' })
      continue
    }
    const current = turns.at(-1)
    if (current !== undefined) current.assistant = current.assistant === '' ? text : `${current.assistant}\n\n${text}`
  }
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

/**
 * Build the seed of a new DSH session. Every turn is complete, so that the first real message starts a new turn.
 * @param messages - transcript, oldest first, without catch-up blocks.
 * @param route - model of the new session.
 * @param now - time of the events, in milliseconds.
 * @returns the events, contiguous from seq 0; empty when the transcript has no text.
 */
export function importEvents(messages: readonly MessageWire[], route: ImportRoute, now: number): SeedEvent[] {
  const events: SeedEvent[] = []
  const append = (type: string, data: Record<string, unknown>, surface = false): void => {
    events.push({ type, seq: events.length, time: now, data, ...surface ? { surfaceOp: 'append' as const } : {} })
  }
  const { provider, model, reasoningEffort } = route
  importTurns(messages).forEach(({ user, assistant }, index) => {
    const turn = index + 1
    append('turn/start', { turn })
    append('step/start', { turn, step: 1 })
    // DSH refuses to reload a log whose first surface message is not a system message; the first real step replaces this text.
    if (index === 0) append('system/message', { turn, step: 1, message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text: IMPORT_SYSTEM_TEXT }], source: { kind: 'system-prompt' } } }, true)
    append('user/message', { id: randomUUID(), role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'user', rpcId: randomUUID() } }, true)
    if (index === 0) append('request/header', { header: { config: { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } } }, reason: 'initial' })
    if (assistant !== '') append('assistant/message', { turn, step: 1, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: assistant }], source: { kind: 'model', provider, model } }, stream: [] }, true)
    append('step/end', { turn, step: 1 })
    append('turn/end', { turn, reason: { kind: 'completed' } })
  })
  return events
}
