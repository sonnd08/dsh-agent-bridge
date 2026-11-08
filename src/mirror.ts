/**
 * Decides which Claude Code and Codex chats become DSH chats, and which of their turns a DSH chat has not shown yet.
 * @module dsh-agent-bridge/mirror
 */
import type { ImportTurn } from './dsh-import.ts'

/** A chat is imported or updated only after its file has not changed for this time, so that a running turn is not cut. */
export const MIRROR_QUIET_MS = 20_000

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
export interface MirrorReplay { readonly user: string; readonly assistant: string; readonly synced: number }

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
    if (turn.assistant !== '') return { user: turn.user, assistant: turn.assistant, synced: index + 1 }
  }
  return undefined
}
