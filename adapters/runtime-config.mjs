import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'

const env = process.env

export function pluginHome() {
  return path.resolve(env.TOKENSCOWORK_WEEKLY_REPORT_HOME || path.join(os.homedir(), '.tokenscowork', 'weekly-report'))
}

export function dataRoot() {
  return path.resolve(env.TOKENSCOWORK_WEEKLY_REPORT_DATA_DIR || path.join(pluginHome(), 'data'))
}

export function generatedRoot() {
  return path.resolve(env.TOKENSCOWORK_WEEKLY_REPORT_OUTPUT_DIR || path.join(pluginHome(), 'generated'))
}

export function pythonCommand() {
  return env.TOKENSCOWORK_WEEKLY_REPORT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
}

export function fontPath() {
  if (env.TOKENSCOWORK_WEEKLY_REPORT_FONT_PATH) return path.resolve(env.TOKENSCOWORK_WEEKLY_REPORT_FONT_PATH)
  const candidates = process.platform === 'win32'
    ? [path.join(env.WINDIR || 'C:\\Windows', 'Fonts', 'msyh.ttc'), path.join(env.WINDIR || 'C:\\Windows', 'Fonts', 'simhei.ttf')]
    : process.platform === 'darwin'
      ? ['/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/PingFang.ttc']
      : ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
  return candidates.find(existsSync) || candidates[0]
}

export function listEnv(name) {
  return (env[name] || '').split(',').map(value => value.trim()).filter(Boolean)
}

export function assetRoots() {
  // Extra roots let PDF/connector read assets written under a previous data root (e.g. drafts created by a
  // pre-bundle install); nonexistent extras are dropped because the renderer realpath()s every root up front.
  const extras = listEnv('TOKENSCOWORK_WEEKLY_REPORT_ASSET_ROOTS').map(value => path.resolve(value)).filter(existsSync)
  return [...new Set([dataRoot(), ...extras])]
}
