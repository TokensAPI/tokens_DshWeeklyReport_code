import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportStore } from '../../report-core/src/index.mjs';
import { createReviewHost } from '../src/index.mjs';
import { computeTimeline } from '../src/timeline.mjs';
import { mapChunks } from '../src/chunk-map.mjs';
import { resolveFolderPath, moveArtifacts } from '../src/folder-move.mjs';

test('V1.1 timeline retains baseline and shows adjacent human edits', () => {
  const result = computeTimeline([
    { versionId: 'V1', markdown: '价格上涨', baseVersionId: null },
    { versionId: 'V2', markdown: '价格下跌', baseVersionId: 'V1', annotations: [{ public: true, source: 'user_direct' }] },
  ], { V1: true });
  assert.equal(result.baselineVersionId, 'V1');
  assert.equal(result.versions[0].isBaseline, true);
  assert.equal(result.versions[0].published, true);
  assert.equal(result.versions[1].humanEdited, true);
  assert.equal(result.versions[1].diffFromPrevious.add, 1);
  assert.equal(result.versions[1].diffFromPrevious.del, 1);
});

test('V1.1 chunk mapping preserves unchanged text and optimistic revision', () => {
  const mapped = mapChunks('价格上涨\n库存减少', '价格下跌\n库存减少', [
    { id: 'price', content: '价格上涨', content_revision: 3 },
    { id: 'stock', content: '库存减少', content_revision: 0 },
    { id: 'missing', content: '不存在' },
  ]);
  assert.equal(mapped[0].content, '价格下跌');
  assert.equal(mapped[0].expectedRevision, 3);
  assert.equal(mapped[1].changed, false);
  assert.equal(mapped[2].error, 'unmapped');
});

test('V1.1 folder routing isolates reports and rejects invalid groups', async () => {
  assert.equal(resolveFolderPath({ variety: '锡', title: '已改标题', reportKey: 'r_one' }).folderPath, '商品策略/有色/锡铝氧化铝锌/周报/r_one');
  assert.equal(resolveFolderPath({ variety: '新商品', reportKey: 'r_two' }).folderPath, '商品策略/未分类/周报/r_two');
  assert.equal(resolveFolderPath({ variety: '锡', groupMap: { 锡: '../escape' } }).invalidGroup, true);
  const receipt = await moveArtifacts({ connector: { moveToFolder: async () => ({ ok: true, data: { moved_count: 1 } }) }, kbId: 'kb', ids: ['a', 'b'], folderPath: '商品策略' });
  assert.equal(receipt.expected, 2);
  assert.equal(receipt.movedCount, 1);
  assert.ok(receipt.warnings.some(x => x.includes('数量不一致')));
});

test('V1.1 variety persists and timeline supports an archived session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'weekly-v11-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = new ReportStore({ rootDir: root });
  const draft = await core.createDraft({ sessionId: 'archived', title: '修改后的标题', variety: '锡', markdown: '正文' });
  await core.confirm({ sessionId: 'archived', reportId: draft.reportId, saveToken: draft.saveToken, author: { authorId: 'u1', displayName: 'Reviewer' } });
  assert.equal((await core.exportVersion({ sessionId: 'archived', reportId: draft.reportId, versionId: 'V1' })).variety, '锡');
  const api = createReviewHost({ core, pdf: {}, sessions: { get: () => undefined } });
  t.after(() => api.dispose());
  const result = await api.dispatchHuman({ action: 'timeline', sessionId: 'archived', reportId: draft.reportId });
  assert.equal(result.markdowns.V1, '正文');
  await assert.rejects(api.dispatchHuman({ action: 'timeline', sessionId: 'other', reportId: draft.reportId }), { code: 'NOT_FOUND' });
});

test('V1.1 retrieval corrections are isolated by session and cleared on restart', async () => {
  const api = createReviewHost({ core: {}, pdf: {}, sessions: {} });
  const send = (sessionId, action, args = {}) => api.dispatchHuman({ sessionId, action, variety: '锡', ...args });
  await send('s1', 'retrievalRecordCorrection', { correction: '使用专题目录' });
  assert.equal((await send('s1', 'retrievalMemory')).entries.length, 1);
  assert.equal((await send('s2', 'retrievalMemory')).entries.length, 0);
  const view = await send('s1', 'retrievalMemory');
  view.entries[0].correction = 'mutated';
  assert.equal((await send('s1', 'retrievalMemory')).entries[0].correction, '使用专题目录');
  api.dispose();
});

test('V1.1 a new version reuses published knowledge and updates chunks with a revision guard', async t => {
  const root = await mkdtemp(join(tmpdir(), 'weekly-v11-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdfPath = join(root, 'report.pdf');
  await writeFile(pdfPath, '%PDF-1.7 fixture');
  const core = new ReportStore({ rootDir: join(root, 'data') });
  const calls = [];
  let seed = '';
  const connector = {
    identity: async () => ({ verified: true, credentialPurpose: 'publish', principal: { userId: 'reviewer', username: 'Reviewer' } }),
    chunks: async () => ({ ok: true, data: { data: [{ id: 'chunk1', content: seed, content_revision: 2 }] } }),
    createReviewHost: () => ({
      approve: request => request,
      execute: async request => {
        calls.push(request);
        if (request.operation === 'publishReport') seed = request.content;
        return { ok: true, data: { id: request.operation === 'publishPdf' ? 'pdf1' : 'doc1', knowledge_base_id: 'kb' } };
      },
    }),
  };
  const api = createReviewHost({ core, pdf: { render: async () => ({ status: 'ready', pdfPath }) }, sessions: {}, getConnector: () => connector }, { publishKbId: 'kb' });
  t.after(() => api.dispose());
  const send = (action, args) => api.dispatchHuman({ sessionId: 's1', action, ...args });
  const d = await send('create', { title: '锡周报', markdown: '# 锡\n价格上涨' });
  const v1 = await send('confirm', { reportId: d.reportId, saveToken: d.saveToken });
  const p1 = await send('publishPlan', { reportId: d.reportId, versionId: v1.versionId });
  assert.equal((await send('publish', { reportId: d.reportId, ...p1, userInitiated: true })).status, 'submitted');
  const revision = await send('startRevision', { reportId: d.reportId });
  const saved = await send('save', { reportId: d.reportId, saveToken: revision.saveToken, markdown: '# 锡\n价格下跌' });
  const v2 = await send('confirm', { reportId: d.reportId, saveToken: saved.saveToken });
  const p2 = await send('publishPlan', { reportId: d.reportId, versionId: v2.versionId });
  const receipt = await send('publish', { reportId: d.reportId, ...p2, userInitiated: true });
  assert.equal(receipt.status, 'submitted');
  assert.equal(calls.filter(c => c.operation === 'publishReport').length, 1);
  const patch = calls.find(c => c.operation === 'updateChunk');
  assert.equal(patch.knowledgeId, 'doc1');
  assert.equal(patch.expectedRevision, 2);
  assert.match(patch.content, /价格下跌/);
});
