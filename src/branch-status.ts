/**
 * Finds whether the branch of a session is merged. A pull request decides first, because a squash merge leaves no
 * shared commit; without one, only commits that the default branch does not have prove "not merged".
 * @module dsh-agent-bridge/branch-status
 */
import type { BranchStateWire } from './protocol.ts'

/** Runs a command in a folder; rejects if the command fails. */
export type RunCommand = (command: 'git' | 'gh', args: readonly string[], cwd: string) => Promise<string>

/** One row of `gh pr list`. */
export interface PullRequestRow {
  readonly headRefName: string
  readonly state: string
  readonly mergedAt?: string | null | undefined
}

/** Milliseconds that one answer stays valid. */
const CACHE_MS = 120_000
const PULL_REQUEST_LIMIT = '200'

/**
 * State of a branch from its pull requests. An open pull request wins over an older merged one of the same branch.
 * @param rows - pull requests of the repository.
 * @param branch - branch name.
 * @returns the state, or undefined when no open or merged pull request names the branch.
 */
export function pullRequestState(rows: readonly PullRequestRow[], branch: string): BranchStateWire | undefined {
  const own = rows.filter(row => row.headRefName === branch)
  if (own.some(row => row.state.toUpperCase() === 'OPEN')) return 'open'
  return own.some(row => row.state.toUpperCase() === 'MERGED' || (row.mergedAt ?? '') !== '') ? 'merged' : undefined
}

/** Reads branch states and keeps them for a short time, so that a long session list does not start many processes. */
export class BranchStatusReader {
  private readonly cache = new Map<string, { readonly at: number; readonly value: Promise<unknown> }>()

  /**
   * @param run - command runner.
   * @param now - clock, in milliseconds.
   */
  constructor(private readonly run: RunCommand, private readonly now: () => number = Date.now) {}

  private cached<Value>(key: string, load: () => Promise<Value>): Promise<Value> {
    const found = this.cache.get(key)
    if (found !== undefined && this.now() - found.at < CACHE_MS) return found.value as Promise<Value>
    const value = load()
    this.cache.set(key, { at: this.now(), value })
    return value
  }

  private text(command: 'git' | 'gh', args: readonly string[], cwd: string): Promise<string | undefined> {
    return this.run(command, args, cwd).then(output => output.trim(), () => undefined)
  }

  private pullRequests(top: string): Promise<readonly PullRequestRow[]> {
    return this.cached(`prs\0${top}`, async () => {
      const output = await this.text('gh', ['pr', 'list', '--state', 'all', '--limit', PULL_REQUEST_LIMIT, '--json', 'headRefName,state,mergedAt'], top)
      try {
        return output === undefined ? [] : JSON.parse(output) as PullRequestRow[]
      } catch (error) {
        console.warn('agent-bridge: gh returned invalid pull requests', error)
        return []
      }
    })
  }

  /** A clone does not always record origin/HEAD, so the usual names are the fallback. */
  private async defaultBranch(top: string): Promise<string | undefined> {
    const recorded = await this.text('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], top)
    if (recorded !== undefined && recorded !== '') return recorded
    for (const name of ['origin/main', 'origin/master']) {
      if (await this.text('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${name}`], top) !== undefined) return name
    }
    return undefined
  }

  /**
   * @param cwd - folder of the session.
   * @param recorded - branch that the session recorded; the current branch of the folder is used without one.
   * @returns the state of the branch; `none` for the default branch, a detached head or a folder outside Git.
   */
  read(cwd: string, recorded?: string): Promise<BranchStateWire> {
    return this.cached(`state\0${cwd}\0${recorded ?? ''}`, async () => {
      if (cwd === '') return 'none'
      const top = await this.text('git', ['rev-parse', '--show-toplevel'], cwd)
      if (top === undefined || top === '') return 'none'
      const branch = recorded ?? await this.text('git', ['branch', '--show-current'], cwd)
      if (branch === undefined || branch === '' || branch.startsWith('-') || branch === 'HEAD') return 'none'
      const head = await this.defaultBranch(top)
      if (head === undefined || head === `origin/${branch}`) return 'none'
      const fromPullRequest = pullRequestState(await this.pullRequests(top), branch)
      if (fromPullRequest !== undefined) return fromPullRequest
      const ahead = await this.text('git', ['rev-list', '--count', `${head}..refs/heads/${branch}`], top)
      return ahead !== undefined && Number(ahead) > 0 ? 'unmerged' : 'none'
    })
  }
}
