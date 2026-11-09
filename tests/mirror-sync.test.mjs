import test from 'node:test'
import assert from 'node:assert/strict'
import { hasTurnSince, importSelection, importStep, markResync, MIRROR_IMPORTS_PER_SYNC, mirrorNeedsRead, nativeThreadRowIds, nextReplay, planMirror } from '../src/mirror.ts'

const SINCE = 1000
const FILE_TIME = 5000
/** A chat that passes every check of the import rule. */
const chat = (change = {}) => ({ quiet: true, updatedAt: FILE_TIME, since: SINCE, lastChecked: undefined, owned: false, cwd: '/work/app', isFolder: () => true, imports: 0, ...change })
const turn = (user, assistant) => ({ user, assistant })
const entry = (change = {}) => ({ sessionId: 'session-1', route: 'claude-code', synced: 1, checkedAt: 2000, ...change })
const check = (change = {}) => ({ updatedAt: FILE_TIME, quiet: true, active: false, currentRoute: 'claude-code', ...change })

test('import rule: a quiet chat with a later file time is read for a new turn', () => {
  assert.equal(importStep(chat()), 'read')
})

test('import rule: a chat that still changes waits', () => {
  assert.equal(importStep(chat({ quiet: false })), 'skip')
})

test('import rule: a chat with no change since the first sync stays as it is', () => {
  assert.equal(importStep(chat({ updatedAt: SINCE })), 'skip')
  assert.equal(importStep(chat({ updatedAt: SINCE - 1 })), 'skip')
  assert.equal(importStep(chat({ updatedAt: SINCE + 1 })), 'read')
})

test('import rule: a file time that was already found to have no new turn is not read again', () => {
  assert.equal(importStep(chat({ lastChecked: FILE_TIME })), 'skip')
})

test('import rule: a file time that changes again after a check is read again', () => {
  assert.equal(importStep(chat({ lastChecked: FILE_TIME - 1 })), 'read')
})

test('import rule: a chat that a DSH chat already uses is not imported again', () => {
  assert.equal(importStep(chat({ owned: true })), 'skip')
})

test('import rule: a chat with no folder or a deleted folder is left out', () => {
  assert.equal(importStep(chat({ cwd: '' })), 'skip')
  assert.equal(importStep(chat({ isFolder: () => false })), 'skip')
})

test('import rule: the disk is read only after the other checks pass', () => {
  const asked = []
  const isFolder = (cwd) => { asked.push(cwd); return true }
  importStep(chat({ quiet: false, isFolder }))
  importStep(chat({ updatedAt: SINCE, isFolder }))
  importStep(chat({ owned: true, isFolder }))
  importStep(chat({ cwd: '', isFolder }))
  assert.deepEqual(asked, [])
  importStep(chat({ isFolder }))
  assert.deepEqual(asked, ['/work/app'])
})

test('import rule: the limit of one sync leaves the next chats for the next sync', () => {
  assert.equal(importStep(chat({ imports: MIRROR_IMPORTS_PER_SYNC - 1 })), 'read')
  assert.equal(importStep(chat({ imports: MIRROR_IMPORTS_PER_SYNC })), 'more')
  assert.equal(importStep(chat({ imports: MIRROR_IMPORTS_PER_SYNC + 1 })), 'more')
})

test('import rule: a chat that would be skipped does not report more, also at the limit', () => {
  const full = { imports: MIRROR_IMPORTS_PER_SYNC }
  assert.equal(importStep(chat({ ...full, quiet: false })), 'skip')
  assert.equal(importStep(chat({ ...full, owned: true })), 'skip')
  assert.equal(importStep(chat({ ...full, isFolder: () => false })), 'skip')
})

test('new turn: only a turn later than the first sync imports a chat', () => {
  assert.equal(hasTurnSince({ model: 'm', at: SINCE + 1 }, SINCE), true)
  assert.equal(hasTurnSince({ model: 'm', at: SINCE }, SINCE), false)
  assert.equal(hasTurnSince({ model: 'm', at: SINCE - 1 }, SINCE), false)
})

test('new turn: a file with no turn or no turn time does not import a chat', () => {
  assert.equal(hasTurnSince(undefined, SINCE), false)
  assert.equal(hasTurnSince({ model: 'm' }, SINCE), false)
})

test('import selection: the provider route follows the engine or the added instance', () => {
  assert.deepEqual(importSelection('claude', undefined, { model: 'a', effort: 'high' }), { provider: 'claude-code', model: 'a', reasoningEffort: 'high' })
  assert.deepEqual(importSelection('codex', undefined, { model: 'b', effort: 'low' }), { provider: 'codex-cli', model: 'b', reasoningEffort: 'low' })
  assert.deepEqual(importSelection('codex', 'work', { model: 'b', effort: 'low' }), { provider: 'work', model: 'b', reasoningEffort: 'low' })
})

test('import selection: an empty effort names no reasoning level', () => {
  assert.deepEqual(importSelection('claude', undefined, { model: 'a', effort: '' }), { provider: 'claude-code', model: 'a' })
})

test('imported chat: a later file time is read', () => {
  assert.equal(mirrorNeedsRead(entry(), check()), true)
})

test('imported chat: no read when the file did not change', () => {
  assert.equal(mirrorNeedsRead(entry({ checkedAt: FILE_TIME }), check()), false)
  assert.equal(mirrorNeedsRead(entry({ checkedAt: FILE_TIME + 1 }), check()), false)
})

test('imported chat: no read while DSH runs an engine turn in it', () => {
  assert.equal(mirrorNeedsRead(entry(), check({ active: true })), false)
})

test('imported chat: a chat changed to another provider gets no outside turn', () => {
  assert.equal(mirrorNeedsRead(entry(), check({ currentRoute: 'deepseek-account' })), false)
})

test('imported chat: a chat that the client does not report as idle gets no outside turn', () => {
  assert.equal(mirrorNeedsRead(entry(), check({ currentRoute: undefined })), false)
})

test('imported chat: a resync reads the chat with no file change, but only when quiet', () => {
  const marked = entry({ resync: true, checkedAt: FILE_TIME })
  assert.equal(mirrorNeedsRead(marked, check()), true)
  assert.equal(mirrorNeedsRead(marked, check({ quiet: false })), false)
})

test('imported chat: a resync still waits for the provider and the running turn', () => {
  const marked = entry({ resync: true })
  assert.equal(mirrorNeedsRead(marked, check({ active: true })), false)
  assert.equal(mirrorNeedsRead(marked, check({ currentRoute: 'other' })), false)
})

test('replay: a quiet chat shows the next turn and takes the new file time when no turn is left', () => {
  const plan = planMirror(entry(), [turn('a', 'A'), turn('b', 'B')], true, FILE_TIME)
  assert.deepEqual(plan.replay, { user: 'b', assistant: 'B', synced: 2 })
  assert.deepEqual(plan.entry, entry({ synced: 2, checkedAt: FILE_TIME }))
  assert.equal(plan.more, false)
})

test('replay: an active chat shows finished turns and holds back only the last turn', () => {
  const turns = [turn('a', 'A'), turn('b', 'B'), turn('c', 'partial')]
  const plan = planMirror(entry(), turns, false, FILE_TIME)
  assert.deepEqual(plan.replay, { user: 'b', assistant: 'B', synced: 2 })
  assert.equal(plan.entry.synced, 2)
  assert.equal(plan.more, false)
})

test('replay: an active chat keeps the old file time, so that the next sync finds the held turn', () => {
  const plan = planMirror(entry(), [turn('a', 'A'), turn('b', 'B'), turn('c', 'partial')], false, FILE_TIME)
  assert.equal(plan.entry.checkedAt, 2000)
})

test('replay: an active chat with only the running turn shows nothing and changes nothing', () => {
  assert.deepEqual(planMirror(entry(), [turn('a', 'A'), turn('b', 'partial')], false, FILE_TIME), { more: false })
})

test('replay: a held turn shows after the chat goes quiet', () => {
  const held = planMirror(entry(), [turn('a', 'A'), turn('b', 'B')], false, FILE_TIME)
  assert.equal(held.replay, undefined)
  const quiet = planMirror(entry(), [turn('a', 'A'), turn('b', 'B')], true, FILE_TIME + 1)
  assert.deepEqual(quiet.replay, { user: 'b', assistant: 'B', synced: 2 })
  assert.equal(quiet.entry.checkedAt, FILE_TIME + 1)
})

test('replay: several waiting turns show one per sync, with more set until the last', () => {
  const turns = [turn('a', 'A'), turn('b', 'B'), turn('c', 'C'), turn('d', 'D')]
  let state = entry()
  const shown = []
  const flags = []
  for (let sync = 0; sync < 3; sync += 1) {
    const plan = planMirror(state, turns, true, FILE_TIME)
    shown.push(plan.replay.user)
    flags.push(plan.more)
    state = plan.entry
  }
  assert.deepEqual(shown, ['b', 'c', 'd'])
  assert.deepEqual(flags, [true, true, false])
  assert.equal(state.synced, 4)
  assert.equal(state.checkedAt, FILE_TIME)
})

test('replay: the file time stays old while quiet turns wait', () => {
  const plan = planMirror(entry(), [turn('a', 'A'), turn('b', 'B'), turn('c', 'C')], true, FILE_TIME)
  assert.equal(plan.entry.checkedAt, 2000)
  assert.equal(plan.more, true)
})

test('replay: more counts only complete turns while the chat is active', () => {
  const plan = planMirror(entry(), [turn('a', 'A'), turn('b', 'B'), turn('c', 'C'), turn('d', 'partial')], false, FILE_TIME)
  assert.deepEqual(plan.replay.user, 'b')
  assert.equal(plan.more, true)
})

test('replay: a quiet chat with nothing new records the count and the file time', () => {
  assert.deepEqual(planMirror(entry({ synced: 2 }), [turn('a', 'A'), turn('b', 'B')], true, FILE_TIME), { entry: entry({ synced: 2, checkedAt: FILE_TIME }), more: false })
})

test('replay: a quiet chat whose only new turn has no reply passes over it', () => {
  const plan = planMirror(entry(), [turn('a', 'A'), turn('b', '')], true, FILE_TIME)
  assert.equal(plan.replay, undefined)
  assert.deepEqual(plan.entry, entry({ synced: 2, checkedAt: FILE_TIME }))
})

test('replay: a turn with no reply text does not stop the turn after it', () => {
  const plan = planMirror(entry(), [turn('a', 'A'), turn('b', ''), turn('c', 'C')], true, FILE_TIME)
  assert.deepEqual(plan.replay, { user: 'c', assistant: 'C', synced: 3 })
})

test('replay: a chat with fewer turns than the DSH chat holds shows nothing', () => {
  assert.deepEqual(planMirror(entry({ synced: 5 }), [turn('a', 'A')], true, FILE_TIME), { entry: entry({ synced: 1, checkedAt: FILE_TIME }), more: false })
  assert.equal(nextReplay(5, [turn('a', 'A')]), undefined)
})

test('replay: a chat with no turns shows nothing', () => {
  assert.deepEqual(planMirror(entry({ synced: 0 }), [], false, FILE_TIME), { more: false })
  assert.deepEqual(planMirror(entry({ synced: 0 }), [], true, FILE_TIME), { entry: entry({ synced: 0, checkedAt: FILE_TIME }), more: false })
})

test('resync: a turn that ran from DSH is counted and never shown again', () => {
  const plan = planMirror(entry({ resync: true }), [turn('a', 'A'), turn('b', 'from dsh')], true, FILE_TIME)
  assert.equal(plan.replay, undefined)
  assert.deepEqual(plan.entry, { sessionId: 'session-1', route: 'claude-code', synced: 2, checkedAt: FILE_TIME })
  assert.equal(plan.more, false)
})

test('resync: the mark is gone after the count', () => {
  const plan = planMirror(entry({ resync: true }), [turn('a', 'A')], true, FILE_TIME)
  assert.equal('resync' in plan.entry, false)
})

test('resync: the mark goes on the chat of that session and route only', () => {
  const mirrors = { 'claude:one': entry(), 'claude:two': entry({ sessionId: 'session-2' }), 'codex:three': entry({ route: 'codex-cli' }) }
  const marked = markResync(mirrors, 'session-1|claude-code')
  assert.equal(marked['claude:one'].resync, true)
  assert.equal(marked['claude:two'].resync, undefined)
  assert.equal(marked['codex:three'].resync, undefined)
})

test('resync: the old state is not changed', () => {
  const mirrors = { 'claude:one': entry() }
  markResync(mirrors, 'session-1|claude-code')
  assert.equal(mirrors['claude:one'].resync, undefined)
})

test('resync: a turn in a chat that is not imported changes nothing', () => {
  const mirrors = { 'claude:one': entry() }
  assert.equal(markResync(mirrors, 'session-9|claude-code'), undefined)
  assert.equal(markResync(mirrors, 'session-1|codex-cli'), undefined)
  assert.equal(markResync({}, 'session-1|claude-code'), undefined)
})

test('hidden rows: the engine thread behind a DSH chat has no row of its own', () => {
  assert.deepEqual(nativeThreadRowIds({ 'session-1|claude-code': 'thread-a' }, []), ['claude:thread-a', 'codex:thread-a'])
})

test('hidden rows: a thread of an added instance hides the row of that instance', () => {
  const instances = [{ id: 'work', engine: 'codex', label: 'Work', home: '/h' }]
  assert.deepEqual(nativeThreadRowIds({ 'session-1|work': 'thread-b' }, instances), ['claude:@work:thread-b', 'codex:@work:thread-b'])
})

test('hidden rows: a route that is not an added instance uses the plain ids', () => {
  const instances = [{ id: 'work', engine: 'codex', label: 'Work', home: '/h' }]
  assert.deepEqual(nativeThreadRowIds({ 'session-1|codex-cli': 'thread-c' }, instances), ['claude:thread-c', 'codex:thread-c'])
})

test('hidden rows: no engine threads hide no rows', () => {
  assert.deepEqual(nativeThreadRowIds({}, []), [])
})

test('mirror: a count of turns needs the whole chat, and a panel reads the recent part', async () => {
  const { historyTurnLimit } = await import('../src/mirror.ts')
  assert.equal(historyTurnLimit(true, 20), Number.POSITIVE_INFINITY)
  assert.equal(historyTurnLimit(false, 20), 20)
})
