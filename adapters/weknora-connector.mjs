import { listEnv } from './runtime-config.mjs'
import { connectorHandle, initWeknoraRuntime } from './weknora-runtime.mjs'

export * from '../packages/weknora-connector/src/index.mjs'
export const name = 'tokens-weekly-report-weknora'
export function apply(ctx, config = {}) {
  // Env / profile-patch values stay authoritative; UI-saved settings (weknora-runtime) fill the gaps. The
  // provided handle delegates to the live connector, so saving settings activates WeKnora without restart.
  const fromEnv = {
    baseUrl: process.env.TOKENSCOWORK_WEEKLY_REPORT_WEKNORA_URL,
    readSecretFile: process.env.TOKENSCOWORK_WEEKLY_REPORT_READ_SECRET_FILE,
    writeSecretFile: process.env.TOKENSCOWORK_WEEKLY_REPORT_WRITE_SECRET_FILE,
    tenantId: process.env.TOKENSCOWORK_WEEKLY_REPORT_TENANT_ID,
    allowedKbs: listEnv('TOKENSCOWORK_WEEKLY_REPORT_ALLOWED_KBS'),
  }
  for (const [key, value] of Object.entries(fromEnv)) if (value === undefined || (Array.isArray(value) && !value.length)) delete fromEnv[key]
  initWeknoraRuntime({ ...fromEnv, ...config })
  ctx.provide('weknoraConnector', connectorHandle())
}
export default { name, apply }
