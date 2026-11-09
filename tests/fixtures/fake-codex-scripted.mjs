#!/usr/bin/env node
// Stand-in for `codex app-server` that follows a scenario. FAKE_CODEX_SCENARIO names a JSON file that maps a method to a
// list of steps; the nth call of the method uses the nth step, and the last step repeats. A step is
// { result?, error?, exit?, then? }: `then` lists the notifications and requests to send a moment after the reply.
// Every message from the client is appended to the file named by FAKE_CODEX_LOG.
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const scenario = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCENARIO, 'utf8'))
const calls = new Map()
const write = (message) => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(message)}\n`)
  if (message.id === undefined || message.method === undefined) return
  if (message.method === 'initialize') return write({ id: message.id, result: { userAgent: 'fake' } })
  const steps = scenario[message.method]
  if (steps === undefined) {
    if (message.method === 'thread/unsubscribe' || message.method === 'turn/interrupt') return write({ id: message.id, result: {} })
    return write({ id: message.id, error: { code: -1, message: `unexpected ${message.method}` } })
  }
  const count = calls.get(message.method) ?? 0
  calls.set(message.method, count + 1)
  const step = steps[Math.min(count, steps.length - 1)]
  if (step.exit === true) process.exit(1)
  write(step.error === undefined ? { id: message.id, result: step.result ?? {} } : { id: message.id, error: step.error })
  // The real app-server answers a request before it reports what the request started.
  setTimeout(() => { for (const follow of step.then ?? []) write(follow) }, 5)
})
