/** The three-step dialog that adds a Claude or Codex instance. */
import { useState } from 'react'
import type { Translate } from './ToolCard.tsx'
import css from './ModelsSection.module.css'

const ACCENTS = ['#4f7cff', '#d97757', '#2fa866', '#b36ad8', '#e0a93a', '#e05d5d']
const STEPS = ['providers.stepProvider', 'providers.stepIdentity', 'providers.stepConfig'] as const
const ENGINES = [
  { id: 'codex', label: 'Codex', homeVar: 'CODEX_HOME', home: '~/.codex-work', binary: 'codex' },
  { id: 'claude', label: 'Claude', homeVar: 'CLAUDE_CONFIG_DIR', home: '~/.claude-work', binary: 'claude' },
] as const

function freeId(engine: string, taken: readonly string[]): string {
  for (let number = 2; ; number += 1) {
    const id = `${engine}_${number}`
    if (!taken.includes(id)) return id
  }
}

/**
 * Render the dialog.
 * @param props - instance ids already in use, the add callback that resolves to an error text, the close callback, and translate.
 * @returns the dialog.
 */
export function AddProviderDialog({ taken, onAdd, onClose, t }: { taken: readonly string[]; onAdd: (instance: unknown) => Promise<string | undefined>; onClose: () => void; t: Translate }) {
  const [step, setStep] = useState(0)
  const [engineId, setEngineId] = useState<'codex' | 'claude'>('codex')
  const engine = ENGINES.find(item => item.id === engineId) ?? ENGINES[0]
  const [label, setLabel] = useState('')
  const [id, setId] = useState('')
  const [accent, setAccent] = useState<string | undefined>(undefined)
  const [binaryPath, setBinaryPath] = useState('')
  const [home, setHome] = useState('')
  const [launchArgs, setLaunchArgs] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const shownLabel = label === '' ? engine.label : label
  const shownId = id === '' ? freeId(engineId, taken) : id
  const submit = (): void => {
    setBusy(true)
    setError(undefined)
    void onAdd({ id: shownId, engine: engineId, label: shownLabel, home, binaryPath, launchArgs, ...accent === undefined ? {} : { accent } })
      .then((failure) => { if (failure === undefined) onClose(); else setError(failure) }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { setBusy(false) })
  }
  return (
    <div className={css.dialogBackdrop} data-testid="ext-add-provider">
      <div className={css.dialog} role="dialog" aria-label={t('providers.add')}>
        <button type="button" className={css.dialogClose} aria-label={t('manage.cancel')} onClick={onClose}>×</button>
        <h3 className={css.dialogTitle}>{t('providers.add')}</h3>
        <ol className={css.steps}>
          {STEPS.map((key, index) => <li key={key} className={index === step ? css.stepActive : css.step}><span>{index < step ? '✓' : index + 1}</span>{t(key)}</li>)}
        </ol>
        {step === 0 && (
          <div className={css.providerChoices}>
            {ENGINES.map(item => (
              <button key={item.id} type="button" className={item.id === engineId ? css.providerChoiceActive : css.providerChoice} data-testid={`ext-add-provider-${item.id}`} aria-pressed={item.id === engineId} onClick={() => { setEngineId(item.id); setId(''); setLabel('') }}>
                <span className={css.engineMark} data-engine={item.id} aria-hidden />{item.label}
              </button>
            ))}
          </div>
        )}
        {step === 1 && (
          <div className={css.fields}>
            <label className={css.field}><span><b>{t('providers.label')}</b><small>{t('providers.labelHint')}</small></span><input data-testid="ext-add-provider-label" value={shownLabel} onChange={(event) => { setLabel(event.target.value) }} /></label>
            <label className={css.field}><span><b>{t('providers.instanceId')}</b><small>{t('providers.instanceIdHint')}</small></span><input data-testid="ext-add-provider-id" value={shownId} onChange={(event) => { setId(event.target.value) }} /></label>
            <div className={css.field}>
              <span><b>{t('providers.accent')}</b><small>{t('providers.accentHint')}</small></span>
              <div className={css.swatches}>
                <button type="button" className={accent === undefined ? css.swatchNoneActive : css.swatchNone} aria-label={t('providers.accentNone')} aria-pressed={accent === undefined} onClick={() => { setAccent(undefined) }} />
                {ACCENTS.map(color => <button key={color} type="button" className={accent === color ? css.swatchActive : css.swatch} style={{ background: color }} aria-label={color} aria-pressed={accent === color} onClick={() => { setAccent(color) }} />)}
              </div>
            </div>
          </div>
        )}
        {step === 2 && (
          <div className={css.fields}>
            <label className={css.field}><span><b>{t('providers.binary')}</b><small>{t('providers.binaryHint', { name: engine.label })}</small></span><input data-testid="ext-add-provider-binary" placeholder={engine.binary} value={binaryPath} onChange={(event) => { setBinaryPath(event.target.value) }} /></label>
            <label className={css.field}><span><b>{t('providers.home', { name: engine.homeVar })}</b><small>{t('providers.homeHint')}</small></span><input data-testid="ext-add-provider-home" placeholder={engine.home} value={home} onChange={(event) => { setHome(event.target.value) }} /></label>
            <label className={css.field}><span><b>{t('providers.launchArgs')}</b><small>{t('providers.launchArgsHint')}</small></span><input data-testid="ext-add-provider-args" value={launchArgs} onChange={(event) => { setLaunchArgs(event.target.value) }} /></label>
          </div>
        )}
        {error !== undefined && <p className={css.error} role="alert">{error}</p>}
        <footer className={css.dialogFooter}>
          {step === 0
            ? <button type="button" className={css.dialogButton} onClick={onClose}>{t('manage.cancel')}</button>
            : <button type="button" className={css.dialogButton} onClick={() => { setError(undefined); setStep(step - 1) }}>{t('providers.back')}</button>}
          {step < 2
            ? <button type="button" className={css.dialogPrimary} data-testid="ext-add-provider-next" onClick={() => { setStep(step + 1) }}>{t('providers.next')}</button>
            : <button type="button" className={css.dialogPrimary} data-testid="ext-add-provider-save" disabled={busy || home.trim() === ''} onClick={submit}>{t('providers.addInstance')}</button>}
        </footer>
      </div>
    </div>
  )
}
