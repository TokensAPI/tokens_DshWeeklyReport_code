import * as original from '../packages/report-review/src/index.mjs'
import { generatedRoot } from './runtime-config.mjs'

export * from '../packages/report-review/src/index.mjs'
export const name = 'tokens-weekly-report-review'
export const inject = original.inject
export function apply(ctx, config = {}) {
  const publishKbId = process.env.TOKENSCOWORK_WEEKLY_REPORT_PUBLISH_KB_ID
  return original.apply(ctx, {
    sourceOutputRoot: generatedRoot(),
    ...(publishKbId ? { publishKbId } : {}),
    ...config,
  })
}
export default { name, inject, apply }
