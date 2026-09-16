import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { annotateChanges, publicAnnotations } from './annotations.mjs';
import { pruneHumanItems, validateHumanItems, humanItemsView, exportHumanItems } from './human-items.mjs';
export { markdownBlocks } from './annotations.mjs';

const queues = new Map();
const sources = new Set(['user_direct', 'user_prompt', 'agent_inference']);
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
export class ReportError extends Error {
  constructor(code, message) { super(message); this.name = 'ReportError'; this.code = code; }
}
const fail = (code, message) => { throw new ReportError(code, message); };
const text = (value, name) => { if (typeof value !== 'string') fail('INVALID_INPUT', `${name} must be a string`); return value; };
const identity = value => {
  if (!value || typeof value.authorId !== 'string' || !value.authorId || typeof value.displayName !== 'string') fail('INVALID_INPUT', 'author requires authorId and displayName');
  return { authorId: value.authorId, displayName: value.displayName };
};
const contentKey = draft => hash(JSON.stringify([draft.markdown, draft.assets.map(a => [a.markdownPath, a.hash])]));
const normalizeMarkdown = (markdown, assets, previous = []) => {
  for (const asset of assets) {
    const old = previous.find(a => a.markdownPath === asset.markdownPath);
    for (const ref of [asset.markdownPath, ...(old ? [`asset:${old.id}`] : [])]) {
      markdown = markdown.split(`](${ref})`).join(`](asset:${asset.id})`);
      markdown = markdown.split(`](<${ref}>)`).join(`](asset:${asset.id})`);
    }
  }
  return markdown;
};

/** One root belongs to one Node process; instances within that process share queues. */
export class ReportStore {
  constructor({ rootDir } = {}) {
    if (typeof rootDir !== 'string' || !rootDir) fail('INVALID_INPUT', 'rootDir is required');
    this.rootDir = path.resolve(rootDir);
  }
  _file(reportId) {
    if (typeof reportId !== 'string' || !/^r_[a-f0-9-]{36}$/.test(reportId)) fail('NOT_FOUND', 'Report not found');
    return path.join(this.rootDir, 'reports', `${reportId}.json`);
  }
  async _serial(reportId, work) {
    const key = this._file(reportId);
    const previous = queues.get(key) || Promise.resolve();
    const job = previous.catch(() => {}).then(work);
    queues.set(key, job);
    try { return await job; } finally { if (queues.get(key) === job) queues.delete(key); }
  }
  async _load(sessionId, reportId) {
    if (typeof sessionId !== 'string' || !sessionId) fail('INVALID_INPUT', 'sessionId is required');
    let record;
    try { record = JSON.parse(await fs.readFile(this._file(reportId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') fail('NOT_FOUND', 'Report not found'); throw error; }
    if (record.sessionId !== sessionId) fail('NOT_FOUND', 'Report not found');
    return record;
  }
  async _write(record) {
    const file = this._file(record.reportId);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record));
      await handle.sync(); await handle.close(); handle = undefined;
      await fs.rename(temporary, file);
      const dir = await fs.open(path.dirname(file), 'r');
      try {
        try { await dir.sync(); }
        catch (error) {
          // Windows does not expose directory fsync through Node. The file was
          // already fsynced before the atomic rename; only ignore this known
          // platform limitation and keep every other failure loud.
          if (process.platform !== 'win32' || !['EPERM', 'EINVAL', 'EBADF'].includes(error.code)) throw error;
        }
      } finally { await dir.close(); }
    } finally { if (handle) await handle.close(); await fs.rm(temporary, { force: true }); }
  }
  _token(record, token) {
    if (token !== record.draft.saveToken) fail('CONFLICT', 'Stale saveToken; reload the draft');
  }
  _editable(record) { if (record.draft.status !== 'draft') fail('REVISION_REQUIRED', 'Call startRevision before editing a confirmed report'); }
  _draft(record) { return clone({ reportId: record.reportId, sessionId: record.sessionId, title: record.title, ...record.draft }); }
  _audit(record, entry) { record.audit.push({ auditId: randomUUID(), at: now(), ...entry }); }
  async _assets(reportId, assets = []) {
    if (!Array.isArray(assets)) fail('INVALID_INPUT', 'assets must be an array of explicit file descriptors');
    const result = [];
    const used = new Set();
    for (const item of assets) {
      if (!item || typeof item.path !== 'string' || !path.isAbsolute(item.path)) fail('INVALID_INPUT', 'asset.path must be an explicit absolute file path');
      const markdownPath = text(item.markdownPath ?? item.path, 'markdownPath');
      if (used.has(markdownPath)) fail('INVALID_INPUT', 'Duplicate markdownPath');
      used.add(markdownPath);
      const stat = await fs.lstat(item.path);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_INPUT', 'Only regular files are accepted; no directories or symlinks');
      // Open the same inode checked above; reject a path switched during validation.
      const handle = await fs.open(item.path, 'r');
      let bytes;
      try { const opened = await handle.stat(); if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) fail('INVALID_INPUT', 'Asset changed during snapshot'); bytes = await handle.readFile(); }
      finally { await handle.close(); }
      const digest = hash(bytes);
      const snapshotPath = `assets/${reportId}/${digest}`;
      const target = path.join(this.rootDir, snapshotPath);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      // Temp + hard link publishes complete bytes without replacing an existing hash.
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        const out = await fs.open(temp, 'wx', 0o600);
        try { await out.writeFile(bytes); await out.sync(); } finally { await out.close(); }
        try { await fs.link(temp, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (hash(await fs.readFile(target)) !== digest) fail('ASSET_CORRUPT', 'Existing immutable asset does not match hash');
      } finally { await fs.rm(temp, { force: true }); }
      result.push({ id: digest, path: target, sha256: digest, name: path.basename(item.path), markdownPath, snapshotPath, hash: digest, size: bytes.length });
    }
    return result;
  }
  async createDraft({ sessionId, title, markdown, assets = [], markers = [], annotations, source = 'agent_inference' }) {
    if (typeof sessionId !== 'string' || !sessionId) fail('INVALID_INPUT', 'sessionId is required');
    text(title, 'title'); text(markdown, 'markdown');
    if (!sources.has(source)) fail('INVALID_INPUT', 'Invalid source');
    const reportId = `r_${randomUUID()}`;
    return this._serial(reportId, async () => {
      const at = now();
      const record = { schemaVersion: 1, reportId, sessionId, title, createdAt: at,
        draft: { markdown, assets: await this._assets(reportId, assets), markers: clone(markers), humanItems: [], saveToken: randomUUID(), status: 'draft', baseVersionId: null, updatedAt: at },
        versions: [], audit: [], publicationPlans: [], publicationRecords: [] };
      record.draft.markdown = normalizeMarkdown(markdown, record.draft.assets);
      const attributed = annotateChanges('', record.draft.markdown, [], source);
      record.draft.annotations = annotations === undefined ? attributed.annotations : clone(annotations);
      record.draft.warnings = attributed.warnings;
      this._audit(record, { action: 'create', source, before: null, after: record.draft.markdown });
      await this._write(record); return this._draft(record);
    });
  }
  async listDrafts({ sessionId }) {
    if (typeof sessionId !== 'string' || !sessionId) fail('INVALID_INPUT', 'sessionId is required');
    let files;
    try { files = await fs.readdir(path.join(this.rootDir, 'reports')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const file of files.filter(name => /^r_[a-f0-9-]{36}\.json$/.test(name))) {
      try {
        const record = await this._load(sessionId, file.slice(0, -5));
        result.push({ reportId: record.reportId, title: record.title, status: record.draft.status, updatedAt: record.draft.updatedAt, baseVersionId: record.draft.baseVersionId });
      } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getDraft({ sessionId, reportId }) { return this._draft(await this._load(sessionId, reportId)); }
  async getHumanItems({ sessionId, reportId }) { return humanItemsView(await this._load(sessionId, reportId)); }
  async saveHumanItems({ sessionId, reportId, saveToken, items }) {
    return this._serial(reportId, async () => {
      const record = await this._load(sessionId, reportId); this._token(record, saveToken); this._editable(record);
      const next = validateHumanItems(record.draft, items, fail);
      this._audit(record, { action: 'human_items_review', beforeItems: clone(record.draft.humanItems || []), afterItems: clone(next) });
      record.draft.humanItems = next; record.draft.saveToken = randomUUID(); record.draft.updatedAt = now();
      await this._write(record); return humanItemsView(record);
    });
  }
  async saveDraft({ sessionId, reportId, saveToken, markdown, source, instruction, author, markers, annotations }) {
    text(markdown, 'markdown');
    if (!sources.has(source)) fail('INVALID_INPUT', 'source must be user_direct, user_prompt or agent_inference');
    if (instruction !== undefined) text(instruction, 'instruction');
    return this._serial(reportId, async () => {
      const record = await this._load(sessionId, reportId); this._token(record, saveToken); this._editable(record);
      const before = record.draft.markdown;
      markdown = normalizeMarkdown(markdown, record.draft.assets);
      const attributed = annotateChanges(before, markdown, record.draft.annotations || [], source);
      record.draft.annotations = annotations === undefined ? attributed.annotations : clone(annotations);
      record.draft.warnings = attributed.warnings;
      this._audit(record, { action: 'save', source, before, after: markdown, ...(instruction === undefined ? {} : { instruction }), ...(author ? { author: identity(author) } : {}), beforeMarkers: clone(record.draft.markers), afterMarkers: clone(markers ?? record.draft.markers) });
      record.draft.markdown = markdown;
      pruneHumanItems(record.draft);
      if (markers !== undefined) record.draft.markers = clone(markers);
      record.draft.saveToken = randomUUID(); record.draft.updatedAt = now();
      await this._write(record); return this._draft(record);
    });
  }
  async snapshotAssets({ sessionId, reportId, saveToken, assets }) {
    return this._serial(reportId, async () => {
      const record = await this._load(sessionId, reportId); this._token(record, saveToken); this._editable(record);
      const before = clone(record.draft.assets);
      // Explicit replacement of the manifest; old immutable files and versions remain intact.
      record.draft.assets = await this._assets(reportId, assets);
      record.draft.markdown = normalizeMarkdown(record.draft.markdown, record.draft.assets, before);
      this._audit(record, { action: 'assets', source: 'user_direct', before, after: clone(record.draft.assets) });
      record.draft.saveToken = randomUUID(); record.draft.updatedAt = now();
      await this._write(record); return this._draft(record);
    });
  }
  async confirm({ sessionId, reportId, saveToken, author }) {
    const approvedBy = identity(author);
    return this._serial(reportId, async () => {
      const record = await this._load(sessionId, reportId);
      const last = record.versions.at(-1);
      const key = contentKey(record.draft);
      if (last && last.contentHash === key && record.draft.status === 'confirmed' && (saveToken === record.draft.confirmedFromToken || saveToken === record.draft.saveToken)) return clone(last);
      this._token(record, saveToken);
      if (last && last.contentHash === key) {
        // Review settings alone do not mutate an immutable content version.
        record.draft.humanItems = clone(last.humanItems || []);
        record.draft.annotations = clone(last.annotations || []);
        record.draft.status = 'confirmed'; record.draft.baseVersionId = last.versionId; record.draft.confirmedFromToken = saveToken;
        record.draft.saveToken = randomUUID(); record.draft.updatedAt = now();
        this._audit(record, { action: 'confirm_unchanged', versionId: last.versionId, author: approvedBy });
        await this._write(record); return clone(last);
      }
      const completedAt = now();
      record.draft.annotations = (record.draft.annotations || []).map(a => a.pending ? { ...a, pending: false, authorId: approvedBy.authorId, displayName: approvedBy.displayName, completedAt } : a);
      pruneHumanItems(record.draft);
      const version = { versionId: `V${record.versions.length + 1}`, reportId, title: record.title,
        humanItems: clone(record.draft.humanItems || []), markdown: record.draft.markdown, assets: clone(record.draft.assets), markers: clone(record.draft.markers), annotations: clone(record.draft.annotations || []),
        contentHash: key, confirmedFromToken: saveToken, baseVersionId: record.draft.baseVersionId,
        author: approvedBy, completedAt };
      record.versions.push(version);
      record.draft.status = 'confirmed'; record.draft.baseVersionId = version.versionId; record.draft.confirmedFromToken = saveToken;
      record.draft.saveToken = randomUUID(); record.draft.updatedAt = now();
      this._audit(record, { action: 'confirm', versionId: version.versionId, author: approvedBy });
      await this._write(record); return clone(version);
    });
  }
  async startRevision({ sessionId, reportId, versionId, saveToken }) {
    return this._serial(reportId, async () => {
      const record = await this._load(sessionId, reportId);
      if (saveToken !== undefined) this._token(record, saveToken);
      if (record.draft.status === 'draft') fail('DRAFT_EXISTS', 'An editable draft already exists; do not overwrite unsaved work');
      const version = record.versions.find(v => v.versionId === versionId);
      if (!version) fail('NOT_FOUND', 'Version not found');
      record.draft = { markdown: version.markdown, assets: clone(version.assets), markers: clone(version.markers), humanItems: clone(version.humanItems || []), annotations: clone(version.annotations || []), status: 'draft', baseVersionId: versionId, saveToken: randomUUID(), updatedAt: now() };
      this._audit(record, { action: 'start_revision', versionId });
      await this._write(record); return this._draft(record);
    });
  }
  async getVersion({ sessionId, reportId, versionId }) {
    const record = await this._load(sessionId, reportId);
    const version = record.versions.find(v => v.versionId === versionId);
    if (!version) fail('NOT_FOUND', 'Version not found'); return clone(version);
  }
  async listVersions({ sessionId, reportId }) {
    return clone((await this._load(sessionId, reportId)).versions.map(({ versionId, contentHash, author, completedAt, baseVersionId }) => ({ versionId, contentHash, author, completedAt, baseVersionId })));
  }
  async getAudit({ sessionId, reportId }) { return clone((await this._load(sessionId, reportId)).audit); }
  /** Public projection: never audit, prompts, old/deleted bodies, tokens or private markers. */
  async exportVersion(input) {
    const v = await this.getVersion(input);
    const annotations = publicAnnotations(v.markdown, v.annotations || []);
    return { reportId: v.reportId, versionId: v.versionId, title: v.title, baseVersionId: v.baseVersionId, humanItems: exportHumanItems(v), markdown: v.markdown, assets: v.assets.map(({ id, path, sha256, snapshotPath, name, size }) => ({ id, path, sha256, snapshotPath, name, size })), annotations, author: v.author, completedAt: v.completedAt };
  }
  async savePublicationPlan({ sessionId, reportId, versionId, target, payload = {} }) {
    text(target, 'target');
    return this._serial(reportId, async () => {
      const record = await this._load(sessionId, reportId);
      if (!record.versions.some(v => v.versionId === versionId)) fail('NOT_FOUND', 'Version not found');
      const plan = { planId: randomUUID(), reportId, versionId, target, payload: clone(payload), createdAt: now() };
      record.publicationPlans.push(plan); await this._write(record); return clone(plan);
    });
  }
  async recordPublication({ sessionId, reportId, planId, status, details = {}, itemKey }) {
    if (!['succeeded', 'failed'].includes(status)) fail('INVALID_INPUT', 'Publication status must be succeeded or failed');
    return this._serial(reportId, async () => {
      const record = await this._load(sessionId, reportId);
      if (!record.publicationPlans.some(p => p.planId === planId)) fail('NOT_FOUND', 'Plan not found');
      const entry = { recordId: randomUUID(), planId, reportId, status, ...(itemKey === undefined ? {} : { itemKey }), details: clone(details), recordedAt: now() };
      record.publicationRecords.push(entry); await this._write(record); return clone(entry);
    });
  }
  async listPublicationPlans({ sessionId, reportId }) { return clone((await this._load(sessionId, reportId)).publicationPlans); }
  async listPublicationRecords({ sessionId, reportId }) { return clone((await this._load(sessionId, reportId)).publicationRecords); }
  /** Persist per-item publication intents on a plan (resume-safe before any remote effect). */
  async savePublicationItems({ sessionId, reportId, planId, items }) {
    if (!Array.isArray(items) || items.length > 1000) fail('INVALID_INPUT', 'items must be an array');
    return this._serial(reportId, async () => {
      const record = await this._load(sessionId, reportId);
      const plan = record.publicationPlans.find(p => p.planId === planId);
      if (!plan) fail('NOT_FOUND', 'Plan not found');
      plan.payload = { ...clone(plan.payload), items: clone(items) };
      await this._write(record); return clone(plan);
    });
  }
  async listPublicationItems({ sessionId, reportId, planId }) {
    const record = await this._load(sessionId, reportId);
    const plan = record.publicationPlans.find(p => p.planId === planId);
    if (!plan) fail('NOT_FOUND', 'Plan not found');
    return clone(plan.payload?.items || []);
  }
  /** Per-item publication execution records for a plan (intent/executing/submitted/unknown/failed). */
  async listPublicationItemRecords({ sessionId, reportId, planId }) {
    const record = await this._load(sessionId, reportId);
    const latest = new Map();
    for (const r of record.publicationRecords) {
      if (r.planId !== planId || !r.itemKey) continue;
      latest.set(r.itemKey, r); // appended in order; latest per item wins
    }
    return clone([...latest.values()]);
  }

  // --- Per-session prompt templates (the human's editable 分析要求 / output-structure template). ---
  // Session-scoped (not report-scoped): one set of saved templates per session, persisted across restarts.
  _templatesFile(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) fail('INVALID_INPUT', 'sessionId is required');
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'x';
    return path.join(this.rootDir, 'templates', `${safe}.json`);
  }
  async _readTemplates(sessionId) {
    try { const arr = JSON.parse(await fs.readFile(this._templatesFile(sessionId), 'utf8')); return Array.isArray(arr) ? arr : []; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async _writeTemplates(sessionId, arr) {
    const file = this._templatesFile(sessionId);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(arr));
      await handle.sync(); await handle.close(); handle = undefined;
      await fs.rename(temporary, file);
    } finally { if (handle) await handle.close(); await fs.rm(temporary, { force: true }); }
  }
  async _serialTemplates(sessionId, work) {
    const key = this._templatesFile(sessionId);
    const previous = queues.get(key) || Promise.resolve();
    const job = previous.catch(() => {}).then(work);
    queues.set(key, job);
    try { return await job; } finally { if (queues.get(key) === job) queues.delete(key); }
  }
  async listPromptTemplates({ sessionId }) {
    if (typeof sessionId !== 'string' || !sessionId) fail('INVALID_INPUT', 'sessionId is required');
    return this._serialTemplates(sessionId, async () => clone(await this._readTemplates(sessionId)));
  }
  async savePromptTemplate({ sessionId, id, name, content }) {
    if (typeof sessionId !== 'string' || !sessionId) fail('INVALID_INPUT', 'sessionId is required');
    if (typeof content !== 'string' || !content.trim()) fail('INVALID_INPUT', 'content is required');
    const template = {
      id: (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) ? id : randomUUID(),
      name: (typeof name === 'string' && name.trim()) || '未命名模板',
      content,
      updatedAt: now(),
    };
    return this._serialTemplates(sessionId, async () => {
      const arr = await this._readTemplates(sessionId);
      const i = arr.findIndex(x => x.id === template.id);
      if (i >= 0) arr[i] = template; else arr.push(template);
      await this._writeTemplates(sessionId, arr);
      return clone(template);
    });
  }
  async deletePromptTemplate({ sessionId, id }) {
    if (typeof sessionId !== 'string' || !sessionId) fail('INVALID_INPUT', 'sessionId is required');
    if (typeof id !== 'string' || !id) fail('INVALID_INPUT', 'id is required');
    return this._serialTemplates(sessionId, async () => {
      const arr = await this._readTemplates(sessionId);
      const i = arr.findIndex(x => x.id === id);
      if (i < 0) return false;
      arr.splice(i, 1);
      await this._writeTemplates(sessionId, arr);
      return true;
    });
  }
}

// Verified against inspection/dsh-client-connection/lib/client.js:5171.
export default {
  name: 'run19-report-core',
  apply(ctx, config = {}) { const store = new ReportStore(config); ctx.provide('reportCore', store); }
};
