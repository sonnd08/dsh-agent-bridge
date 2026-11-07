/** The Agent Bridge page of the settings dialog: what the bridge is connected to and which versions it was verified with. */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ABOUT_PATH, type AboutWire } from '../protocol.ts'
import { aboutRows, type AboutRow } from './about.ts'
import css from './AboutSection.module.css'

/** Props the settings shell and the locale seat pass. */
export type AboutSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'agent-bridge'>

const NAME_KEY = { dsh: 'about.name.dsh', claude: 'about.name.claude', codex: 'about.name.codex', pi: 'about.name.pi' } as const
const STATUS_KEY = {
  verified: 'about.status.verified', unverified: 'about.status.unverified', missing: 'about.status.missing',
  off: 'about.status.off', unknown: 'about.status.unknown',
} as const

/**
 * Render the page; it asks the host when it opens and on refresh.
 * @param props - locale seat.
 * @returns the page.
 */
export function AboutSection({ t }: AboutSectionProps) {
  const [about, setAbout] = useState<AboutWire | 'failed' | undefined>(undefined)
  const [asked, setAsked] = useState(0)
  useEffect(() => {
    let cancelled = false
    setAbout(undefined)
    void fetch(ABOUT_PATH, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json() as AboutWire
      })
      .then((body) => { if (!cancelled) setAbout(body) }, () => { if (!cancelled) setAbout('failed') })
    return () => { cancelled = true }
  }, [asked])
  const row = (item: AboutRow) => (
    <li key={item.id} className={css.row} data-testid={`about-${item.id}`} data-status={item.status}>
      <div className={css.head}>
        <span className={css.name}>{t(NAME_KEY[item.id])}</span>
        <span className={css.version}>{item.version ?? t('about.unknown')}</span>
        <span className={css.badge} data-status={item.status}>{t(STATUS_KEY[item.status])}</span>
      </div>
      {item.executable !== undefined && <div className={css.detail}>{t('about.executable')}<code>{item.executable}</code></div>}
      {item.error !== undefined && <div className={css.detail}>{item.error}</div>}
      <div className={css.detail}>{t('about.verified')}{item.verified.join(', ')}</div>
    </li>
  )
  return (
    <section className={css.page} data-testid="about-section">
      <div className={css.top}>
        <h3>{t('about.title')}</h3>
        <button type="button" data-testid="about-refresh" disabled={about === undefined} onClick={() => { setAsked(asked + 1) }}>{t('about.refresh')}</button>
      </div>
      {about === undefined && <p>{t('about.loading')}</p>}
      {about === 'failed' && <p>{t('about.failed')}</p>}
      {about !== undefined && about !== 'failed' && (
        <>
          <p className={css.detail}>{t('about.plugin')}<code>{about.plugin}</code>{' · '}{t('about.sdk')}<code>{about.sdk}</code></p>
          <ul className={css.list}>{aboutRows(about).map(row)}</ul>
        </>
      )}
    </section>
  )
}
