import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await build({
  absWorkingDir: root,
  entryPoints: ['packages/report-review/src/entry.jsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110'],
  write: false,
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.css': 'text' },
  legalComments: 'inline',
  minify: false,
})
const code = result.outputFiles[0].text.replace(/^[\t ]+$/gm, '')
const wrapped = `window.__ModuleLoader__.load({id:'@tokensapi/dsh-weekly-report',factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\n${code}\nreturn module.exports;\n}});\n`
await mkdir(`${root}/packages/report-review/lib`, { recursive: true })
await writeFile(`${root}/packages/report-review/lib/client.js`, wrapped)
console.log(`Built packages/report-review/lib/client.js (${Buffer.byteLength(wrapped)} bytes)`)
