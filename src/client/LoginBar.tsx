/** A notice that a provider is not signed in, with a button that runs the provider's own sign-in command. */
import { useLogins, cancelLogin, startLogin } from './login-store.ts'
import type { Translate } from './ToolCard.tsx'
import css from './LoginBar.module.css'

/**
 * @param props - the provider id, its name, and translate.
 * @returns the notice; nothing when the provider is signed in or its state is not known.
 */
export function LoginBar({ provider, label, t }: { provider: string; label: string; t: Translate }) {
  const login = useLogins([provider])[provider]
  const flow = login?.flow
  if (flow?.state === 'running') {
    return (
      <div className={css.bar} role="status" data-testid="ext-login-bar" data-state="running">
        <span className={css.text}>{t('login.waiting', { name: label })}</span>
        {flow.url !== undefined && <a className={css.action} href={flow.url} target="_blank" rel="noreferrer" data-testid="ext-login-open">{t('login.openPage')}</a>}
        <button type="button" className={css.action} data-testid="ext-login-cancel" onClick={() => { void cancelLogin(provider) }}>{t('login.cancel')}</button>
      </div>
    )
  }
  if (flow?.state === 'succeeded') return <div className={css.bar} role="status" data-testid="ext-login-bar" data-state="done"><span className={css.text}>{t('login.done', { name: label })}</span></div>
  if (login?.signedIn !== false) return null
  return (
    <div className={css.bar} role="alert" data-testid="ext-login-bar" data-state="needed">
      <span className={css.text}>{flow?.state === 'failed' && flow.error !== undefined ? t('login.failed', { error: flow.error }) : t('login.needed', { name: label })}</span>
      <button type="button" className={css.primary} data-testid="ext-login-start" onClick={() => { void startLogin(provider) }}>{t('login.start')}</button>
    </div>
  )
}
