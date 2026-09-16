import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ReportStore } from '../../report-core/src/index.mjs';
import { createReviewHost, apply } from '../src/index.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex');
const handle = 'aB_09-z'.padEnd(22, 'x');

function makeHost(root, connector, config = {}) {
  const core = new ReportStore({ rootDir: join(root, 'core') });
  const sessions = { get: id => ['s1', 's2'].includes(id) ? { id } : undefined };
  const pdf = { async render(d) { return { status: 'ready', saveToken: d.saveToken, digest: hash(d.markdown), pdfPath: join(root, 'p.pdf'), warnings: [] }; } };
  const api = createReviewHost({ core, pdf, sessions, getConnector: () => connector }, { allowedSessionIds: ['s1'], publishKbId: 'kb1', ...config });
  return { core, api };
}

test('image then report publish binds verified resource and records per-item intents and outcomes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'run19-coord-')); t.after(() => rm(root, { recursive: true, force: true }));
  const approvals = [];
  const { core, api } = makeHost(root, {
    identity: async () => ({ verified: true, credentialPurpose: 'publish', principal: { userId: 'u1', username: '测试用户' } }),
    createReviewHost() {
      let n = 0;
      return { approve(value) { approvals.push(value); return Object.freeze({ value, seq: n++ }); }, async execute(cap) {
        if (cap.value.operation === 'publishImage') return { ok: true, data: { id: 'image1', knowledge_base_id: 'kb1', file_path: `resource://${handle}`, parse_status: 'pending' }, submitted: true };
        return { ok: true, data: { id: 'report1', knowledge_base_id: 'kb1', parse_status: 'pending' }, submitted: true };
      } };
    }
  });
  t.after(() => api.dispose());
  const assetPath = join(root, 'chart.png'); await writeFile(assetPath, png);
  const aid = hash(png);
  let d = await core.createDraft({ sessionId: 's1', title: '锡周报', markdown: `# 锡周报\n\n![库存图](asset:${aid})`, assets: [{ path: assetPath }] });
  const v = await core.confirm({ sessionId: 's1', reportId: d.reportId, saveToken: d.saveToken, author: { authorId: 'u1', displayName: '测试用户' } });

  const plan = await api.dispatchHuman({ action: 'publishPlan', sessionId: 's1', reportId: d.reportId, versionId: v.versionId });
  assert.deepEqual(plan.items.map(i => [i.itemKey, i.type]), [['image:' + aid, 'image'], [`report:${d.reportId}:V1`, 'report'], [`pdf:${d.reportId}:V1`, 'pdf']]);
  assert.equal(plan.target, 'kb1');
  const receipt = await api.dispatchHuman({ action: 'publish', sessionId: 's1', reportId: d.reportId, ...plan, userInitiated: true });
  assert.equal(receipt.status, 'submitted'); assert.equal(receipt.published, false);
  const imageItem = receipt.items.find(i => i.type === 'image'), reportItem = receipt.items.find(i => i.type === 'report');
  assert.equal(imageItem.phase, 'submitted'); assert.equal(imageItem.resourceUri, `resource://${handle}`);
  assert.equal(reportItem.phase, 'submitted');
  // The report byte payload must carry the bound resource handle, not a bare asset reference.
  const imageApprove = approvals.find(a => a.operation === 'publishImage');
  assert.equal(imageApprove.sha256, aid); assert.equal(imageApprove.path, v.assets[0].path);
  const reportApprove = approvals.find(a => a.operation === 'publishReport');
  assert.ok(reportApprove.content.includes(`resource://${handle}`)); assert.ok(!reportApprove.content.includes(`asset:${aid}`));
  const itemRecords = await core.listPublicationItemRecords({ sessionId: 's1', reportId: d.reportId, planId: plan.planId });
  assert.equal(itemRecords.length, 3);
  const imageRecord = itemRecords.find(r => r.itemKey === 'image:' + aid);
  assert.equal(imageRecord.details.phase, 'submitted'); assert.equal(imageRecord.details.resourceUri, `resource://${handle}`);
  const reportRecord = itemRecords.find(r => r.details.type === 'report');
  assert.equal(reportRecord.details.remote.id, 'report1');
});

test('selected public human item is a separate manual publish and listed at plan time', async t => {
  const root = await mkdtemp(join(tmpdir(), 'run19-coordh-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { core, api } = makeHost(root, {
    identity: async () => ({ verified: true, credentialPurpose: 'publish', principal: { userId: 'u1', username: '测试用户' } }),
    createReviewHost() {
      const operations = [];
      return { approve(value) { return Object.freeze({ value }); }, async execute(cap) { operations.push(cap.value.operation); return { ok: true, data: { id: `id-${operations.length}`, knowledge_base_id: 'kb1' }, submitted: true }; }, operations };
    }
  });
  t.after(() => api.dispose());
  let d = await core.createDraft({ sessionId: 's1', title: 'T', markdown: '# 基线\n\n库存上升' });
  d = await core.saveDraft({ sessionId: 's1', reportId: d.reportId, saveToken: d.saveToken, markdown: '# 基线\n\n库存上升，人工纠正：应增加至 100', source: 'user_direct' });
  const view = await core.getHumanItems({ sessionId: 's1', reportId: d.reportId });
  const ann = view.items[0];
  assert.ok(ann); assert.equal(ann.category, 'supplement');
  d = await core.saveHumanItems({ sessionId: 's1', reportId: d.reportId, saveToken: d.saveToken, items: [{ annotationId: ann.annotationId, category: 'correction', selected: true, visibility: 'public', publicSource: '现场记录' }] });
  const v = await core.confirm({ sessionId: 's1', reportId: d.reportId, saveToken: d.saveToken, author: { authorId: 'u1', displayName: '测试用户' } });
  assert.equal(v.humanItems.length, 1);
  const plan = await api.dispatchHuman({ action: 'publishPlan', sessionId: 's1', reportId: d.reportId, versionId: v.versionId });
  assert.ok(plan.items.some(i => i.type === 'human'));
  const receipt = await api.dispatchHuman({ action: 'publish', sessionId: 's1', reportId: d.reportId, ...plan, userInitiated: true });
  assert.equal(receipt.status, 'submitted');
  const humanItem = receipt.items.find(i => i.type === 'human');
  assert.equal(humanItem.phase, 'submitted');
  const itemRecords = await core.listPublicationItemRecords({ sessionId: 's1', reportId: d.reportId, planId: plan.planId });
  assert.ok(itemRecords.some(r => r.details.type === 'human'));
});

test('reconcile surfaces per-item parse status from stored verified remote ids', async t => {
  const root = await mkdtemp(join(tmpdir(), 'run19-coordr-')); t.after(() => rm(root, { recursive: true, force: true }));
  const assetPath = join(root, 'chart.png'); await writeFile(assetPath, png);
  const { core, api } = makeHost(root, {
    identity: async () => ({ verified: true, credentialPurpose: 'publish', principal: { userId: 'u1', username: '测试用户' } }),
    status: async (kb, id) => ({ ok: true, data: { id, knowledge_base_id: kb, parse_status: 'completed' } }),
    createReviewHost() { return { approve(v) { return Object.freeze({ v }); }, async execute(cap) { if (cap.v.operation === 'publishImage') return { ok: true, data: { id: 'image1', knowledge_base_id: 'kb1', file_path: `resource://${handle}` } }; return { ok: true, data: { id: 'report1', knowledge_base_id: 'kb1' } }; } }; }
  });
  t.after(() => api.dispose());
  const aid = hash(png);
  let d = await core.createDraft({ sessionId: 's1', title: '锡', markdown: `# 锡\n\n![图](asset:${aid})`, assets: [{ path: assetPath }] });
  const v = await core.confirm({ sessionId: 's1', reportId: d.reportId, saveToken: d.saveToken, author: { authorId: 'u1', displayName: '测试用户' } });
  const plan = await api.dispatchHuman({ action: 'publishPlan', sessionId: 's1', reportId: d.reportId, versionId: v.versionId });
  await api.dispatchHuman({ action: 'publish', sessionId: 's1', reportId: d.reportId, ...plan, userInitiated: true });
  const value = await api.dispatchHuman({ action: 'publicationStatus', sessionId: 's1', reportId: d.reportId });
  assert.equal(value.records.length, 1);
  // Read-only: no unknown/unverified resource dropped; per-item completed reflects stored status.
  const imageRow = value.records[0].items.find(i => i.type === 'image');
  assert.equal(imageRow.phase, 'submitted');
});

test('commodityGroups config maps a commodity and moves md/pdf into that weknora folder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'run19-coordg-')); t.after(() => rm(root, { recursive: true, force: true }));
  const moves = [];
  const connector = {
    identity: async () => ({ verified: true, credentialPurpose: 'publish', principal: { userId: 'u1', username: '测试用户' } }),
    async moveToFolder(kb, ids, folderPath) { moves.push({ kb, ids, folderPath }); return { ok: true }; },
    createReviewHost() { return { approve(v) { return Object.freeze({ v }); }, async execute(cap) { if (cap.v.operation === 'publishImage') return { ok: true, data: { id: 'image1', knowledge_base_id: 'kb1', file_path: `resource://${handle}` } }; return { ok: true, data: { id: 'report1', knowledge_base_id: 'kb1' } }; } }; }
  };
  const { core, api } = makeHost(root, connector, { commodityGroups: { 锡: '有色/锡铝氧化铝锌', 锑: '有色/锑' } });
  t.after(() => api.dispose());
  const assetPath = join(root, 'chart.png'); await writeFile(assetPath, png);
  const aid = hash(png);
  // Title "锡周报" (no ASCII separator) must still derive variety 锡 → 有色/锡铝氧化铝锌.
  let d = await core.createDraft({ sessionId: 's1', title: '锡周报', markdown: `# 锡周报\n\n![库存](asset:${aid})`, assets: [{ path: assetPath }] });
  const v = await core.confirm({ sessionId: 's1', reportId: d.reportId, saveToken: d.saveToken, author: { authorId: 'u1', displayName: '测试用户' } });
  const plan = await api.dispatchHuman({ action: 'publishPlan', sessionId: 's1', reportId: d.reportId, versionId: v.versionId });
  const receipt = await api.dispatchHuman({ action: 'publish', sessionId: 's1', reportId: d.reportId, ...plan, userInitiated: true });
  assert.equal(receipt.status, 'submitted');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].folderPath, '商品策略/有色/锡铝氧化铝锌/周报');
  assert.equal(moves[0].kb, 'kb1');
  assert.ok(moves[0].ids.length >= 2); // md + pdf (+ image)
  assert.ok(receipt.warnings.some(w => w.includes('商品策略/有色/锡铝氧化铝锌/周报')));
});

test('unknown commodity skip folder placement and surface a visible warning', async t => {
  const root = await mkdtemp(join(tmpdir(), 'run19-coordu-')); t.after(() => rm(root, { recursive: true, force: true }));
  const moves = [];
  const connector = {
    identity: async () => ({ verified: true, credentialPurpose: 'publish', principal: { userId: 'u1', username: '测试用户' } }),
    async moveToFolder(kb, ids, folderPath) { moves.push({ folderPath }); return { ok: true }; },
    createReviewHost() { return { approve(v) { return Object.freeze({ v }); }, async execute(cap) { return { ok: true, data: { id: 'report1', knowledge_base_id: 'kb1' } }; } }; }
  };
  const { core, api } = makeHost(root, connector); // no config override → default map lacks 镍
  t.after(() => api.dispose());
  let d = await core.createDraft({ sessionId: 's1', title: '镍周报', markdown: '# 镍周报\n\n镍价' });
  const v = await core.confirm({ sessionId: 's1', reportId: d.reportId, saveToken: d.saveToken, author: { authorId: 'u1', displayName: '测试用户' } });
  const plan = await api.dispatchHuman({ action: 'publishPlan', sessionId: 's1', reportId: d.reportId, versionId: v.versionId });
  const receipt = await api.dispatchHuman({ action: 'publish', sessionId: 's1', reportId: d.reportId, ...plan, userInitiated: true });
  assert.equal(receipt.status, 'submitted');
  assert.equal(moves.length, 0); // skipped placement
  assert.ok(receipt.warnings.some(w => w.includes('镍') && w.includes('commodityGroups')));
});

test('moveToFolder failure is surfaced as a warning, not silently swallowed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'run19-coordm-')); t.after(() => rm(root, { recursive: true, force: true }));
  const connector = {
    identity: async () => ({ verified: true, credentialPurpose: 'publish', principal: { userId: 'u1', username: '测试用户' } }),
    async moveToFolder() { return { ok: false, error: 'remote_folder_error' }; },
    createReviewHost() { return { approve(v) { return Object.freeze({ v }); }, async execute(cap) { return { ok: true, data: { id: 'report1', knowledge_base_id: 'kb1' } }; } }; }
  };
  const { core, api } = makeHost(root, connector);
  t.after(() => api.dispose());
  let d = await core.createDraft({ sessionId: 's1', title: '锡周报', markdown: '# 锡周报\n\n锡价' });
  const v = await core.confirm({ sessionId: 's1', reportId: d.reportId, saveToken: d.saveToken, author: { authorId: 'u1', displayName: '测试用户' } });
  const plan = await api.dispatchHuman({ action: 'publishPlan', sessionId: 's1', reportId: d.reportId, versionId: v.versionId });
  const receipt = await api.dispatchHuman({ action: 'publish', sessionId: 's1', reportId: d.reportId, ...plan, userInitiated: true });
  assert.equal(receipt.status, 'submitted');
  assert.ok(receipt.warnings.some(w => w.includes('放入文件夹失败') && w.includes('remote_folder_error')));
});
