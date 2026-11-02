#!/usr/bin/env node
// Stand-in for `pi --mode rpc`. It writes session files under PI_CODING_AGENT_SESSION_DIR the way Pi does, and
// the prompt text picks what happens: "dialog" asks a confirm, "select" asks a choice, "input" asks for text,
// "hang" runs until aborted, "fail" ends with a model error, "crash" exits at once, "/handled" starts no run.
// Every command line is appended to the file named by FAKE_PI_LOG.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const args = process.argv.slice(2)
if (process.env.FAKE_PI_LOG) appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`)
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const dir = process.env.PI_CODING_AGENT_SESSION_DIR
const out = record => process.stdout.write(`${JSON.stringify(record)}\n`)

let id = option('--session-id') ?? randomUUID()
let file = option('--session')
let last = null
const write = (entry) => {
  const line = { id: randomUUID().slice(0, 8), parentId: last, timestamp: new Date().toISOString(), ...entry }
  last = line.id
  appendFileSync(file, `${JSON.stringify(line)}\n`)
}
if (file !== undefined) {
  const entries = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  id = entries[0].id
  last = entries.at(-1).id ?? null
}
const create = () => {
  mkdirSync(dir, { recursive: true })
  file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`)
  write({ type: 'message', message: { role: 'system', content: '', sections: {} } })
}

const settled = (aborted = false) => out({ type: 'agent_settled', aborted })
function reply(text) {
  const message = { role: 'assistant', content: [{ type: 'text', text }], usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 }, stopReason: 'stop' }
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } })
  write({ type: 'message', message })
  out({ type: 'message_end', message })
  settled()
}

let answer
let hanging = false
function run(text) {
  if (file === undefined) create()
  const user = { role: 'user', content: [{ type: 'text', text }] }
  write({ type: 'message', message: user })
  out({ type: 'message_end', message: user })
  if (text.includes('crash')) { process.stderr.write('fake pi: boom\n'); process.exit(3) }
  if (text.includes('hang')) { hanging = true; return }
  if (text.includes('fail')) {
    const message = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider is down' }
    write({ type: 'message', message })
    out({ type: 'message_end', message })
    settled()
    return
  }
  if (text.includes('dialog')) {
    out({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Allow it?', message: 'rm -rf build' })
    answer = response => reply(`confirmed=${String(response.confirmed)}`)
    return
  }
  if (text.includes('select')) {
    out({ type: 'extension_ui_request', id: 'ui-2', method: 'select', title: 'Which one?', options: ['Red', 'Blue'] })
    answer = response => reply(`picked=${String(response.value ?? 'nothing')}`)
    return
  }
  if (text.includes('input')) {
    out({ type: 'extension_ui_request', id: 'ui-3', method: 'input', title: 'Name?' })
    answer = response => reply(`cancelled=${String(response.cancelled)}`)
    return
  }
  reply(`echo ${text} model=${option('--model') ?? '-'} thinking=${option('--thinking') ?? '-'}`)
}

const handle = (command) => {
  const respond = data => out({ id: command.id, type: 'response', command: command.type, success: true, ...data === undefined ? {} : { data } })
  switch (command.type) {
    case 'prompt':
      if (command.message.includes('refuse')) return out({ id: command.id, type: 'response', command: 'prompt', success: false, error: 'prompt refused' })
      if (command.message.startsWith('/handled')) return respond({ disposition: 'handled' })
      respond({ disposition: 'started' })
      // Real runs take far longer than the response takes to arrive, so a caller can subscribe first.
      setTimeout(() => run(command.message), 50)
      return undefined
    case 'abort':
      respond()
      if (hanging) { hanging = false; settled(true) }
      return undefined
    case 'extension_ui_response':
      return answer?.(command)
    case 'get_state':
      return respond({ sessionId: id, thinkingLevel: 'medium', model: { provider: 'acme', id: 'big' } })
    case 'get_available_models':
      return respond({ models: [
        { provider: 'acme', id: 'big', name: 'Acme Big', reasoning: true, thinkingLevelMap: { off: null, xhigh: 'xhigh' } },
        { provider: 'acme', id: 'small', name: 'Acme Small', reasoning: false },
      ] })
    case 'get_commands':
      return respond({ commands: [{ name: 'review', description: 'Review the diff', source: 'prompt' }] })
    case 'set_session_name':
      write({ type: 'session_info', name: command.name })
      return respond()
    case 'clone': {
      const source = readFileSync(file, 'utf8').trim().split('\n').slice(1).join('\n')
      id = randomUUID()
      file = join(dir, `2026-01-02T00-00-00-000Z_${id}.jsonl`)
      writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n${source}\n`)
      return respond({ cancelled: false })
    }
    default:
      return out({ id: command.id, type: 'response', command: command.type, success: false, error: `unexpected ${command.type}` })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    handle(JSON.parse(buffer.slice(0, at)))
    buffer = buffer.slice(at + 1)
  }
})
process.stdin.on('end', () => process.exit(0))
