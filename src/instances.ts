/**
 * Added provider instances: validation of what the settings page sends, and the helpers that start them.
 * @module dsh-agent-bridge/instances
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveCommand } from './commands.ts'
import { DEFAULT_PROVIDER_IDS, type ProviderInstanceWire } from './protocol.ts'

const ID = /^[A-Za-z0-9_-]{1,40}$/
const ACCENT = /^#[0-9a-fA-F]{6}$/
const MAX_TEXT = 1000

/** Result of validating a new instance. */
export type ParsedInstance = { readonly instance: ProviderInstanceWire } | { readonly error: string }

/**
 * Validate an instance from the settings page.
 * @param value - request body field.
 * @param existing - instances already stored.
 * @returns the instance, or the reason it was refused.
 */
export function parseInstance(value: unknown, existing: readonly ProviderInstanceWire[]): ParsedInstance {
  if (typeof value !== 'object' || value === null) return { error: 'invalid provider' }
  const { id, engine, label, accent, binaryPath, home, launchArgs } = value as Record<string, unknown>
  if (engine !== 'claude' && engine !== 'codex') return { error: 'the provider must be Claude or Codex' }
  if (typeof id !== 'string' || !ID.test(id)) return { error: "the instance ID can use letters, digits, '-' or '_'" }
  if (DEFAULT_PROVIDER_IDS.includes(id) || existing.some(item => item.id === id)) return { error: `the instance ID ${id} is already in use` }
  if (typeof label !== 'string' || label.trim() === '' || label.length > 80) return { error: 'enter a label' }
  if (typeof home !== 'string' || home.trim() === '' || home.length > MAX_TEXT) return { error: 'enter a home folder for this instance' }
  if (!home.startsWith('/') && !home.startsWith('~/')) return { error: 'the home folder must start with / or ~/' }
  if (accent !== undefined && (typeof accent !== 'string' || !ACCENT.test(accent))) return { error: 'invalid accent color' }
  if (binaryPath !== undefined && (typeof binaryPath !== 'string' || binaryPath.length > MAX_TEXT)) return { error: 'invalid binary path' }
  if (launchArgs !== undefined && (typeof launchArgs !== 'string' || launchArgs.length > MAX_TEXT)) return { error: 'invalid launch arguments' }
  return {
    instance: {
      id, engine, label: label.trim(), home: home.trim(),
      ...accent === undefined ? {} : { accent },
      ...binaryPath === undefined || binaryPath.trim() === '' ? {} : { binaryPath: binaryPath.trim() },
      ...launchArgs === undefined || launchArgs.trim() === '' ? {} : { launchArgs: launchArgs.trim() },
    },
  }
}

/** @param path - a path that can start with `~/`. @returns the absolute path. */
export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** @param text - launch arguments as typed. @returns one argument per word; no shell runs, so quotes have no meaning. */
export function splitLaunchArgs(text: string | undefined): string[] {
  return text === undefined ? [] : text.trim().split(/\s+/).filter(word => word !== '')
}

/**
 * Launch arguments in the form the Claude Agent SDK takes.
 * @param text - launch arguments as typed.
 * @returns flags without their dashes; a flag that is followed by another flag has the value null.
 */
export function claudeExtraArgs(text: string | undefined): Record<string, string | null> {
  const words = splitLaunchArgs(text)
  const args: Record<string, string | null> = {}
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string
    if (!word.startsWith('--')) continue
    const next = words[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[word.slice(2)] = next
      index += 1
    } else {
      args[word.slice(2)] = null
    }
  }
  return args
}

/**
 * @param item - an added Codex instance.
 * @param defaultExecutable - the command used when the instance names none.
 * @returns how to start its app-server, in its own home folder.
 */
export function codexLaunchOf(item: ProviderInstanceWire, defaultExecutable: string): { readonly executable: string; readonly launch: { readonly env: Readonly<Record<string, string>>; readonly args: readonly string[] } } {
  return { executable: item.binaryPath === undefined ? defaultExecutable : resolveCommand(item.binaryPath), launch: { env: { CODEX_HOME: expandHome(item.home) }, args: splitLaunchArgs(item.launchArgs) } }
}

/**
 * @param item - an added Claude instance.
 * @returns what a turn of that instance adds to the turn options.
 */
export function claudeExtrasOf(item: ProviderInstanceWire): { readonly configDir: string; readonly extraArgs: Record<string, string | null>; readonly executable?: string } {
  return { configDir: expandHome(item.home), extraArgs: claudeExtraArgs(item.launchArgs), ...item.binaryPath === undefined ? {} : { executable: resolveCommand(item.binaryPath) } }
}
