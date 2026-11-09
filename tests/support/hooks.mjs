/** Module hooks for unit tests of the React components. They replace CSS Modules and find browser packages in the DSH checkout. */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// The plugin folder is 3 levels below the DSH checkout, and the browser packages are dependencies of the DSH client packages.
const anchors = ['packages/client/ui-primitives', 'packages/client/ui-conversation'].map(folder => createRequire(join(here, '../../../../..', folder, 'package.json')))
const SHARED = /^(react|react-dom|jsdom)($|\/)|^@deepseek-ai\/dsh-client-ui-primitives($|\/)/

export async function resolve(specifier, context, nextResolve) {
  if (SHARED.test(specifier)) {
    for (const anchor of anchors) {
      try {
        return { url: pathToFileURL(anchor.resolve(specifier)).href, shortCircuit: true }
      } catch (error) {
        if (error?.code !== 'MODULE_NOT_FOUND') throw error
      }
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.split('?')[0].endsWith('.css')) {
    return { format: 'module', shortCircuit: true, source: 'export default new Proxy({}, { get: (_target, name) => String(name) })' }
  }
  return nextLoad(url, context)
}
