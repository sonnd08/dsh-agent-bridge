/**
 * What each permission choice of the composer means to each engine. Pi has no permission system, so it has no entry.
 * @module dsh-agent-bridge/permissions
 */
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { PERMISSION_PRESETS, type PermissionPreset } from './protocol.ts'

/**
 * Validate a preset that arrived over the wire.
 * @param value - the field as received.
 * @returns the preset, or undefined when the field is absent or empty.
 * @throws Error when it names no preset, so a bad value cannot change what a turn may do.
 */
export function parsePreset(value: unknown): PermissionPreset | undefined {
  if (value === undefined || value === '') return undefined
  if (!PERMISSION_PRESETS.includes(value as PermissionPreset)) throw new Error('unknown permission choice')
  return value as PermissionPreset
}

/**
 * @param preset - the user's choice; undefined keeps the configured mode.
 * @param configured - the mode from the plugin settings.
 * @returns the Claude permission mode.
 */
export function claudePermission(preset: PermissionPreset | undefined, configured: PermissionMode): PermissionMode {
  switch (preset) {
    case 'readOnly': return 'plan'
    case 'workspaceWrite': return 'acceptEdits'
    case 'fullAccess': return 'bypassPermissions'
    case undefined: return configured
  }
}

/** Approval and sandbox of a Codex turn. */
export interface CodexPermission {
  readonly approvalPolicy: 'untrusted' | 'on-request' | 'never'
  readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
}

/**
 * @param preset - the user's choice; undefined keeps the configured values.
 * @param configured - the values from the plugin settings.
 * @returns the Codex approval policy and sandbox.
 */
export function codexPermission(preset: PermissionPreset | undefined, configured: CodexPermission): CodexPermission {
  switch (preset) {
    case 'readOnly': return { approvalPolicy: 'on-request', sandbox: 'read-only' }
    case 'workspaceWrite': return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
    case 'fullAccess': return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    case undefined: return configured
  }
}
