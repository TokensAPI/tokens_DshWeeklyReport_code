import { Connector } from '../packages/weknora-connector/src/index.mjs'
import { dataRoot, listEnv } from './runtime-config.mjs'

export * from '../packages/weknora-connector/src/index.mjs'
export const name = 'tokens-weekly-report-weknora'
export function apply(ctx, config = {}) {
  const enabled = config.enabled === true || process.env.TOKENSCOWORK_WEEKLY_REPORT_CONNECTOR_ENABLED === '1'
  if (!enabled) return
  const merged = {
    baseUrl: process.env.TOKENSCOWORK_WEEKLY_REPORT_WEKNORA_URL,
    readSecretFile: process.env.TOKENSCOWORK_WEEKLY_REPORT_READ_SECRET_FILE,
    writeSecretFile: process.env.TOKENSCOWORK_WEEKLY_REPORT_WRITE_SECRET_FILE,
    tenantId: process.env.TOKENSCOWORK_WEEKLY_REPORT_TENANT_ID,
    allowedKbs: listEnv('TOKENSCOWORK_WEEKLY_REPORT_ALLOWED_KBS'),
    assetRoots: [dataRoot()],
    ...config,
  }
  delete merged.enabled
  ctx.provide('weknoraConnector', new Connector(merged))
}
export default { name, apply }
