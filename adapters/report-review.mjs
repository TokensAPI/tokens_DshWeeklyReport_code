import * as original from '../packages/report-review/src/index.mjs'
import { generatedRoot } from './runtime-config.mjs'
import { settingsView, updateSettings } from './weknora-runtime.mjs'

export * from '../packages/report-review/src/index.mjs'
export const name = 'tokens-weekly-report-review'
export const inject = original.inject
export function apply(ctx, config = {}) {
  const publishKbId = process.env.TOKENSCOWORK_WEEKLY_REPORT_PUBLISH_KB_ID || settingsView().publishKbId
  return original.apply(ctx, {
    sourceOutputRoot: generatedRoot(),
    settingsApi: { get: () => settingsView(), update: input => updateSettings(input) },
    ...(publishKbId ? { publishKbId } : {}),
    ...config,
  })
}
export default { name, inject, apply }
