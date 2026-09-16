import * as original from '../packages/weekly-report-source/lib/plugin.js'
import { generatedRoot } from './runtime-config.mjs'
import { resolvePython } from './python-runtime.mjs'

export * from '../packages/weekly-report-source/lib/plugin.js'
export const name = 'tokens-weekly-report-source'
export function apply(ctx, config = {}) {
  // `pythonPath` is accepted as an alias for `python` (mirror of the report-pdf row) so a profile override
  // written with either key configures both rows consistently.
  const { pythonPath, ...rest } = config
  return original.apply(ctx, { outputRoot: generatedRoot(), python: pythonPath ?? resolvePython(), ...rest })
}
export default { name, apply }
