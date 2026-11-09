/** Permission control of the composer, with the look and risk gate of the DSH composer's own control. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconChevronDownOutlineRegular, Menu, PermissionIconFullAccessRegular, PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular, RiskConfirmation,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './ToolCard.tsx'
import css from './ExternalPanel.module.css'
import popupCss from './ProviderPicker.module.css'

/** One access level. */
export interface PermissionOption { readonly value: string; readonly label: string; readonly description?: string | undefined; readonly icon?: ReactNode }

const RISKY_PRESETS: readonly string[] = ['fullAccess']
/** Presets whose risk dialog names full access; any other risky preset uses its own name and description. */
const FULL_ACCESS_VALUES: readonly string[] = ['fullAccess', 'danger-full-access']
const LOCK_ICON = <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3.500" y="7" width="9" height="6.500" rx="1.800" /><path d="M5.500 7V5a2.500 2.500 0 0 1 5 0v2" /></svg>

/**
 * The bridge's access levels.
 * @param t - translate.
 * @returns the levels; empty means the permissions in the plugin settings.
 */
export function bridgeAccessOptions(t: Translate): PermissionOption[] {
  return [
    { value: '', label: t('composer.permissionDefault'), description: t('picker.accessDefault'), icon: LOCK_ICON },
    { value: 'readOnly', label: t('composer.permissionReadOnly'), description: t('picker.accessReadOnly'), icon: <PermissionIconReadOnlyRegular /> },
    { value: 'workspaceWrite', label: t('composer.permissionWorkspace'), description: t('picker.accessWorkspace'), icon: <PermissionIconWorkspaceWriteRegular /> },
    { value: 'fullAccess', label: t('composer.permissionFull'), description: t('picker.accessFull'), icon: <PermissionIconFullAccessRegular /> },
  ]
}

/** Risk confirmation of one access level. */
function AccessRiskDialog({ option, acknowledged, onAcknowledged, onCancel, onConfirm, t }: { option: PermissionOption | undefined; acknowledged: boolean; onAcknowledged: (value: boolean) => void; onCancel: () => void; onConfirm: () => void; t: Translate }) {
  const full = option === undefined || FULL_ACCESS_VALUES.includes(option.value)
  return (
    <RiskConfirmation
      open
      title={full ? t('composer.fullTitle') : t('picker.riskTitle', { name: option.label })}
      description={full ? t('composer.fullDescription') : option.description ?? ''}
      acknowledgeLabel={t('composer.fullAcknowledge')}
      cancelLabel={t('composer.fullCancel')}
      closeLabel={t('composer.fullClose')}
      confirmLabel={full ? t('composer.fullEnable') : t('picker.riskEnable')}
      acknowledged={acknowledged}
      onAcknowledgedChange={onAcknowledged}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}

/**
 * The access menu; a risky preset takes effect only after the risk dialog is acknowledged.
 * @param props - the value and callback; `options` and `riskValues` default to the bridge's presets, where empty means the permissions in the plugin settings.
 * @returns the menu and its risk dialog.
 */
export function PermissionPicker({ value, onChange, options, riskValues = RISKY_PRESETS, t }: { value: string; onChange: (value: string) => void; options?: readonly PermissionOption[]; riskValues?: readonly string[]; t: Translate }) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [acknowledged, setAcknowledged] = useState(false)
  const rows: readonly PermissionOption[] = options ?? bridgeAccessOptions(t)
  const current = rows.find(option => option.value === value) ?? rows[0]
  const label = current?.label ?? value
  const closeDialog = (): void => { setConfirming(undefined); setAcknowledged(false) }
  return (
    <>
      <Menu
        open={open}
        items={rows.map(option => ({ id: option.value === '' ? 'default' : option.value, label: option.label, ...option.icon === undefined ? {} : { icon: option.icon } }))}
        selectedId={value === '' ? 'default' : value}
        onSelect={(id) => {
          setOpen(false)
          const next = id === 'default' ? '' : id
          if (next === value) return
          if (riskValues.includes(next)) setConfirming(next)
          else onChange(next)
        }}
        onClose={() => { setOpen(false) }}
        side="top"
        portal
        anchor={(
          <button
            type="button" className={css.permissionTrigger} data-testid="ext-permission-trigger" data-value={value}
            aria-label={t('composer.permissionMode', { name: label })} onClick={() => { setOpen(!open) }}
          >
            {current?.icon !== undefined && <span className={css.permissionIcon} aria-hidden>{current.icon}</span>}
            <span className={css.permissionLabel}>{label}</span>
            <span className={open ? `${css.permissionChevron} ${css.permissionChevronOpen}` : css.permissionChevron} aria-hidden><IconChevronDownOutlineRegular /></span>
          </button>
        )}
      />
      {confirming !== undefined && (
        <AccessRiskDialog
          option={rows.find(option => option.value === confirming)} acknowledged={acknowledged} onAcknowledged={setAcknowledged} onCancel={closeDialog} t={t}
          onConfirm={() => { const next = confirming; closeDialog(); onChange(next) }}
        />
      )}
    </>
  )
}

/**
 * The access chip of the chat bar and its Permissions popup. A pointer over a level shows its description; a click selects it.
 * @param props - the levels, the value and callback, the lock state, and translate.
 * @returns the chip; the popup portals to the document body because the docked composer contains the chip.
 */
export function PermissionPopover({ options, value, onChange, riskValues = RISKY_PRESETS, locked, t }: { options: readonly PermissionOption[]; value: string; onChange: (value: string) => void; riskValues?: readonly string[]; locked?: boolean | undefined; t: Translate }) {
  const [open, setOpen] = useState(false)
  const [previewed, setPreviewed] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [acknowledged, setAcknowledged] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({})
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const current = options.find(option => option.value === value) ?? options[0]
  const detail = options.find(option => option.value === previewed) ?? current
  const close = (): void => { setOpen(false); setPreviewed(undefined) }
  const closeDialog = (): void => { setConfirming(undefined); setAcknowledged(false) }
  const select = (next: string): void => {
    close()
    if (next === value) return
    if (riskValues.includes(next)) setConfirming(next)
    else onChange(next)
  }
  useLayoutEffect(() => {
    if (!open || trigger.current === null) return
    const rect = trigger.current.getBoundingClientRect()
    setPosition({ right: Math.max(12, window.innerWidth - rect.right), bottom: window.innerHeight - rect.top + 8 })
  }, [open])
  useEffect(() => {
    if (!open) return undefined
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node
      if (panel.current?.contains(target) !== true && trigger.current?.contains(target) !== true) close()
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return (
    <>
      <button
        ref={trigger} type="button" className={popupCss.accessChip} data-testid="ext-provider-access-chip" data-value={value} disabled={locked === true}
        aria-haspopup="dialog" aria-expanded={open} aria-label={t('composer.permissionMode', { name: current?.label ?? value })} onClick={() => { if (open) close(); else setOpen(true) }}
      >
        {current?.icon !== undefined && <span className={popupCss.accessIcon} aria-hidden>{current.icon}</span>}
        <span>{current?.label ?? value}</span>
      </button>
      {open && createPortal(
        <div ref={panel} className={popupCss.accessPopup} style={position} role="dialog" aria-label={t('picker.permissions')} data-testid="ext-provider-access-popup">
          <p className={popupCss.accessTitle}>{t('picker.permissions')}</p>
          <div className={popupCss.accessLevels} role="group" onPointerLeave={() => { setPreviewed(undefined) }}>
            {options.map(option => (
              <button
                key={option.value} type="button" className={option.value === value ? popupCss.accessLevelActive : popupCss.accessLevel} data-testid="ext-provider-access-level" data-value={option.value}
                aria-pressed={option.value === value} aria-label={option.label} title={option.label}
                onPointerEnter={() => { setPreviewed(option.value) }} onFocus={() => { setPreviewed(option.value) }} onClick={() => { select(option.value) }}
              >{option.icon ?? option.label.charAt(0)}</button>
            ))}
          </div>
          {/* Every level keeps its place in one grid cell. The popup grows upward, so a height change moves the buttons away from the pointer. */}
          <div className={popupCss.accessDetail}>
            {options.map(option => (
              <div key={option.value} className={option.value === detail?.value ? popupCss.accessDetailShown : popupCss.accessDetailItem} aria-hidden={option.value !== detail?.value} data-testid={option.value === detail?.value ? 'ext-provider-access-detail' : undefined}>
                <p className={popupCss.accessName}>{option.label}</p>
                {option.description !== undefined && <p className={popupCss.accessDescription}>{option.description}</p>}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
      {confirming !== undefined && (
        <AccessRiskDialog
          option={options.find(option => option.value === confirming)} acknowledged={acknowledged} onAcknowledged={setAcknowledged} onCancel={closeDialog} t={t}
          onConfirm={() => { const next = confirming; closeDialog(); onChange(next) }}
        />
      )}
    </>
  )
}
