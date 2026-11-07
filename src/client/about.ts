/**
 * Rows of the Agent Bridge settings tab, derived from the host's about response.
 * @module dsh-agent-bridge/client/about
 */
import type { AboutWire, EngineName } from '../protocol.ts'

/** How a row's running version relates to the versions this release was verified with. */
export type AboutStatus = 'verified' | 'unverified' | 'missing' | 'off' | 'unknown'

/** One row of the tab. */
export interface AboutRow {
  /** `dsh`, or the engine. */
  readonly id: 'dsh' | EngineName
  /** Running version; absent when it could not be read. */
  readonly version?: string
  /** Executable the plugin starts (engines only). */
  readonly executable?: string
  /** Start error of the executable (engines only). */
  readonly error?: string
  readonly verified: readonly string[]
  readonly status: AboutStatus
}

/**
 * Turn the about response into tab rows: dsh first, then each engine.
 * A disabled engine reads `off` even when its executable runs; one that cannot run reads `missing`.
 * @param about - the host's response.
 * @returns rows in display order.
 */
export function aboutRows(about: AboutWire): AboutRow[] {
  const statusOf = (version: string | undefined, verified: readonly string[]): AboutStatus =>
    version === undefined ? 'unknown' : verified.includes(version) ? 'verified' : 'unverified'
  return [
    { id: 'dsh', ...about.dsh === undefined ? {} : { version: about.dsh }, verified: about.dshVerified, status: statusOf(about.dsh, about.dshVerified) },
    ...about.engines.map((engine): AboutRow => ({
      id: engine.engine,
      executable: engine.executable,
      ...engine.version === undefined ? {} : { version: engine.version },
      ...engine.error === undefined ? {} : { error: engine.error },
      verified: engine.verified,
      status: !engine.enabled ? 'off' : engine.error !== undefined ? 'missing' : statusOf(engine.version, engine.verified),
    })),
  ]
}
