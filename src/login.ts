/**
 * Reads the sign-in state of an engine and runs the engine's own sign-in command. The command opens the browser and
 * saves the credentials itself, so the plugin never sees them.
 * @module dsh-agent-bridge/login
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { resolveCommand } from './commands.ts'
import { expandHome } from './instances.ts'
import { providerId, type LoginFlowWire, type LoginWire, type ProviderInstanceWire } from './protocol.ts'

/** Time that the user has to finish a sign-in in the browser. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000
const STATUS_TIMEOUT_MS = 15_000
const ERROR_LIMIT = 300
const OUTPUT_LIMIT = 16_000

// eslint-disable-next-line no-control-regex -- the engine writes terminal colors.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const SIGNED_OUT_TURN = /not logged in|please run \/login|authentication_failed|codex login|\b401\b.*unauthorized/i

/** How to ask one engine about its sign-in. */
export interface EngineLogin {
  readonly engine: 'claude' | 'codex'
  readonly executable: string
  /** Environment of the command; an added instance sets its own folder here. */
  readonly env: NodeJS.ProcessEnv
}

/**
 * @param engine - the engine.
 * @param executable - its command.
 * @param home - the separate folder of an added instance.
 * @returns how to ask that engine about its sign-in.
 */
export function engineLogin(engine: 'claude' | 'codex', executable: string, home: string | undefined): EngineLogin {
  const folder = home === undefined ? {} : { [engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: home }
  return { engine, executable, env: { ...process.env, ...folder } }
}

/** The executables and instances that {@link loginTarget} chooses from. */
export interface LoginTargetDeps {
  readonly claudeExecutable: string
  readonly codexExecutable: string
  /** @param id - an added instance. @returns the instance; throws when it is unknown. */
  findInstance(id: string): ProviderInstanceWire
}

/**
 * Find how to sign in to a provider.
 * @param wanted - the engine that the request names.
 * @param instance - the added instance that the request names.
 * @param deps - the executables and instances.
 * @returns the key of the attempt and how to ask the engine; undefined when the engine has no sign-in command.
 */
export function loginTarget(wanted: string, instance: string | undefined, deps: LoginTargetDeps): { readonly key: string; readonly login: EngineLogin } | undefined {
  if (wanted !== 'claude' && wanted !== 'codex') return undefined
  const item = instance === undefined ? undefined : deps.findInstance(instance)
  const executable = item?.binaryPath === undefined ? wanted === 'claude' ? deps.claudeExecutable : deps.codexExecutable : resolveCommand(item.binaryPath)
  return { key: providerId(wanted, instance), login: engineLogin(wanted, executable, item === undefined ? undefined : expandHome(item.home)) }
}

/**
 * @param engine - the engine.
 * @param output - what `claude auth status` or `codex login status` wrote.
 * @param exitCode - the exit code of the command.
 * @returns the sign-in state; `signedIn` is absent when the output gives no clear answer.
 */
export function parseLoginStatus(engine: 'claude' | 'codex', output: string, exitCode: number): Pick<LoginWire, 'signedIn' | 'plan'> {
  if (engine === 'codex') {
    if (exitCode === 0) return { signedIn: true }
    return /not logged in/i.test(output) ? { signedIn: false } : {}
  }
  try {
    const report = JSON.parse(output) as { loggedIn?: unknown; subscriptionType?: unknown }
    if (typeof report.loggedIn !== 'boolean') return {}
    return { signedIn: report.loggedIn, ...typeof report.subscriptionType === 'string' ? { plan: report.subscriptionType } : {} }
  } catch (error) {
    if (error instanceof SyntaxError) return {}
    throw error
  }
}

/**
 * Ask the engine if it is signed in.
 * @param login - the engine.
 * @returns the sign-in state; `signedIn` is absent when the command cannot run or gives no clear answer.
 */
export function readLoginStatus(login: EngineLogin): Promise<Pick<LoginWire, 'signedIn' | 'plan'>> {
  const args = login.engine === 'claude' ? ['auth', 'status'] : ['login', 'status']
  return new Promise((resolve) => {
    execFile(login.executable, args, { env: login.env, timeout: STATUS_TIMEOUT_MS }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : undefined
      resolve(code === undefined ? {} : parseLoginStatus(login.engine, `${stdout}\n${stderr}`.trim(), code))
    })
  })
}

/**
 * @param name - the engine's name.
 * @param error - the error of a failed turn.
 * @returns text that tells the user how to sign in when the engine is signed out, and otherwise the same error.
 */
export function explainTurnError(name: string, error: string): string {
  return SIGNED_OUT_TURN.test(error) ? `${name} is not signed in. Select Sign in above the message box, then send your message again.` : error
}

interface Flow {
  state: LoginFlowWire['state']
  url?: string
  error?: string
  output: string
  readonly child: ChildProcess
  readonly timer: NodeJS.Timeout
}

function lastLine(output: string): string {
  return output.replace(ANSI, '').split('\n').map(line => line.trim()).filter(line => line !== '').at(-1)?.slice(0, ERROR_LIMIT) ?? ''
}

function wire(flow: Flow): LoginFlowWire {
  return { state: flow.state, ...flow.url === undefined ? {} : { url: flow.url }, ...flow.error === undefined ? {} : { error: flow.error } }
}

/**
 * Read the state of a provider for a poll. The credentials do not change while the command waits for the browser, so a poll during a running attempt starts no process.
 * @param flows - the attempts.
 * @param key - the provider.
 * @param login - the engine.
 * @param readStatus - asks the engine about its sign-in.
 * @returns the sign-in state and the attempt, if there is one.
 */
export async function pollLogin(flows: Pick<LoginFlows, 'take'>, key: string, login: EngineLogin, readStatus: (login: EngineLogin) => Promise<Pick<LoginWire, 'signedIn' | 'plan'>> = readLoginStatus): Promise<LoginWire> {
  const flow = flows.take(key)
  return { ...flow?.state === 'running' ? {} : await readStatus(login), ...flow === undefined ? {} : { flow } }
}

/** The sign-in commands that run now, one for each provider. */
export class LoginFlows {
  readonly #flows = new Map<string, Flow>()
  readonly #timeoutMs: number

  /** @param timeoutMs - time that the user has to finish a sign-in. */
  constructor(timeoutMs = LOGIN_TIMEOUT_MS) {
    this.#timeoutMs = timeoutMs
  }

  /**
   * Run the sign-in command, unless one already runs for this provider.
   * @param key - the provider.
   * @param login - the engine.
   * @param onSuccess - called after the command signs in.
   * @returns the attempt.
   */
  start(key: string, login: EngineLogin, onSuccess: () => void): LoginFlowWire {
    const running = this.#flows.get(key)
    if (running?.state === 'running') return wire(running)
    const args = login.engine === 'claude' ? ['auth', 'login'] : ['login']
    const child = spawn(login.executable, args, { env: login.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { child.kill() }, this.#timeoutMs)
    const flow: Flow = { state: 'running', output: '', child, timer }
    this.#flows.set(key, flow)
    const read = (chunk: Buffer): void => {
      flow.output = `${flow.output}${chunk.toString()}`.slice(-OUTPUT_LIMIT)
      const page = /https:\/\/[^\s"'<>]+/.exec(flow.output.replace(ANSI, ''))?.[0]
      if (flow.url === undefined && page !== undefined) flow.url = page
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    const finish = (state: 'succeeded' | 'failed', error: string | undefined): void => {
      clearTimeout(timer)
      if (flow.state !== 'running') return
      flow.state = state
      if (error !== undefined) flow.error = error
      if (state === 'succeeded') onSuccess()
    }
    child.on('error', (error) => { finish('failed', error.message) })
    child.on('close', (code) => {
      if (code === 0) finish('succeeded', undefined)
      else finish('failed', lastLine(flow.output) || `exit code ${String(code)}`)
    })
    return wire(flow)
  }

  /**
   * @param key - the provider.
   * @returns the attempt. A finished attempt is reported one time and then removed.
   */
  take(key: string): LoginFlowWire | undefined {
    const flow = this.#flows.get(key)
    if (flow === undefined) return undefined
    if (flow.state !== 'running') this.#flows.delete(key)
    return wire(flow)
  }

  /** @param key - the provider. Stop its sign-in command and forget the attempt. */
  cancel(key: string): void {
    const flow = this.#flows.get(key)
    if (flow === undefined) return
    this.#flows.delete(key)
    clearTimeout(flow.timer)
    flow.state = 'failed'
    flow.child.kill()
  }

  /** Stop every sign-in command. */
  closeAll(): void {
    for (const key of [...this.#flows.keys()]) this.cancel(key)
  }
}
