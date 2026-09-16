import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { pluginHome } from './runtime-config.mjs'

// Zero-config Python resolution. A fresh machine must not require the user to hand-build a venv or set
// env vars: at first apply we probe common interpreters for the two third-party deps this bundle needs
// (matplotlib for the generator, pymupdf for the PDF renderer). If none qualifies we point both rows at a
// managed venv under pluginHome and provision it in the background (venv + pip install, PIP_INDEX_URL
// honored). Explicit env/config overrides always win and are never validated or second-guessed.

export const REQUIRED_MODULES = ['matplotlib', 'pymupdf']
const PROBE = `import importlib.util,sys; sys.exit(0 if all(importlib.util.find_spec(m) for m in ${JSON.stringify(REQUIRED_MODULES)}) else 1)`

export function managedVenvPython(home = pluginHome()) {
  return process.platform === 'win32'
    ? path.join(home, 'venv', 'Scripts', 'python.exe')
    : path.join(home, 'venv', 'bin', 'python')
}

function cachePath(home) { return path.join(home, 'python-runtime.json') }
function logPath(home) { return path.join(home, 'python-setup.log') }
function log(home, line) {
  try { appendFileSync(logPath(home), `${new Date().toISOString()} ${line}\n`) } catch {}
}

export function probeInterpreter(exe) {
  try {
    return spawnSync(exe, ['-c', PROBE], { stdio: 'ignore', timeout: 15000 }).status === 0
  } catch { return false }
}

function candidateInterpreters(home) {
  const fromPath = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']
  const wellKnown = process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']
  return [managedVenvPython(home), ...fromPath, ...wellKnown]
}

// A base interpreter only needs to exist and support venv; dependency modules come from pip afterwards.
function findBaseInterpreter(home) {
  for (const exe of candidateInterpreters(home).slice(1)) {
    try { if (spawnSync(exe, ['-c', 'import venv'], { stdio: 'ignore', timeout: 15000 }).status === 0) return exe } catch {}
  }
  return null
}

let provisioning = null
export function provisionManagedVenv(home = pluginHome()) {
  if (provisioning) return provisioning
  provisioning = (async () => {
    const target = managedVenvPython(home)
    const venvDir = path.join(home, 'venv')
    const base = findBaseInterpreter(home)
    if (!base) { log(home, 'provision failed: no base python (install Python 3.9+ and restart)'); return false }
    const run = (exe, args) => new Promise(resolve => {
      const child = spawn(exe, args, { stdio: 'ignore' })
      child.on('error', () => resolve(1)); child.on('close', code => resolve(code ?? 1))
    })
    if (!existsSync(target)) {
      log(home, `provision: creating venv at ${venvDir} with ${base}`)
      if (await run(base, ['-m', 'venv', venvDir]) !== 0) { log(home, 'provision failed: venv creation'); return false }
    }
    log(home, `provision: pip install ${REQUIRED_MODULES.join(' ')}`)
    if (await run(target, ['-m', 'pip', 'install', '--disable-pip-version-check', ...REQUIRED_MODULES]) !== 0) {
      log(home, 'provision failed: pip install (check network / set PIP_INDEX_URL to a mirror)'); return false
    }
    if (!probeInterpreter(target)) { log(home, 'provision failed: modules still missing after install'); return false }
    try { writeFileSync(cachePath(home), JSON.stringify({ python: target })) } catch {}
    log(home, `provision done: ${target}`)
    return true
  })().finally(() => { provisioning = null })
  return provisioning
}

let resolved = null
export function resolvePython({ home = pluginHome(), env = process.env } = {}) {
  if (env.TOKENSCOWORK_WEEKLY_REPORT_PYTHON) return env.TOKENSCOWORK_WEEKLY_REPORT_PYTHON
  if (resolved) return resolved
  try { mkdirSync(home, { recursive: true }) } catch {}
  try {
    const cached = JSON.parse(readFileSync(cachePath(home), 'utf8')).python
    // Cheap revalidation: the binary must still exist; a full module probe re-runs only on cache miss.
    if (typeof cached === 'string' && existsSync(cached)) return (resolved = cached)
  } catch {}
  for (const exe of candidateInterpreters(home)) {
    if (probeInterpreter(exe)) {
      try { writeFileSync(cachePath(home), JSON.stringify({ python: exe })) } catch {}
      return (resolved = exe)
    }
  }
  // Nothing usable: converge on the managed venv and build it in the background. Until it is ready a
  // generation attempt fails with cause=ENOENT / GENERATION_FAILED, and python-setup.log says why.
  provisionManagedVenv(home)
  return (resolved = managedVenvPython(home))
}

// Test-only: clear memoization so resolution can be exercised against a scratch home.
export function _resetForTests() { resolved = null }
