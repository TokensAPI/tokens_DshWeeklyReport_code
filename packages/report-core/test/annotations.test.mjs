import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReportStore, markdownBlocks } from '../src/index.mjs';
const alice = { authorId: 'a', displayName: 'Alice' }, bob = { authorId: 'b', displayName: 'Bob' };
async function fixture(t, markdown) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run19-annotations-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = new ReportStore({ rootDir });
  const draft = await store.createDraft({ sessionId: 's', title: 'Blocks', markdown });
  return { store, draft, input: { sessionId: 's', reportId: draft.reportId } };
}
test('editing one paragraph does not relabel untouched generated paragraphs; preserves history', async t => {
  const { store, draft, input } = await fixture(t, '# Title\n\nLLM first\n\nLLM second');
  assert.ok(draft.annotations.every(a => a.source === 'agent_inference' && !a.public));
  let changed = await store.saveDraft({ ...input, saveToken: draft.saveToken, markdown: '# Title\n\nHuman first\n\nLLM second', source: 'user_direct' });
  assert.equal(changed.annotations.filter(a => a.public).length, 1);
  assert.equal(changed.annotations.find(a => a.public).target.quote, 'Human first');
  const v1 = await store.confirm({ ...input, saveToken: changed.saveToken, author: alice });
  const historic = v1.annotations.find(a => a.public);
  assert.equal(historic.authorId, 'a'); assert.equal(historic.pending, false); assert.ok(historic.completedAt);
  changed = await store.startRevision({ ...input, versionId: 'V1' });
  changed = await store.saveDraft({ ...input, saveToken: changed.saveToken, markdown: '# Title\n\nHuman first\n\nPrompt second', source: 'user_prompt', instruction: 'secret prompt' });
  const v2 = await store.confirm({ ...input, saveToken: changed.saveToken, author: bob });
  assert.deepEqual(v2.annotations.find(a => a.id === historic.id), historic);
  assert.equal(v2.annotations.find(a => a.source === 'user_prompt').authorId, 'b');
  const exported = await store.exportVersion({ ...input, versionId: 'V2' });
  assert.equal(exported.annotations.length, 2);
  assert.deepEqual(exported.annotations.map(a => a.target.quote), ['Human first', 'Prompt second']);
  assert.ok(!JSON.stringify(exported).includes('secret prompt'));
});
test('table edit attributes full table and list / blockquote semantic targets', async t => {
  const md = '| Key | Value |\n| --- | --- |\n| x | 1 |\n\n- first\n- second\n\n> Quote\n> continued';
  const { store, draft, input } = await fixture(t, md);
  const changed = await store.saveDraft({ ...input, saveToken: draft.saveToken, markdown: md.replace('| x | 1 |', '| x | 2 |'), source: 'user_prompt' });
  const annotations = changed.annotations.filter(a => a.public);
  assert.equal(annotations.length, 1); assert.equal(annotations[0].kind, 'table');
  assert.deepEqual(annotations[0].target, { startLine: 1, endLine: 3, quote: '| Key | Value |\n| --- | --- |\n| x | 2 |' });
  assert.deepEqual(markdownBlocks(md).map(b => b.kind), ['table', 'list', 'blockquote']);
});
test('repeated blocks remain uncertain and are excluded from public annotation export', async t => {
  const { store, draft, input } = await fixture(t, 'same\n\nsame\n\nold');
  const changed = await store.saveDraft({ ...input, saveToken: draft.saveToken, markdown: 'same\n\nsame\n\nnew', source: 'user_direct' });
  assert.equal(changed.warnings.length, 2);
  assert.equal(changed.annotations.filter(a => a.mappingConfidence === 'low').length, 2);
  await store.confirm({ ...input, saveToken: changed.saveToken, author: alice });
  const exported = await store.exportVersion({ ...input, versionId: 'V1' });
  assert.deepEqual(exported.annotations.map(a => a.target.quote), ['new']);
});
test('listDrafts is session scoped and returns safe summaries', async t => {
  const { store, draft } = await fixture(t, 'secret');
  await store.createDraft({ sessionId: 'another', title: 'Other', markdown: 'private' });
  assert.deepEqual((await store.listDrafts({ sessionId: 's' })).map(d => d.reportId), [draft.reportId]);
  assert.deepEqual(await store.listDrafts({ sessionId: 'unknown' }), []);
  assert.ok(!(await store.listDrafts({ sessionId: 's' }))[0].markdown);
});
