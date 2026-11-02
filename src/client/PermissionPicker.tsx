/** Permission control of the composer, with the look and risk gate of the DSH composer's own control. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular, Menu, PermissionIconFullAccessRegular, PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular, RiskConfirmation,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PermissionPreset } from '../protocol.ts'
import type { Translate } from './ToolCard.tsx'
import css from './ExternalPanel.module.css'

/** The stored choice; empty means the permissions configured in the plugin settings, which ask before acting. */
type PermissionValue = PermissionPreset | ''

const OPTIONS: readonly { readonly value: PermissionValue; readonly label: Parameters<Translate>[0]; readonly icon?: ReactNode }[] = [
  { value: '', label: 'composer.permissionDefault' },
  { value: 'readOnly', label: 'composer.permissionReadOnly', icon: <PermissionIconReadOnlyRegular /> },
  { value: 'workspaceWrite', label: 'composer.permissionWorkspace', icon: <PermissionIconWorkspaceWriteRegular /> },
  { value: 'fullAccess', label: 'composer.permissionFull', icon: <PermissionIconFullAccessRegular /> },
]

/** The choice menu; full access takes effect only after the risk dialog is acknowledged. */
export function PermissionPicker({ value, onChange, t }: { value: PermissionValue; onChange: (value: PermissionValue) => void; t: Translate }) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const current = OPTIONS.find(option => option.value === value) ?? OPTIONS[0]
  const label = t(current?.label ?? 'composer.permissionDefault')
  const closeDialog = (): void => { setConfirming(false); setAcknowledged(false) }
  return (
    <>
      <Menu
        open={open}
        items={OPTIONS.map(option => ({ id: option.value === '' ? 'default' : option.value, label: t(option.label), ...option.icon === undefined ? {} : { icon: option.icon } }))}
        selectedId={value === '' ? 'default' : value}
        onSelect={(id) => {
          setOpen(false)
          if (id === 'fullAccess') {
            if (value !== 'fullAccess') setConfirming(true)
          } else {
            onChange(id === 'default' ? '' : id as PermissionPreset)
          }
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
      {confirming && (
        <RiskConfirmation
          open
          title={t('composer.fullTitle')}
          description={t('composer.fullDescription')}
          acknowledgeLabel={t('composer.fullAcknowledge')}
          cancelLabel={t('composer.fullCancel')}
          closeLabel={t('composer.fullClose')}
          confirmLabel={t('composer.fullEnable')}
          acknowledged={acknowledged}
          onAcknowledgedChange={setAcknowledged}
          onCancel={closeDialog}
          onConfirm={() => { closeDialog(); onChange('fullAccess') }}
        />
      )}
    </>
  )
}
