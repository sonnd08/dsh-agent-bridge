/**
 * Sharing of one in-progress load among concurrent callers asking for the same key.
 * @module dsh-agent-bridge/single-flight
 */

/** Loads keyed values so that concurrent requests for one key run a single load. */
export interface SingleFlight<T> {
  /**
   * Join the load running for `key`, or start one.
   * @param key - what is loaded.
   * @param load - starts the load when none is running for `key`.
   * @returns the load's result; every caller that joined it gets the same value or rejection.
   */
  run(key: string, load: () => Promise<T>): Promise<T>
}

/**
 * Create an empty loader. A key is forgotten once its load settles, so the next request reads fresh data.
 * @returns the loader.
 */
export function createSingleFlight<T>(): SingleFlight<T> {
  const running = new Map<string, Promise<T>>()
  return {
    run(key, load) {
      const joined = running.get(key)
      if (joined !== undefined) return joined
      const started = load().finally(() => { running.delete(key) })
      running.set(key, started)
      return started
    },
  }
}
