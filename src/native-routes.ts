/**
 * Maps a provider of the model selector to its route in the DSH model catalog.
 * @module dsh-agent-bridge/native-routes
 */

/** Route of the default Claude Code. */
export const CLAUDE_ROUTE = 'claude-code'
/** Route of the default Codex. */
export const CODEX_ROUTE = 'codex-cli'

/** @param provider - `claude`, `codex` or an added instance. @returns its route in the DSH catalog. */
export function routeOf(provider: string): string {
  if (provider === 'claude') return CLAUDE_ROUTE
  return provider === 'codex' ? CODEX_ROUTE : provider
}

/** @param route - provider route of a DSH model selection. @returns the engine whose mark a chat row shows; `dsh` for a harness model. */
export function markOfRoute(route: string | undefined): 'claude' | 'codex' | 'dsh' {
  if (route === CLAUDE_ROUTE || route?.startsWith('claude@') === true) return 'claude'
  return route === CODEX_ROUTE || route?.startsWith('codex@') === true ? 'codex' : 'dsh'
}
