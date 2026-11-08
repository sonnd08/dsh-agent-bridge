import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeExtraArgs, expandHome, parseInstance, splitLaunchArgs } from '../src/instances.ts'
import { draftIdFor, engineOfSession, isDraftId, providerEngine, providerId, providerInstance, providerOfSession, withInstanceId } from '../src/protocol.ts'
import { isSignedIn } from '../src/run.ts'

const good = { id: 'work', engine: 'codex', label: 'Work', home: '~/.codex-work' }

test('instances: an account report with no token or key is not signed in', () => {
  assert.equal(isSignedIn({ tokenSource: 'none', apiProvider: 'firstParty' }), false)
  assert.equal(isSignedIn({}), false)
  assert.equal(isSignedIn({ tokenSource: 'claude.ai', apiProvider: 'firstParty' }), true)
  assert.equal(isSignedIn({ tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY' }), true)
  assert.equal(isSignedIn({ email: 'a@b.c' }), true)
  assert.equal(isSignedIn({ apiProvider: 'bedrock' }), true)
})

test('instances: a valid instance is accepted and cleaned', () => {
  assert.deepEqual(parseInstance({ ...good, label: ' Work ', binaryPath: ' ', launchArgs: '' }, []), { instance: good })
  assert.deepEqual(parseInstance({ ...good, accent: '#ff0000', binaryPath: '/bin/codex', launchArgs: '--x' }, []), { instance: { ...good, accent: '#ff0000', binaryPath: '/bin/codex', launchArgs: '--x' } })
})

test('instances: invalid values are refused with a reason', () => {
  for (const change of [{ engine: 'pi' }, { id: 'a b' }, { id: 'claude' }, { id: 'codex' }, { id: 'dsh' }, { label: ' ' }, { home: '' }, { home: 'relative/path' }, { accent: 'red' }]) {
    assert.ok('error' in parseInstance({ ...good, ...change }, []), JSON.stringify(change))
  }
  assert.ok('error' in parseInstance(good, [good]))
  assert.ok('error' in parseInstance(null, []))
})

test('instances: a home path expands from ~', () => {
  assert.equal(expandHome('~/.x'), join(homedir(), '.x'))
  assert.equal(expandHome('/abs'), '/abs')
})

test('instances: launch arguments are split without a shell', () => {
  assert.deepEqual(splitLaunchArgs('  --a  b '), ['--a', 'b'])
  assert.deepEqual(splitLaunchArgs(undefined), [])
  assert.deepEqual(claudeExtraArgs('--chrome --model opus'), { chrome: null, model: 'opus' })
})

test('providers: ids keep the engine and name the instance', () => {
  assert.equal(providerId('claude', undefined), 'claude')
  assert.equal(providerId('codex', 'work'), 'codex@work')
  assert.equal(providerEngine('codex@work'), 'codex')
  assert.equal(providerInstance('codex@work'), 'work')
  assert.equal(providerInstance('codex'), undefined)
})

test('providers: a session id names its provider, and old ids keep working', () => {
  assert.equal(withInstanceId('codex:abc', 'work'), 'codex:@work:abc')
  assert.equal(providerOfSession('codex:@work:abc'), 'codex@work')
  assert.equal(engineOfSession('codex:@work:abc'), 'codex')
  assert.equal(providerOfSession('claude:abc'), 'claude')
  assert.equal(providerOfSession(undefined), 'claude')
  assert.equal(providerOfSession('pi:abc'), 'pi')
})

test('providers: each provider has a draft id', () => {
  assert.equal(draftIdFor('claude'), 'claude:new')
  assert.equal(draftIdFor('codex'), 'codex:new')
  assert.equal(draftIdFor('codex@work'), 'codex:@work:new')
  assert.ok(isDraftId('codex:@work:new'))
  assert.ok(isDraftId('claude:new'))
  assert.equal(isDraftId('codex:@work:abc'), false)
  assert.equal(isDraftId(undefined), false)
})
