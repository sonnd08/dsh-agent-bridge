/**
 * Session ids of the external engines, and the keys that the routes build from them.
 * @module dsh-agent-bridge/engine-id
 */
import { CLAUDE_ID_PREFIX, CODEX_ID_PREFIX, instanceOfSession, PI_ID_PREFIX, withInstanceId, type EngineName } from './protocol.ts'

/** An external session id split into its engine and the engine's own id. */
export interface EngineId {
  readonly engine: EngineName
  readonly raw: string
  /** Added provider instance, when the session belongs to one. */
  readonly instance?: string
}

/** @param id - a session id. @returns its parts; undefined when the id names no external engine. */
export function parseId(id: string): EngineId | undefined {
  const split = (engine: EngineName, rest: string): EngineId => {
    const instance = instanceOfSession(id)
    return instance === undefined ? { engine, raw: rest } : { engine, raw: rest.slice(instance.length + 2), instance }
  }
  if (id.startsWith(CLAUDE_ID_PREFIX)) return split('claude', id.slice(CLAUDE_ID_PREFIX.length))
  if (id.startsWith(CODEX_ID_PREFIX)) return split('codex', id.slice(CODEX_ID_PREFIX.length))
  if (id.startsWith(PI_ID_PREFIX)) return split('pi', id.slice(PI_ID_PREFIX.length))
  return undefined
}

const ID_PREFIXES: Readonly<Record<EngineName, string>> = { claude: CLAUDE_ID_PREFIX, codex: CODEX_ID_PREFIX, pi: PI_ID_PREFIX }

/** @param engine - the engine. @param raw - the engine's own id. @param instance - the added instance. @returns the session id. */
export function prefixed(engine: EngineName, raw: string, instance?: string): string {
  const id = `${ID_PREFIXES[engine]}${raw}`
  return instance === undefined ? id : withInstanceId(id, instance)
}

/** @param wanted - the `engine` query of the info route. @returns the engine; Claude unless Codex or Pi is named. */
export function infoEngine(wanted: string): EngineName {
  return wanted === 'codex' || wanted === 'pi' ? wanted : 'claude'
}

/** @param engine - the engine. @param instance - the added instance. @returns the start of the cache keys of that provider. */
export function infoCachePrefix(engine: string, instance: string | undefined): string {
  return `${engine}:${instance ?? ''}:`
}

/**
 * Forget what is cached for one provider; other providers and instances keep their answers.
 * @param cache - the info cache, by {@link infoCachePrefix} and folder.
 * @param engine - the engine.
 * @param instance - the added instance.
 */
export function dropCachedInfo(cache: Map<string, unknown>, engine: string, instance: string | undefined): void {
  const prefix = infoCachePrefix(engine, instance)
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key)
}
