/**
 * Heap watch for finding what fills the Host's memory: a log of heap size and the routes in flight, and one heap
 * snapshot when the heap passes a threshold. Writing the snapshot blocks the Host until it is done. A failed write
 * stops the watch with one warning and never reaches the Host.
 * @module dsh-agent-bridge/diagnostics
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getHeapStatistics, writeHeapSnapshot } from 'node:v8'

/** How often the heap is sampled. */
const SAMPLE_MS = 250
/** A log line is written at least this often, and at every sample while the heap is above the busy level. */
const LOG_EVERY_MS = 60_000
const BUSY_MB = 800
/** The log is moved aside at this size, so it holds at most twice this much. */
const LOG_LIMIT_BYTES = 5 * 1024 * 1024

/** A running heap watch. */
export interface HeapWatch {
  /**
   * Count one route as in flight.
   * @param label - route label.
   * @returns the function that ends the count.
   */
  enter(label: string): () => void
  /** Stop sampling. */
  stop(): void
}

/**
 * Start sampling the heap.
 * @param dir - folder for `heap.log` and the snapshot; created when missing.
 * @param snapshotAtMb - heap size that triggers the one snapshot of this process.
 * @returns the watch.
 */
export function startHeapWatch(dir: string, snapshotAtMb: number): HeapWatch {
  const log = join(dir, 'heap.log')
  const inFlight = new Map<string, number>()
  let lastLog = 0
  let snapshotTaken = false
  const write = (fields: Record<string, unknown>): void => {
    if ((statSync(log, { throwIfNoEntry: false })?.size ?? 0) > LOG_LIMIT_BYTES) renameSync(log, `${log}.old`)
    appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), ...fields })}\n`, { mode: 0o600 })
  }
  const sample = (): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const heapMb = Math.round(getHeapStatistics().used_heap_size / 1048576)
    const now = Date.now()
    const line = { heapMb, rssMb: Math.round(process.memoryUsage.rss() / 1048576), inFlight: Object.fromEntries(inFlight) }
    if (heapMb >= BUSY_MB || now - lastLog >= LOG_EVERY_MS) {
      lastLog = now
      write(line)
    }
    if (heapMb >= snapshotAtMb && !snapshotTaken) {
      snapshotTaken = true
      write({ ...line, snapshot: 'started' })
      const file = writeHeapSnapshot(join(dir, `heap-${process.pid}-${now}.heapsnapshot`))
      write({ snapshot: file, tookMs: Date.now() - now })
    }
  }
  const timer = setInterval(() => {
    try {
      sample()
    } catch (error) {
      clearInterval(timer)
      console.warn('agent-bridge: heap watch stopped:', error)
    }
  }, SAMPLE_MS)
  timer.unref()
  return {
    enter(label) {
      inFlight.set(label, (inFlight.get(label) ?? 0) + 1)
      return () => {
        const left = (inFlight.get(label) ?? 1) - 1
        if (left === 0) inFlight.delete(label)
        else inFlight.set(label, left)
      }
    },
    stop() { clearInterval(timer) },
  }
}
