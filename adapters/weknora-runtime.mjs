import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Connector } from '../packages/weknora-connector/src/index.mjs'
import { assetRoots, pluginHome } from './runtime-config.mjs'

// Visual WeKnora configuration. Settings saved from the workbench UI live in
// <pluginHome>/weknora-settings.json; key MATERIAL never enters that file — keys are written to dedicated
// files under <pluginHome>/secrets/ (the connector only accepts secret FILE PATHS, keeping the original
// "no key content in config" rule). Explicit env / profile-patch configuration always overrides UI values.

const KB_ID = /^[A-Za-z0-9_-]{1,128}$/
const TENANT = /^[A-Za-z0-9_-]{1,64}$/

function settingsPath(home) { return path.join(home, 'weknora-settings.json') }
function secretFile(home, purpose) { return path.join(home, 'secrets', `weknora-${purpose}.key`) }

export function readSettings(home = pluginHome()) {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(home), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { return {} }
}

function writeSecret(home, purpose, value) {
  const file = secretFile(home, purpose)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, value, { mode: 0o600 })
  return file
}

// env/profile-derived fields (captured at apply) that take precedence over UI settings.
let staticConfig = {}
let current = null
let lastError = null

function connectorConfig(home) {
  const s = readSettings(home)
  const merged = { timeoutMs: 15000, assetRoots: assetRoots(), ...staticConfig }
  if (!merged.baseUrl && typeof s.baseUrl === 'string' && s.baseUrl) merged.baseUrl = s.baseUrl
  if ((!Array.isArray(merged.allowedKbs) || !merged.allowedKbs.length) && KB_ID.test(s.kbId || '')) merged.allowedKbs = [s.kbId]
  if (!merged.tenantId && TENANT.test(s.tenantId || '')) merged.tenantId = s.tenantId
  if (!merged.readSecretFile && existsSync(secretFile(home, 'read'))) merged.readSecretFile = secretFile(home, 'read')
  if (!merged.writeSecretFile && existsSync(secretFile(home, 'write'))) merged.writeSecretFile = secretFile(home, 'write')
  return merged
}

export function rebuildConnector(home = pluginHome()) {
  const merged = connectorConfig(home)
  if (!merged.baseUrl || !merged.readSecretFile || !merged.allowedKbs?.length) {
    current = null; lastError = merged.baseUrl || merged.readSecretFile || merged.allowedKbs?.length ? 'INCOMPLETE' : null
    return null
  }
  try { current = new Connector(merged); lastError = null }
  catch (error) { current = null; lastError = error?.message || 'invalid_config' }
  return current
}

export function initWeknoraRuntime(config = {}, home = pluginHome()) {
  staticConfig = { ...config }
  delete staticConfig.enabled
  return rebuildConnector(home)
}

// Always-provided handle: property reads delegate to the live Connector (or undefined while unconfigured),
// so review-side `connector?.method` availability checks keep their exact meaning across rebuilds.
export function connectorHandle() {
  return new Proxy({}, {
    get(_, key) {
      if (key === 'then') return undefined
      const value = current?.[key]
      return typeof value === 'function' ? value.bind(current) : value
    },
    has(_, key) { return current ? key in current : false },
  })
}

export function settingsView(home = pluginHome()) {
  const s = readSettings(home)
  const active = Boolean(current)
  return {
    baseUrl: staticConfig.baseUrl || s.baseUrl || '',
    kbId: staticConfig.allowedKbs?.[0] || s.kbId || '',
    readKeySet: Boolean(staticConfig.readSecretFile || existsSync(secretFile(home, 'read'))),
    writeKeySet: Boolean(staticConfig.writeSecretFile || existsSync(secretFile(home, 'write'))),
    managedByHost: Boolean(staticConfig.baseUrl),
    connectorActive: active,
    connectorError: active ? null : lastError,
    publishKbId: staticConfig.publishKbId || (KB_ID.test(s.kbId || '') ? s.kbId : null),
  }
}

const fail = code => { const e = new Error(code); e.code = code; throw e }
export function updateSettings(input, home = pluginHome()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('SETTINGS_INVALID')
  const keys = Object.keys(input)
  if (keys.some(k => !['baseUrl', 'kbId', 'tenantId', 'readKey', 'writeKey'].includes(k))) fail('SETTINGS_INVALID')
  const next = { ...readSettings(home) }
  if (input.baseUrl !== undefined) {
    if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048) fail('SETTINGS_INVALID')
    const value = input.baseUrl.trim()
    if (value) { try { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol)) fail('SETTINGS_INVALID') } catch { fail('SETTINGS_INVALID') } }
    next.baseUrl = value
  }
  if (input.kbId !== undefined) {
    if (typeof input.kbId !== 'string' || (input.kbId.trim() && !KB_ID.test(input.kbId.trim()))) fail('SETTINGS_INVALID')
    next.kbId = input.kbId.trim()
  }
  if (input.tenantId !== undefined) {
    if (typeof input.tenantId !== 'string' || (input.tenantId.trim() && !TENANT.test(input.tenantId.trim()))) fail('SETTINGS_INVALID')
    next.tenantId = input.tenantId.trim()
  }
  for (const [field, purpose] of [['readKey', 'read'], ['writeKey', 'write']]) {
    const value = input[field]
    if (value === undefined || value === '') continue // empty means "keep current key"
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || /[\r\n]/.test(value)) fail('SETTINGS_INVALID')
    writeSecret(home, purpose, value)
  }
  mkdirSync(home, { recursive: true })
  writeFileSync(settingsPath(home), JSON.stringify(next, null, 2))
  rebuildConnector(home)
  return settingsView(home)
}

// Test-only.
export function _resetForTests() { staticConfig = {}; current = null; lastError = null }
