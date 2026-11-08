/** Removes the build machine's folder from the committed bundles, where the bundler writes it in region comments. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
for (const name of ['lib/client.js', 'lib/index.js']) {
  const file = join(root, name)
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll(`${root}/`, ''))
}
