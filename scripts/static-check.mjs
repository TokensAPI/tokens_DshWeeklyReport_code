import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(manifest.name, '@tokensapi/dsh-weekly-report')
assert.match(manifest.version, /^\d+\.\d+\.\d+$/u)
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
assert.equal(lock.version, manifest.version)
assert.equal(lock.packages[''].version, manifest.version)
assert.equal(manifest.publishConfig?.registry, 'https://npm.tokensapi.ai/')
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(manifest.dsh?.client?.platform, 'web')
assert.deepEqual(manifest.dependencies, {})
assert.ok(!manifest.scripts?.preinstall && !manifest.scripts?.install && !manifest.scripts?.postinstall)
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
for (const id of ['core', 'pdf', 'source', 'weknora', 'review']) assert.match(patch, new RegExp(`tokens-weekly-report-${id}`))
assert.doesNotMatch(patch, /\/Users\/|[A-Za-z]:\\|secret.*(?:key|=)|api[_-]?key\s*:/iu)
const client = await readFile(new URL('../packages/report-review/lib/client.js', import.meta.url), 'utf8')
assert.match(client, /__ModuleLoader__\.load\(\{id:'@tokensapi\/dsh-weekly-report'/u)
for (const entry of ['../adapters/report-core.mjs', '../adapters/report-pdf.mjs', '../adapters/weekly-report-source.mjs', '../adapters/weknora-connector.mjs', '../adapters/report-review.mjs']) {
  const loaded = await import(new URL(entry, import.meta.url))
  assert.equal(typeof loaded.default?.apply, 'function', entry)
}
console.log('Static package checks passed')
