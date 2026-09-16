import * as original from '../packages/report-pdf/index.js'
import path from 'node:path'
import { assetRoots, fontPath, pluginHome } from './runtime-config.mjs'
import { resolvePython } from './python-runtime.mjs'

export * from '../packages/report-pdf/index.js'
export const name = 'tokens-weekly-report-pdf'
export function apply(ctx, config = {}) {
  // `python` is accepted as an alias for `pythonPath` so one profile override key works for both this row
  // and tokens-weekly-report-source; an explicit `pythonPath` in config still wins via the spread below.
  const { python, ...rest } = config
  return original.apply(ctx, {
    cacheDir: path.join(pluginHome(), 'pdf-cache'),
    assetRoots: assetRoots(),
    pythonPath: python ?? resolvePython(),
    fontPath: fontPath(),
    ...rest,
  })
}
export default { name, apply }
