import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReportStore } from '../src/index.mjs';

async function store(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run19-templates-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  return new ReportStore({ rootDir });
}

test('prompt templates are per-session: empty until saved, then list/save/delete round-trips', async t => {
  const s = await store(t);
  assert.deepEqual(await s.listPromptTemplates({ sessionId: 's1' }), []);
  // Save a new template (id generated).
  const saved = await s.savePromptTemplate({ sessionId: 's1', name: '默认综合分析', content: '## 风险提示\n- a' });
  assert.ok(saved.id); assert.equal(saved.name, '默认综合分析'); assert.equal(saved.content, '## 风险提示\n- a'); assert.ok(saved.updatedAt);
  // Session isolation: another session sees nothing.
  assert.deepEqual(await s.listPromptTemplates({ sessionId: 's2' }), []);
  // List for s1 returns the saved template.
  const listed = await s.listPromptTemplates({ sessionId: 's1' });
  assert.equal(listed.length, 1); assert.equal(listed[0].id, saved.id); assert.equal(listed[0].name, '默认综合分析');
  // Update the same id preserves position and replaces content.
  const updated = await s.savePromptTemplate({ sessionId: 's1', id: saved.id, name: '重命名', content: '## 风险提示\n- b' });
  assert.equal(updated.id, saved.id); assert.equal(updated.name, '重命名'); assert.equal(updated.content, '## 风险提示\n- b');
  assert.equal((await s.listPromptTemplates({ sessionId: 's1' })).length, 1);
  // Delete.
  assert.equal(await s.deletePromptTemplate({ sessionId: 's1', id: saved.id }), true);
  assert.deepEqual(await s.listPromptTemplates({ sessionId: 's1' }), []);
  // Deleting a missing id returns false, not an error.
  assert.equal(await s.deletePromptTemplate({ sessionId: 's1', id: 'nope' }), false);
});

test('prompt templates persist across store instances (same rootDir) and reject empty content', async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run19-templates-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const a = new ReportStore({ rootDir });
  const saved = await a.savePromptTemplate({ sessionId: 's1', name: 'N', content: 'hello' });
  // A fresh store reading the same rootDir still sees the template.
  const b = new ReportStore({ rootDir });
  assert.equal((await b.listPromptTemplates({ sessionId: 's1' }))[0].id, saved.id);
  await assert.rejects(a.savePromptTemplate({ sessionId: 's1', name: 'N', content: '   ' }), /content is required/);
});
