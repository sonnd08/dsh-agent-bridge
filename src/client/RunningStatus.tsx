/**
 * Working indicator at the end of a running conversation, laid out like DSH's own running status: the engine
 * mark, a shimmering label and the time elapsed since this browser sent the turn.
 * @module dsh-agent-bridge/RunningStatus
 */
import { useEffect, useState } from 'react'
import { TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EngineName } from '../protocol.ts'
import type { Translate } from './ToolCard.tsx'
import { formatElapsed } from './elapsed.ts'
import css from './ExternalPanel.module.css'

/**
 * @param props.engine - engine whose mark is shown.
 * @param props.startedAt - epoch ms when this browser sent the turn; unknown for a turn started elsewhere.
 * @param props.t - plugin locale.
 * @returns the indicator; mount only while a turn runs.
 */
export function RunningStatus({ engine, startedAt, t }: { engine: EngineName; startedAt: number | undefined; t: Translate }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startedAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [startedAt])
  const label = startedAt === undefined ? t('panel.working') : t('panel.workingFor', { duration: formatElapsed(now - startedAt, t) })
  return (
    <div className={css.working} data-testid="ext-working">
      <span className={css.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{t('panel.working')}</span>
      <span data-engine={engine} aria-hidden />
      <TextShimmer active className={css.workingText}>{label}</TextShimmer>
    </div>
  )
}
