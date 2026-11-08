/** Unread dot and branch state at the end of a session row; any sidebar that renders the trailing row slot shows them. */
import { useSyncExternalStore } from 'react'
import type { BranchStateWire } from '../protocol.ts'
import type { Translate } from './ToolCard.tsx'
import css from './RowIndicators.module.css'

/** What one row shows. */
export interface RowIndicator {
  readonly unread: boolean
  readonly branch: BranchStateWire
}

const NONE: RowIndicator = { unread: false, branch: 'none' }
let indicators: ReadonlyMap<string, RowIndicator> = new Map()
const listeners = new Set<() => void>()

/** @param next - indicators by browser row id. */
export function publishRowIndicators(next: ReadonlyMap<string, RowIndicator>): void {
  indicators = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const BRANCH_TITLE = { merged: 'row.merged', open: 'row.prOpen', unmerged: 'row.unmerged' } as const

/**
 * Draw the indicators of one row.
 * @param props - browser row id and translate.
 * @returns the indicators, or nothing.
 */
export function RowIndicators({ sessionId, t }: { sessionId: string; t: Translate }) {
  const { unread, branch } = useSyncExternalStore(subscribe, () => indicators.get(sessionId) ?? NONE)
  if (!unread && branch === 'none') return null
  return (
    <span className={css.root}>
      {branch !== 'none' && (
        <span className={css[branch]} role="img" aria-label={t(BRANCH_TITLE[branch])} title={t(BRANCH_TITLE[branch])} data-testid={`ext-branch-${branch}`}>
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
            <circle cx="4" cy="3.5" r="1.75" />
            <circle cx="12" cy={branch === 'merged' ? 9 : 5} r="1.75" />
            <path d={branch === 'merged' ? 'M4 5.25v8M5.2 5c1 2.6 2.9 4 5 4' : branch === 'open' ? 'M4 5.25v8M12 6.75v3.5c0 1.5-1 2.5-3 2.5' : 'M4 5.25v8M12 6.75c0 3-4 2.75-8 4.25'} />
          </svg>
        </span>
      )}
      {unread && <span className={css.unread} role="img" aria-label={t('row.unread')} title={t('row.unread')} data-testid="ext-unread" />}
    </span>
  )
}
