/**
 * Reads the model that a Claude Code or Codex session used last, from the end of its session file.
 * @module dsh-agent-bridge/used-model
 */
import { open } from 'node:fs/promises'
import type { EngineName, UsedModelWire } from './protocol.ts'

/** How much of the end of a file to read, in order. */
const TAIL_BYTES = [1 << 18, 1 << 22, Number.MAX_SAFE_INTEGER] as const

type Pick = (record: Record<string, unknown>) => UsedModelWire | undefined

function timeOf(record: Record<string, unknown>): { at?: number } {
  const at = typeof record['timestamp'] === 'string' ? Date.parse(record['timestamp']) : Number.NaN
  return Number.isNaN(at) ? {} : { at }
}

const claudeUsed: Pick = (record) => {
  if (record['type'] !== 'assistant' || record['isSidechain'] === true) return undefined
  const model = (record['message'] as { model?: unknown } | undefined)?.model
  if (typeof model !== 'string' || model === '' || model.startsWith('<')) return undefined
  return { model, ...typeof record['effort'] === 'string' && record['effort'] !== '' ? { effort: record['effort'] } : {}, ...timeOf(record) }
}

const codexUsed: Pick = (record) => {
  if (record['type'] !== 'turn_context') return undefined
  const payload = record['payload'] as { model?: unknown; effort?: unknown } | undefined
  if (typeof payload?.model !== 'string' || payload.model === '') return undefined
  return { model: payload.model, ...typeof payload.effort === 'string' && payload.effort !== '' ? { effort: payload.effort } : {}, ...timeOf(record) }
}

function lastUsedIn(text: string, pick: Pick, marker: string): UsedModelWire | undefined {
  for (let end = text.length; end > 0;) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const line = text.slice(start, end).trim()
    end = start - 1
    if (!line.includes(marker)) continue
    try {
      const used = pick(JSON.parse(line) as Record<string, unknown>)
      if (used !== undefined) return used
    } catch {
      // The engine can be writing the last line of the file. An older line gives the answer.
    }
  }
  return undefined
}

/**
 * @param engine - the engine that wrote the file.
 * @param file - path of the session file.
 * @returns the model and reasoning level of the last turn, if the file records one.
 */
export async function lastUsedModel(engine: EngineName, file: string): Promise<UsedModelWire | undefined> {
  if (engine === 'pi') return undefined
  const pick = engine === 'claude' ? claudeUsed : codexUsed
  const marker = engine === 'claude' ? '"assistant"' : '"turn_context"'
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    for (const tail of TAIL_BYTES) {
      const length = Math.min(tail, size)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      const text = buffer.toString('utf8')
      // A read that starts inside the file starts inside a line.
      const whole = length === size ? text : text.slice(text.indexOf('\n') + 1)
      const used = lastUsedIn(whole, pick, marker)
      if (used !== undefined || length === size) return used
    }
    return undefined
  } finally {
    await handle.close()
  }
}
