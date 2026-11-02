import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudePermission, codexPermission, parsePreset } from '../src/permissions.ts'

const configured = { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }

test('no choice keeps the configured permissions of each engine', () => {
  assert.equal(claudePermission(undefined, 'default'), 'default')
  assert.deepEqual(codexPermission(undefined, configured), configured)
})

test('each choice maps to the matching permissions of each engine', () => {
  assert.deepEqual(['readOnly', 'workspaceWrite', 'fullAccess'].map(preset => claudePermission(preset, 'default')), ['plan', 'acceptEdits', 'bypassPermissions'])
  assert.deepEqual(codexPermission('readOnly', configured), { approvalPolicy: 'on-request', sandbox: 'read-only' })
  assert.deepEqual(codexPermission('workspaceWrite', configured), { approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  assert.deepEqual(codexPermission('fullAccess', configured), { approvalPolicy: 'never', sandbox: 'danger-full-access' })
})

test('a value that names no choice is refused rather than treated as a default', () => {
  assert.equal(parsePreset(undefined), undefined)
  assert.equal(parsePreset(''), undefined)
  assert.equal(parsePreset('fullAccess'), 'fullAccess')
  for (const bad of ['bypassPermissions', 'FULLACCESS', 1, null, {}]) assert.throws(() => parsePreset(bad), /unknown permission choice/)
})
