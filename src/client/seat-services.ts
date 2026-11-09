/** Keeps the model seat services of a session in step with the session's model directory. */

/**
 * Make the function that gives a session its seat services. DSH disposes a session's directory with its scope and makes
 * a new one when the session opens again, so the services follow the directory and not the session id.
 * @param resolve - gives the current directory of a session; it throws when the session is not ready.
 * @param build - makes the services of one directory, or of no directory.
 * @returns a function that gives the same services object until the directory of the session changes.
 */
export function servicesPerDirectory<Directory extends object, Services>(
  resolve: (sessionId: string) => Directory,
  build: (sessionId: string, directory: Directory | undefined) => Services,
): (sessionId: string) => Services {
  const known = new WeakMap<Directory, Services>()
  return (sessionId) => {
    let directory: Directory
    try {
      directory = resolve(sessionId)
    } catch (error) {
      console.warn('agent-bridge: model directory is not ready', error)
      return build(sessionId, undefined)
    }
    const existing = known.get(directory)
    if (existing !== undefined) return existing
    const services = build(sessionId, directory)
    known.set(directory, services)
    return services
  }
}
