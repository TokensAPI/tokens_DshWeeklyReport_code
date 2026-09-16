import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePython, probeInterpreter, managedVenvPython, _resetForTests } from '../../../adapters/python-runtime.mjs'

test('explicit env override wins and skips discovery entirely', () => {
  _resetForTests()
  const python = resolvePython({ home: join(tmpdir(), 'wr-noexist'), env: { TOKENSCOWORK_WEEKLY_REPORT_PYTHON: '/custom/venv/bin/python' } })
  assert.equal(python, '/custom/venv/bin/python')
})

test('cached validated interpreter is reused without re-probing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wr-pyrt-'))
  try {
    // process.execPath exists, so the cheap existence revalidation passes and no candidate probing runs.
    await writeFile(join(home, 'python-runtime.json'), JSON.stringify({ python: process.execPath }))
    _resetForTests()
    assert.equal(resolvePython({ home, env: {} }), process.execPath)
  } finally { _resetForTests(); await rm(home, { recursive: true, force: true }) }
})

test('probeInterpreter is false for a missing binary', () => {
  assert.equal(probeInterpreter(join(tmpdir(), 'wr-definitely-missing', 'python')), false)
})

test('managed venv path is platform-shaped under the plugin home', () => {
  const home = join(tmpdir(), 'wr-home')
  const expected = process.platform === 'win32' ? join(home, 'venv', 'Scripts', 'python.exe') : join(home, 'venv', 'bin', 'python')
  assert.equal(managedVenvPython(home), expected)
})
