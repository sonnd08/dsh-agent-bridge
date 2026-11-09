/**
 * Applies the permission level of a DSH chat to the tool calls that Claude Code and Codex ask to run. An engine asks only
 * for calls that it does not consider safe, so a call that reaches this module changes something or runs a program.
 * @module dsh-agent-bridge/engine-access
 */
import { isAbsolute, relative, resolve } from 'node:path'

/** One tool call of an engine, as the proxy tool records it. */
export interface EngineToolCall { readonly tool: string; readonly input?: unknown }

const CLAUDE_FILE_TOOLS: readonly string[] = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']
const CODEX_FILE_TOOL = 'fileChange'

/** @param call - the tool call. @returns the files that it changes; undefined when it is not a file change. */
function changedPaths(call: EngineToolCall): readonly string[] | undefined {
  const input = (call.input ?? {}) as { file_path?: unknown; notebook_path?: unknown; paths?: unknown }
  if (call.tool === CODEX_FILE_TOOL) return Array.isArray(input.paths) ? input.paths.filter((path): path is string => typeof path === 'string') : undefined
  if (!CLAUDE_FILE_TOOLS.includes(call.tool)) return undefined
  const path = input.file_path ?? input.notebook_path
  return typeof path === 'string' ? [path] : undefined
}

function isInside(folder: string, path: string): boolean {
  const offset = relative(resolve(folder), resolve(folder, path))
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset))
}

const PLAIN_READ = /^(?:\/bin\/(?:ba|z)?sh -lc ')?(?:tail|head|cat|sed -n) [^;&|`$<>\n'"]*?'?$/

/**
 * @param call - the tool call.
 * @param trusted - a folder of files that the bridge wrote for the engine.
 * @returns whether the call only reads a file in that folder. A command must be one plain read with no shell operators.
 */
export function readsTrustedFile(call: EngineToolCall, trusted: string): boolean {
  const inside = (path: string): boolean => isAbsolute(path) && isInside(trusted, path)
  const input = (call.input ?? {}) as { command?: unknown; file_path?: unknown }
  if (call.tool === 'Read') return typeof input.file_path === 'string' && inside(input.file_path)
  if (typeof input.command !== 'string' || !PLAIN_READ.test(input.command)) return false
  const paths = input.command.split(/\s+/).map(word => word.replace(/'$/, '')).filter(word => word.startsWith('/') && word !== '/bin/zsh' && word !== '/bin/bash' && word !== '/bin/sh')
  return paths.length > 0 && paths.every(inside)
}

/**
 * Decide if a call can run with no question.
 * @param mode - the sandbox mode of the chat; undefined when DSH does not know it.
 * @param policy - the approval policy of the chat. Full access with `ask` is the Auto level, where a reviewer decides.
 * @param call - the tool call.
 * @param cwd - the working folder of the chat.
 * @returns `allow`, or `ask` when the user or the reviewer must decide. An unknown mode asks.
 */
export function accessOf(mode: string | undefined, policy: string | undefined, call: EngineToolCall, cwd: string): 'allow' | 'ask' {
  if (mode === 'danger-full-access') return policy === 'never' ? 'allow' : 'ask'
  if (mode !== 'workspace-write') return 'ask'
  const paths = changedPaths(call)
  return paths !== undefined && paths.length > 0 && paths.every(path => isInside(cwd, path)) ? 'allow' : 'ask'
}

/** What the decision needs from DSH. */
export interface EngineAccessServices {
  /** @returns the sandbox mode of the chat. */
  readonly modeOf: () => string | undefined
  /** @returns the approval policy of the chat. */
  readonly policyOf: () => string | undefined
  /** The folder of the handoff files that the bridge writes for the next engine. */
  readonly trustedFolder: string
  /** @returns the answer of the user, as the DSH approval service gives it. */
  readonly ask: (reason: string) => Promise<string>
}

/**
 * @param call - the tool call.
 * @returns the text that the approval question shows.
 */
export function accessQuestion(call: EngineToolCall): string {
  const input = (call.input ?? {}) as { command?: unknown }
  const paths = changedPaths(call)
  if (typeof input.command === 'string') return `Run this command: ${input.command}`
  if (paths !== undefined && paths.length > 0) return `Change ${paths.join(', ')}`
  return `Use the tool ${call.tool}`
}

/**
 * Decide if a call can run, and ask the user when the permission level requires it. An error gives a refusal.
 * @param services - the DSH services of the chat.
 * @param call - the tool call.
 * @param cwd - the working folder of the chat.
 * @returns true when the engine can run the call.
 */
export async function authorizeEngineCall(services: EngineAccessServices, call: EngineToolCall, cwd: string): Promise<boolean> {
  try {
    if (readsTrustedFile(call, services.trustedFolder) || accessOf(services.modeOf(), services.policyOf(), call, cwd) === 'allow') return true
    return await services.ask(accessQuestion(call)) === 'allowed-once'
  } catch (error) {
    console.warn('agent-bridge: approval failed, so the tool call is refused', error)
    return false
  }
}
