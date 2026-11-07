/**
 * Elapsed-time label for the working indicator.
 * @module dsh-agent-bridge/elapsed
 */
import type { Translate } from './ToolCard.tsx'

/**
 * Elapsed time in DSH's running-status units (`12秒`, `1分5秒` or `12s`, `1m 5s`).
 * @param ms - elapsed milliseconds; shown as at least one second.
 * @param t - plugin locale.
 * @returns the localized duration.
 */
export function formatElapsed(ms: number, t: Translate): string {
  const total = Math.max(1, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  return [
    hours > 0 ? `${hours}${t('duration.hour')}` : '',
    total >= 60 ? `${minutes}${t('duration.minute')}` : '',
    `${seconds}${t('duration.second')}`,
  ].join('')
}
