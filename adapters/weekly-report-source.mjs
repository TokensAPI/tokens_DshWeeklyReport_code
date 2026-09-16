import * as original from '../packages/weekly-report-source/lib/plugin.js'
import { generatedRoot, pythonCommand } from './runtime-config.mjs'

export * from '../packages/weekly-report-source/lib/plugin.js'
export const name = 'tokens-weekly-report-source'
export function apply(ctx, config = {}) {
  return original.apply(ctx, { outputRoot: generatedRoot(), python: pythonCommand(), ...config })
}
export default { name, apply }
