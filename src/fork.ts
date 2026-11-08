/**
 * Helpers for a fork. Claude and Codex copy their own threads; this module finds the cut for a running Claude turn and
 * rebuilds the link of a conversation that continues across providers.
 * @module dsh-agent-bridge/fork
 */
import type { ThreadLink } from './links.ts'
import type { MessageWire, SessionRowWire } from './protocol.ts'

/**
 * Where a fork of a running turn ends. The fork leaves the unfinished turn out, as Codex and DSH do.
 * Claude can write the opening message of a turn late; until then the transcript holds only completed turns.
 * @param messages - transcript, oldest first.
 * @param prompt - text of the running turn.
 * @returns the last message to copy, an empty object to copy everything, or undefined when no turn has completed.
 */
export function completedPrefix(messages: readonly MessageWire[], prompt: string): { readonly upToMessageId?: string } | undefined {
  const opening = messages.findLastIndex(message => message.role === 'user' && message.blocks.some(block => block.type === 'text'))
  const written = opening !== -1 && messages[opening]?.blocks.some(block => block.type === 'text' && block.text.trim() === prompt.trim()) === true
  if (!written) return messages.length === 0 ? undefined : {}
  const end = messages[opening - 1]?.id
  return end === undefined ? undefined : { upToMessageId: end }
}

/**
 * Codex does not list a fork before the first message of the fork, so the bridge saves it until Codex lists it.
 * @param listed - rows that the engines list.
 * @param saved - saved forks.
 * @returns all rows, and the saved forks that are still not listed.
 */
export function mergeUnlistedForks(listed: readonly SessionRowWire[], saved: readonly SessionRowWire[]): { rows: SessionRowWire[]; unlisted: SessionRowWire[] } {
  const unlisted = saved.filter(fork => !listed.some(row => row.id === fork.id))
  return { rows: [...listed, ...unlisted], unlisted }
}

/**
 * Link of a forked conversation. Message ids can change in a fork, so a message moves by its position in the thread.
 * @param link - link of the source conversation.
 * @param forks - new thread id of each source thread.
 * @param sources - transcript of each source thread.
 * @param copies - transcript of each new thread.
 * @returns the link of the new threads.
 */
export function forkedLink(
  link: ThreadLink,
  forks: Readonly<Record<string, string>>,
  sources: Readonly<Record<string, readonly MessageWire[]>>,
  copies: Readonly<Record<string, readonly MessageWire[]>>,
): ThreadLink {
  const fork = (thread: string): string => forks[thread] ?? thread
  const moved = (thread: string, message: string): string | undefined => {
    const at = sources[thread]?.findIndex(item => item.id === message) ?? -1
    return at === -1 ? undefined : copies[fork(thread)]?.[at]?.id
  }
  return {
    threads: Object.fromEntries(Object.entries(link.threads).map(([provider, thread]) => [provider, fork(thread)])),
    active: fork(link.active),
    delivered: Object.fromEntries(Object.entries(link.delivered).flatMap(([thread, message]) => {
      const target = moved(thread, message)
      return target === undefined ? [] : [[fork(thread), target]]
    })),
    // An empty position keeps the rest of that thread in the merged transcript, as for an unreadable message in the source.
    ...link.segments === undefined ? {} : { segments: link.segments.map(segment => ({ thread: fork(segment.thread), through: moved(segment.thread, segment.through) ?? '' })) },
  }
}
