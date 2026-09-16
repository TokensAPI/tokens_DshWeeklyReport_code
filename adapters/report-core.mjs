import plugin from '../packages/report-core/src/index.mjs'
import { dataRoot } from './runtime-config.mjs'

export * from '../packages/report-core/src/index.mjs'
export const name = 'tokens-weekly-report-core'
export function apply(ctx, config = {}) {
  return plugin.apply(ctx, { rootDir: dataRoot(), ...config })
}
export default { name, apply }
