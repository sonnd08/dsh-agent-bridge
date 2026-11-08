import { test } from 'node:test'
import assert from 'node:assert/strict'
import { engineOf, EXTERNAL_PREFIX, graftWorkspaceBrowser, mergeList, mergeWorkspaceState, mergeWorkspaces } from '../src/client/graft.tsx'

const external = {
  rows: [
    { id: 'claude:a', title: 'alpha', cwd: '/w/alpha', updatedAt: 10 },
    { id: 'codex:b', title: 'beta', cwd: '/elsewhere', updatedAt: 20 },
  ],
  selectedId: 'claude:a',
}
const hostList = {
  ids: ['session-1'],
  byId: { 'session-1': { id: 'session-1', title: 'host', retainedBy: { mainView: 1 } } },
}

test('external rows join the Host list under the ext: prefix and the open one is the retained row', () => {
  const shown = mergeList(hostList, external, true)
  assert.deepEqual(shown.ids, ['session-1', 'ext:claude:a', 'ext:codex:b'])
  assert.equal(shown.byId['ext:claude:a'].retainedBy.mainView, 1)
  assert.deepEqual(shown.byId['ext:codex:b'].retainedBy, {})
  assert.equal(shown.byId['session-1'].retainedBy.mainView, 0, 'the Host row is not highlighted while our panel shows')
  const hidden = mergeList(hostList, external, false)
  assert.deepEqual(hidden.byId['ext:claude:a'].retainedBy, {})
  assert.equal(hidden.byId['session-1'].retainedBy.mainView, 1)
  assert.equal(mergeList(hostList, { rows: [] }, false), hostList, 'nothing to merge keeps the snapshot identity')
})

test('a running external row uses the Host running state and keeps its title', () => {
  const row = { id: 'claude:a', title: 'alpha', cwd: '/w/alpha', updatedAt: 10 }
  const merged = mergeList(hostList, { rows: [{ ...row, running: true }, { ...row, id: 'claude:b' }] }, false)
  assert.equal(merged.byId['ext:claude:a'].running, true)
  assert.equal(merged.byId['ext:claude:a'].title, 'alpha')
  assert.equal(merged.byId['ext:claude:a'].displayTitle, 'alpha')
  assert.equal(merged.byId['ext:claude:b'].running, false)
})

test('external rows are accounted to the Workspace whose path is their folder', () => {
  const items = [{ path: '/w/alpha', sessionIds: ['session-1'] }, { path: '/w/gamma', sessionIds: [] }]
  const merged = mergeWorkspaces(items, external)
  assert.deepEqual(merged[0].sessionIds, ['session-1', 'ext:claude:a'])
  assert.equal(merged[1], items[1])
  assert.equal(mergeWorkspaces(items, { rows: [{ id: 'x', title: '', cwd: '/none', updatedAt: 0 }] }), items)
})

test('pinned external rows join the Host pin set', () => {
  const state = { items: [], pinnedSessionIds: ['session-1'] }
  assert.deepEqual(mergeWorkspaceState(state, { ...external, pinned: ['codex:b'] }).pinnedSessionIds, ['session-1', 'ext:codex:b'])
  assert.equal(mergeWorkspaceState(state, { rows: [] }), state)
})

test('engine of a browser row', () => {
  assert.equal(engineOf('session-1'), 'dsh')
  assert.equal(engineOf('ext:claude:a'), 'claude')
  assert.equal(engineOf('ext:codex:b'), 'codex')
})

function fakeSlots(entries) {
  const listeners = new Map()
  return {
    entries: key => entries[key] ?? [],
    subscribe(key, fn) { listeners.set(key, fn); return () => listeners.delete(key) },
    listeners,
  }
}
const calls = []
const source = {
  snapshot: { getSnapshot: () => external, subscribe: () => () => {} },
  open() {},
  pin: (id, pinned) => { calls.push(['pin', id, pinned]) },
  archive: (id) => { calls.push(['archive', id]) },
  rename: async (id, title) => { calls.push(['rename', id, title]) },
  panelId: 'agent-bridge',
}

test('a browser registration without the dsh 0.2.1 row menu leaves the browser untouched', () => {
  const Browser = () => null
  const entry = { component: Browser, children: {} }
  assert.equal(graftWorkspaceBrowser(fakeSlots({ 'sidebar.workspaces': [entry] }), source), undefined)
  assert.equal(entry.component, Browser)
  assert.equal(graftWorkspaceBrowser(fakeSlots({}), source), undefined)
})

test('the shipped browser and Host row entries are wrapped, later registrations too, and restored on dispose', async () => {
  const Browser = () => null
  const Pin = () => null
  const Copy = () => null
  const Dialog = () => null
  const Own = Object.assign(() => null, { [Symbol.for('agent-bridge.row-entry')]: true })
  const browser = { component: Browser, children: { 'sidebar.workspaces.session.menu.item': {} } }
  const pin = { component: Pin, options: { id: 'pin' } }
  const copy = { component: Copy, options: { id: 'session-id' } }
  const own = { component: Own, options: { id: 'mine' } }
  const dialog = { component: Dialog, options: { id: 'workspace.session-rename' } }
  const menu = [pin, copy, own]
  const slots = fakeSlots({ 'sidebar.workspaces': [browser], 'sidebar.workspaces.session.menu.item': menu, 'shell.overlay': [dialog] })
  const undo = graftWorkspaceBrowser(slots, source)
  assert.equal(typeof undo, 'function')
  assert.notEqual(browser.component, Browser)
  assert.notEqual(pin.component, Pin)
  assert.equal(own.component, Own, "the plugin's own items stay as registered")
  assert.equal(copy.component({ sessionId: 'ext:claude:a' }), null, 'a Host verb without an adapter renders nothing on an external row')
  assert.equal(copy.component({ sessionId: 'session-1' }).type, Copy)
  const hostPin = () => {}
  assert.equal(pin.component({ sessionId: 'session-1', pinSession: hostPin }).props.pinSession, hostPin, 'a Host row keeps the Host verb')
  const adapted = pin.component({ sessionId: 'ext:claude:a', pinSession: hostPin }).props
  adapted.pinSession('ext:claude:a')
  adapted.unpinSession('ext:claude:a')
  assert.deepEqual(calls.splice(0), [['pin', 'claude:a', true], ['pin', 'claude:a', false]])
  const hostRename = async () => { calls.push(['host-rename']) }
  const dialogProps = dialog.component({ renameSession: hostRename }).props
  await dialogProps.renameSession('ext:codex:b', 'new title')
  await dialogProps.renameSession('session-1', 'host title')
  assert.deepEqual(calls.splice(0), [['rename', 'codex:b', 'new title'], ['host-rename']], 'the dialog renames an external row through the plugin')
  const later = { component: () => null }
  const original = later.component
  menu.push(later)
  slots.listeners.get('sidebar.workspaces.session.menu.item')()
  assert.notEqual(later.component, original)
  undo()
  assert.equal(browser.component, Browser)
  assert.equal(pin.component, Pin)
  assert.equal(dialog.component, Dialog)
  assert.equal(later.component, original)
})

test('the dsh 0.2.2 browser, whose row menu moved out of it, is grafted and its row buttons work on external rows', () => {
  const Browser = () => null
  const Pin = () => null
  const Archive = () => null
  const browser = { component: Browser, children: { 'sidebar.workspaces.session.row.action': {}, 'sidebar.session.row.hover': {} } }
  const pin = { component: Pin, options: { id: 'pin' } }
  const archive = { component: Archive, options: { id: 'archive' } }
  const slots = fakeSlots({ 'sidebar.workspaces': [browser], 'sidebar.workspaces.session.row.action': [pin, archive] })
  const undo = graftWorkspaceBrowser(slots, source)
  assert.equal(typeof undo, 'function', 'the 0.2.2 browser is recognized')
  assert.notEqual(browser.component, Browser)
  const hostAccess = () => false
  const pinProps = pin.component({ sessionId: 'ext:claude:a', useSessionAccess: hostAccess }).props
  assert.equal(pinProps.useSessionAccess('ext:claude:a', 'workspace/pinSession'), true, 'an external row is not hidden by the Host access check')
  const archiveProps = archive.component({ sessionId: 'ext:claude:a', useSessionAccess: hostAccess }).props
  archiveProps.archiveSession('ext:claude:a')
  assert.deepEqual(calls.splice(0), [['archive', 'claude:a']])
  assert.equal(pin.component({ sessionId: 'session-1', useSessionAccess: hostAccess }).props.useSessionAccess, hostAccess, 'a Host row keeps the Host check')
  undo()
  assert.equal(browser.component, Browser)
})

test('the Workspace browser does not list the new-session drafts', () => {
  const external = { rows: [{ id: 'claude:new', title: '+ New', cwd: '/w', updatedAt: 1 }, { id: 'codex:new', title: '+ New', cwd: '/w', updatedAt: 1 }, { id: 'claude:a', title: 'A', cwd: '/w', updatedAt: 1 }] }
  const merged = mergeList({ ids: [], byId: {} }, external, false)
  assert.deepEqual(merged.ids.map(id => id.slice(EXTERNAL_PREFIX.length)), ['claude:a'])
  assert.deepEqual(mergeWorkspaces([{ path: '/w', sessionIds: [] }], external)[0].sessionIds.map(id => id.slice(EXTERNAL_PREFIX.length)), ['claude:a'])
})
