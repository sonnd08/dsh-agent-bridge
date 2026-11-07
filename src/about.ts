/**
 * What the bridge is connected to: the plugin and dsh versions, each engine's executable and version, and
 * the versions this plugin release was verified with.
 * @module dsh-agent-bridge/about
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AboutWire, EngineAboutWire, EngineName } from './protocol.ts'

/**
 * Versions this plugin release was run against. A version outside these lists may work; the settings tab
 * marks it as not verified.
 */
export const VERIFIED = {
  dsh: ['0.2.1', '0.2.2-rc.1'],
  claude: ['2.1.319'],
  codex: ['0.165.0'],
  pi: ['1.4.0'],
} as const satisfies Record<'dsh' | EngineName, readonly string[]>

/** Settings fields the tab reports. Executables are already resolved to paths where a match was found. */
export interface AboutSettings {
  readonly claudeExecutable: string
  readonly codexExecutable: string
  readonly piExecutable: string
  readonly codexEnabled: boolean
  readonly piEnabled: boolean
}

/** Runs `<executable> --version` and returns its output; rejects when the executable cannot run. */
export type VersionRunner = (executable: string) => Promise<string>

const VERSION_TIMEOUT_MS = 10_000

/**
 * Run `<executable> --version`.
 * @param executable - path or bare command name.
 * @returns standard output.
 */
export const runVersion: VersionRunner = executable => new Promise((resolve, reject) => {
  execFile(executable, ['--version'], { timeout: VERSION_TIMEOUT_MS }, (error, stdout) => {
    if (error === null) resolve(stdout)
    else reject(error)
  })
})

/**
 * Pick the version number out of a `--version` line such as `2.1.319 (Claude Code)` or `codex-cli 0.165.0`.
 * @param output - the command's output.
 * @returns the first dotted version, or the trimmed first line when none is found.
 */
export function parseVersion(output: string): string {
  return /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(output)?.[0] ?? output.trim().split('\n')[0] ?? ''
}

interface PackageJson {
  version: string
  dependencies?: Record<string, string>
}

function readPackage(): PackageJson {
  // src/about.ts and the bundled lib/index.js both sit one folder below the package root.
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageJson
}

/**
 * Version of the running dsh. The desktop window's host sets `DSH_CLIENT_VERSION`; `dsh web` from the same app
 * does not, so the version of the `dsh-desktop-host` package the process started from is used instead.
 * @param env - process environment.
 * @param argv - process arguments; `argv[1]` is the started script.
 * @returns the version, or undefined when neither source has one.
 */
export function dshVersion(env: NodeJS.ProcessEnv, argv: readonly string[]): string | undefined {
  const fromEnv = env['DSH_CLIENT_VERSION']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const entry = argv[1]
  if (entry === undefined || !entry.includes('dsh-desktop-host')) return undefined
  try {
    return (JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as Partial<PackageJson>).version
  } catch { /* the started script is not inside an installed package: the version stays unknown */
    return undefined
  }
}

async function engineAbout(engine: EngineName, executable: string, enabled: boolean, run: VersionRunner): Promise<EngineAboutWire> {
  const base = { engine, enabled, executable, verified: VERIFIED[engine] }
  try {
    return { ...base, version: parseVersion(await run(executable)) }
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error) }
  }
}

/**
 * Collect the tab's facts. The engines are asked in parallel; one that fails to start reports its error.
 * @param settings - resolved executables and engine switches.
 * @param env - process environment (see {@link dshVersion}).
 * @param run - version command runner.
 * @param argv - process arguments (see {@link dshVersion}).
 * @returns plugin, dsh and engine versions with the verified lists.
 */
export async function readAbout(
  settings: AboutSettings, env: NodeJS.ProcessEnv = process.env, run: VersionRunner = runVersion, argv: readonly string[] = process.argv,
): Promise<AboutWire> {
  const pkg = readPackage()
  const dsh = dshVersion(env, argv)
  const engines = await Promise.all([
    engineAbout('claude', settings.claudeExecutable, true, run),
    engineAbout('codex', settings.codexExecutable, settings.codexEnabled, run),
    engineAbout('pi', settings.piExecutable, settings.piEnabled, run),
  ])
  return {
    plugin: pkg.version,
    ...dsh === undefined ? {} : { dsh },
    dshVerified: VERIFIED.dsh,
    sdk: pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'] ?? '',
    engines,
  }
}
