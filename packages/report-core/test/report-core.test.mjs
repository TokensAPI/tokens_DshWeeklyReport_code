import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import plugin, { ReportStore } from '../src/index.mjs';
const author = { authorId: 'alice', displayName: 'Alice' };
async function setup(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run19-core-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = new ReportStore({ rootDir });
  const draft = await store.createDraft({ sessionId: 's1', title: 'Report', markdown: 'initial secret', markers: [{ fromVersion: 'V0', kind: 'inference', text: 'private-marker' }] });
  const input = { sessionId: 's1', reportId: draft.reportId };
  return { store, draft, input, rootDir };
}
test('parallel saves across instances yield exactly one conflict and atomic audit', async t => {
  const { store, draft, input, rootDir } = await setup(t);
  const other = new ReportStore({ rootDir });
  const results = await Promise.allSettled([store, other].map((s, i) => s.saveDraft({ ...input, saveToken: draft.saveToken, markdown: `edit-${i}`, source: 'user_direct' })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'CONFLICT');
  const audit = await other.getAudit(input);
  assert.equal(audit.length, 2); assert.equal(audit[1].before, 'initial secret');
  assert.equal(audit[1].after, (await store.getDraft(input)).markdown);
});
test('restart recovery and public export exclude prompts, deletions and private markers', async t => {
  const { store, draft, input, rootDir } = await setup(t);
  const saved = await store.saveDraft({ ...input, saveToken: draft.saveToken, markdown: '# public', source: 'user_prompt', instruction: 'private prompt', author });
  const v = await store.confirm({ ...input, saveToken: saved.saveToken, author });
  const restarted = new ReportStore({ rootDir });
  assert.deepEqual(await restarted.getVersion({ ...input, versionId: 'V1' }), v);
  const audit = await restarted.getAudit(input);
  assert.equal(audit[1].instruction, 'private prompt'); assert.equal(audit[1].source, 'user_prompt');
  assert.equal(v.author.authorId, 'alice'); assert.ok(v.completedAt); assert.equal(v.markers[0].fromVersion, 'V0');
  const exported = await restarted.exportVersion({ ...input, versionId: 'V1' });
  for (const secret of ['private prompt', 'initial secret', 'private-marker', 'saveToken', 'confirmedFromToken']) assert.ok(!JSON.stringify(exported).includes(secret));
});
test('same-content confirm is retry-idempotent; revisions generate V2 only on change', async t => {
  const { store, draft, input } = await setup(t);
  const [first, repeated] = await Promise.all([1, 2].map(() => store.confirm({ ...input, saveToken: draft.saveToken, author })));
  assert.deepEqual(first, repeated);
  let revision = await store.startRevision({ ...input, versionId: 'V1' });
  await assert.rejects(store.startRevision({ ...input, versionId: 'V1' }), { code: 'DRAFT_EXISTS' });
  const unchanged = await store.confirm({ ...input, saveToken: revision.saveToken, author: { authorId: 'bob', displayName: 'Bob' } });
  assert.deepEqual(unchanged, first);
  assert.deepEqual(await store.confirm({ ...input, saveToken: revision.saveToken, author }), first);
  revision = await store.startRevision({ ...input, versionId: 'V1' });
  revision = await store.saveDraft({ ...input, saveToken: revision.saveToken, markdown: 'second', source: 'agent_inference' });
  const second = await store.confirm({ ...input, saveToken: revision.saveToken, author });
  assert.equal(second.versionId, 'V2'); assert.equal(second.baseVersionId, 'V1');
  assert.equal((await store.getVersion({ ...input, versionId: 'V1' })).markdown, 'initial secret');
  assert.equal((await store.listVersions(input)).length, 2);
  await assert.rejects(store.confirm({ ...input, saveToken: draft.saveToken, author }), { code: 'CONFLICT' });
});
test('session isolation covers every read/write surface', async t => {
  const { store, draft, input } = await setup(t);
  const v = await store.confirm({ ...input, saveToken: draft.saveToken, author });
  const plan = await store.savePublicationPlan({ ...input, versionId: v.versionId, target: 'local' });
  const foreign = { ...input, sessionId: 'other', saveToken: draft.saveToken, versionId: 'V1', author, markdown: 'attack', source: 'user_direct', planId: plan.planId, target: 'local', status: 'succeeded', assets: [] };
  for (const method of ['getDraft', 'saveDraft', 'confirm', 'startRevision', 'getVersion', 'listVersions', 'getAudit', 'exportVersion', 'snapshotAssets', 'savePublicationPlan', 'recordPublication', 'listPublicationPlans', 'listPublicationRecords']) {
    await assert.rejects(store[method](foreign), { code: 'NOT_FOUND' }, method);
  }
});
test('explicit assets are immutable hashed snapshots with path mapping', async t => {
  const { store, draft, input, rootDir } = await setup(t);
  const file = path.join(rootDir, 'image.png'); await fs.writeFile(file, 'original');
  const withAsset = await store.snapshotAssets({ ...input, saveToken: draft.saveToken, assets: [{ path: file, markdownPath: './image.png' }] });
  const mapping = withAsset.assets[0]; assert.equal(mapping.markdownPath, './image.png'); assert.equal(mapping.hash.length, 64);
  const v1 = await store.confirm({ ...input, saveToken: withAsset.saveToken, author });
  await fs.writeFile(file, 'changed');
  const revision = await store.startRevision({ ...input, versionId: 'V1' });
  const updated = await store.snapshotAssets({ ...input, saveToken: revision.saveToken, assets: [{ path: file, markdownPath: './image.png' }] });
  assert.notEqual(updated.assets[0].hash, mapping.hash);
  assert.equal(await fs.readFile(path.join(rootDir, v1.assets[0].snapshotPath), 'utf8'), 'original');
  await assert.rejects(store.snapshotAssets({ ...input, saveToken: updated.saveToken, assets: [{ path: rootDir }] }), { code: 'INVALID_INPUT' });
  if (process.platform !== 'win32') {
    const link = path.join(rootDir, 'link'); await fs.symlink(file, link);
    await assert.rejects(store.snapshotAssets({ ...input, saveToken: updated.saveToken, assets: [{ path: link }] }), { code: 'INVALID_INPUT' });
  }
});
test('asset references normalize and public annotations use a strict field projection', async t => {
  const { store, rootDir } = await setup(t);
  const file = path.join(rootDir, 'plot.png'); await fs.writeFile(file, 'plot');
  let draft = await store.createDraft({ sessionId: 's1', title: 'Mapped', markdown: '![plot](./plot.png)', assets: [{ path: file, markdownPath: './plot.png' }], annotations: [{ id: 'a1', target: { startLine: 1, endLine: 1, quote: 'private deleted text' }, source: 'user_prompt', public: true, instruction: 'private instruction', displayName: 'Alice' }, { id: 'a2', target: { startLine: 1, endLine: 1 }, source: 'agent_inference', public: true }] });
  assert.equal(draft.markdown, `![plot](asset:${draft.assets[0].id})`);
  assert.equal(draft.assets[0].sha256, draft.assets[0].hash);
  const input = { sessionId: 's1', reportId: draft.reportId };
  await store.confirm({ ...input, saveToken: draft.saveToken, author });
  const exported = await store.exportVersion({ ...input, versionId: 'V1' });
  assert.equal(exported.annotations.length, 0); // stale quotes / nontext blocks are not exported
  assert.ok(!JSON.stringify(exported).includes('private'));
  draft = await store.startRevision({ ...input, versionId: 'V1' });
  draft = await store.saveDraft({ ...input, saveToken: draft.saveToken, markdown: 'new line\n' + draft.markdown, source: 'user_direct' });
  assert.equal(draft.annotations[0].mappingConfidence, 'high');
  assert.equal(draft.annotations[0].target.quote, 'new line');
});
test('publication metadata persists independently and plugin provides store', async t => {
  const { store, draft, input, rootDir } = await setup(t);
  await store.confirm({ ...input, saveToken: draft.saveToken, author });
  const plan = await store.savePublicationPlan({ ...input, versionId: 'V1', target: 'html', payload: { directory: '/exports' } });
  const record = await store.recordPublication({ ...input, planId: plan.planId, status: 'succeeded', details: { url: 'file:///exports/report.html' } });
  const restarted = new ReportStore({ rootDir });
  assert.deepEqual(await restarted.listPublicationPlans(input), [plan]);
  assert.deepEqual(await restarted.listPublicationRecords(input), [record]);
  let service; plugin.apply({ provide(name, value) { assert.equal(name, 'reportCore'); service = value; } }, { rootDir });
  assert.ok(service instanceof ReportStore);
});
