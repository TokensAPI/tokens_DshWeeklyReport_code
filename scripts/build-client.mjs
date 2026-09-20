import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import './build-editor-styles.mjs'
import { clientExternals } from './client-externals.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

// Our own BlockNote AI-editor extension lives under packages/report-review/src/editor-ai.
// block-editor.jsx imports it by relative path; the sources import their few `ai` /
// `@ai-sdk` type/helper symbols straight from editor-ai/ai-shim.ts (a local stand-in),
// so no package redirect / aliasing plugin is needed here.

const result = await build({
  absWorkingDir: root,
  entryPoints: ['packages/report-review/src/entry.jsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110'],
  write: false,
  jsx: 'automatic',
  external: clientExternals,
  metafile: true,
  loader: { '.css': 'text' },
  legalComments: 'inline',
  minify: false,
  plugins: [],
})
for (const path of Object.keys(result.metafile.inputs)) {
  if (/(?:^|\/)node_modules\/(?:react|react-dom|scheduler)\//.test(path)) {
    throw new Error(`Host React runtime must not be bundled: ${path}`)
  }
}
const code = result.outputFiles[0].text.replace(/^[\t ]+$/gm, '')
const wrapped = `window.__ModuleLoader__.load({id:'@tokensapi/dsh-weekly-report',factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\n${code}\nreturn module.exports;\n}});\n`
await mkdir(`${root}/packages/report-review/lib`, { recursive: true })
await writeFile(`${root}/packages/report-review/lib/client.js`, wrapped)
console.log(`Built packages/report-review/lib/client.js (${Buffer.byteLength(wrapped)} bytes)`)
