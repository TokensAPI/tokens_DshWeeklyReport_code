import * as original from '../packages/report-pdf/index.js'
import path from 'node:path'
import { dataRoot, fontPath, pluginHome, pythonCommand } from './runtime-config.mjs'

export * from '../packages/report-pdf/index.js'
export const name = 'tokens-weekly-report-pdf'
export function apply(ctx, config = {}) {
  return original.apply(ctx, {
    cacheDir: path.join(pluginHome(), 'pdf-cache'),
    assetRoots: [dataRoot()],
    pythonPath: pythonCommand(),
    fontPath: fontPath(),
    ...config,
  })
}
export default { name, apply }
