import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateSettings, settingsView, readSettings, rebuildConnector, connectorHandle, _resetForTests } from '../../../adapters/weknora-runtime.mjs'

const scratch = () => mkdtemp(join(tmpdir(), 'wr-weknora-'))

test('settings persist, keys land in restricted files and are never echoed', async () => {
  const home = await scratch()
  try {
    _resetForTests()
    const view = updateSettings({ baseUrl: 'http://127.0.0.1:8080', kbId: 'kb-demo', readKey: 'sk-read-1' }, home)
    assert.equal(view.baseUrl, 'http://127.0.0.1:8080')
    assert.equal(view.kbId, 'kb-demo')
    assert.equal(view.readKeySet, true)
    assert.equal(view.writeKeySet, false)
    assert.ok(!('readKey' in view) && !('writeKey' in view))
    assert.equal(await readFile(join(home, 'secrets', 'weknora-read.key'), 'utf8'), 'sk-read-1')
    const stored = readSettings(home)
    assert.ok(!JSON.stringify(stored).includes('sk-read-1'), 'key material must not enter the settings json')
    // Complete settings activate a real connector without any env configuration.
    assert.equal(view.connectorActive, true)
    assert.equal(view.publishKbId, 'kb-demo')
  } finally { _resetForTests(); await rm(home, { recursive: true, force: true }) }
})

test('empty key field keeps the previously saved key', async () => {
  const home = await scratch()
  try {
    _resetForTests()
    updateSettings({ baseUrl: 'http://127.0.0.1:1', kbId: 'kb', readKey: 'first' }, home)
    updateSettings({ baseUrl: 'http://127.0.0.1:1', kbId: 'kb', readKey: '' }, home)
    assert.equal(await readFile(join(home, 'secrets', 'weknora-read.key'), 'utf8'), 'first')
  } finally { _resetForTests(); await rm(home, { recursive: true, force: true }) }
})

test('invalid fields are rejected with SETTINGS_INVALID and nothing is written', async () => {
  const home = await scratch()
  try {
    _resetForTests()
    for (const bad of [
      { baseUrl: 'ftp://x' },
      { kbId: 'has space' },
      { readKey: 'line\nbreak' },
      { unexpected: 'field' },
    ]) assert.throws(() => updateSettings(bad, home), e => e.code === 'SETTINGS_INVALID')
    assert.equal(existsSync(join(home, 'weknora-settings.json')), false)
  } finally { _resetForTests(); await rm(home, { recursive: true, force: true }) }
})

test('incomplete settings leave the connector inactive and the handle inert', async () => {
  const home = await scratch()
  try {
    _resetForTests()
    updateSettings({ baseUrl: 'http://127.0.0.1:9', kbId: 'kb-x' }, home) // no read key yet
    const view = settingsView(home)
    assert.equal(view.connectorActive, false)
    assert.equal(view.connectorError, 'INCOMPLETE')
    const handle = connectorHandle()
    assert.equal(handle.search, undefined)
    assert.equal(handle.identity, undefined)
  } finally { _resetForTests(); await rm(home, { recursive: true, force: true }) }
})

test('non-loopback plain http is rejected by the connector and surfaced as an error', async () => {
  const home = await scratch()
  try {
    _resetForTests()
    updateSettings({ baseUrl: 'http://weknora.internal', kbId: 'kb-x', readKey: 'k' }, home)
    rebuildConnector(home)
    const view = settingsView(home)
    assert.equal(view.connectorActive, false)
    assert.equal(view.connectorError, 'plaintext_non_loopback')
  } finally { _resetForTests(); await rm(home, { recursive: true, force: true }) }
})
