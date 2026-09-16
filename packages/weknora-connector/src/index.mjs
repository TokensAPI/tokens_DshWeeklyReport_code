import { spawn } from 'node:child_process';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { readHttp } from './read-http.mjs';
import {snapshotImage,imageMultipart,pdfMultipart,snapshotPdf,validResourcePath} from './image-asset.mjs';

const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x);
const error = (code, unknown = false) => ({ ok: false, error: code, outcome_unknown: unknown, automatic_retry: false });
const strictKeys = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));
const imageContent = text => /!\s*\[|<\s*(?:img|picture|svg|iframe|object)\b|data\s*:|file\s*:\/\/|(?:^|[\s("'])\/(?:Users|home|tmp|private|Volumes)\//im.test(text);
const resourceOK = value => typeof value === 'string' && /^resource:\/\/[A-Za-z0-9_-]{22}$/.test(value);
// Host-coordinated report: image destinations must be canonical resource:// handles (verified bindings).
const reportImageCheck = text => {
  const dangerous = /<\s*(?:img|picture|svg|iframe|object)\b|data\s*:|file\s*:\/\/|(?:^|[\s("'])\/(?:Users|home|tmp|private|Volumes)\//im;
  if (dangerous.test(text)) return true;
  const refs = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map(m => m[1]);
  return refs.some(ref => !resourceOK(ref));
};
const safeTitle = text => typeof text === 'string' && text.trim() && text.length <= 512 && !/[\x00-\x1f]/.test(text);
const safeTags = tags => Array.isArray(tags) && tags.length <= 100 && tags.every(id);
// Principal (author) id from /auth/me. Platform API-key users use ids like
// `api_platform:9`, which fail the UUID-oriented `id()`; accept safe printable ASCII.
const validPrincipalId = x => typeof x === 'string' && x.length >= 1 && x.length <= 128 && /^[\x21-\x7e]+$/.test(x) && !x.includes('\x00');

export const name = 'weknora-connector';
export function apply(ctx, config) { ctx.provide('weknoraConnector', new Connector(config)); }
export default { name, apply };

export class Connector {
  #config;
  constructor(config) {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/', '/api/v1', '/api/v1/'].includes(url.pathname)) throw new Error('invalid_base_url');
    if (url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('plaintext_non_loopback');
    if (!Array.isArray(config.allowedKbs) || !config.allowedKbs.length || !config.allowedKbs.every(id)) throw new Error('empty_or_invalid_kb_allowlist');
    for (const key of ['readSecretFile', ...(config.clientPath === undefined ? [] : ['clientPath'])]) if (typeof config[key] !== 'string' || !path.isAbsolute(config[key]) || config[key].includes('\0')) throw new Error('invalid_config');
    if (config.writeSecretFile !== undefined && (typeof config.writeSecretFile !== 'string' || !path.isAbsolute(config.writeSecretFile) || config.writeSecretFile === config.readSecretFile)) throw new Error('separate_write_secret_required');
    if (config.pythonPath !== undefined && !path.isAbsolute(config.pythonPath)) throw new Error('invalid_python_path');
    if (config.tenantId !== undefined && (typeof config.tenantId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(config.tenantId) || config.tenantId.includes('\0'))) throw new Error('invalid_tenant_id');
    if(config.assetRoots!==undefined && (!Array.isArray(config.assetRoots)||config.assetRoots.some(p=>typeof p!=='string'||!path.isAbsolute(p)||p.includes('\0'))))throw new Error('invalid_asset_roots');
    const timeoutMs = config.timeoutMs ?? 15000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('invalid_timeout');
    this.#config = Object.freeze({ ...config, baseUrl: url.origin, allowedKbs: Object.freeze([...config.allowedKbs]), assetRoots:Object.freeze([...(config.assetRoots??[])]), timeoutMs });
  }
  async identity({ forPublication = false, purpose = forPublication || this.#config.writeSecretFile ? 'publish' : 'read' } = {}) {
    if (forPublication) purpose = 'publish';
    if (!['read', 'publish'].includes(purpose) || (purpose === 'publish' && !this.#config.writeSecretFile)) return { verified: false, principal: null, error: 'identity_credential_unavailable' };
    const result = await this.#request('GET', '/auth/me', undefined, { operation: 'identity', purpose });
    if (!result.ok) return { verified: false, authentication: 'scoped_api_key', principal: null, error: result.error, explanation: 'The server did not provide a verifiable identity; no local display-name or admin fallback is used.' };
    return result.data;
  }
  capabilities() { return { read: ['detail', 'chunks', 'search'], reviewHostWritesConfigured: Boolean(this.#config.writeSecretFile), images: false, imageUploadConfigured:Boolean(this.#config.writeSecretFile && this.#config.assetRoots.length), automatic_retry: false }; }
  #scope(kb, knowledgeId) { return id(kb) && this.#config.allowedKbs.includes(kb) && (knowledgeId === undefined || id(knowledgeId)); }
  async #read(command, args, signal) {
    if (signal?.aborted) return error('cancelled');
    const c = this.#config;
    if (c.clientPath === undefined) return readHttp(c, command, args, signal);
    return new Promise(resolve => {
      let out = [], size = 0, failure, timer, killTimer;
      const child = spawn(c.pythonPath ?? '/usr/bin/python3', ['-B', c.clientPath, `--base-url=${c.baseUrl}`, `--secret-file=${c.readSecretFile}`, ...c.allowedKbs.map(k => `--allow-kb=${k}`), command, ...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      const stop = code => { if (failure) return; failure = code; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 250); };
      const abort = () => stop('cancelled');
      timer = setTimeout(() => stop('timeout'), c.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) stop('response_too_large'); else out.push(chunk); });
      let stderrSize = 0; const diagnostics = [];
      child.stderr.on('data', chunk => { stderrSize += chunk.length; if (stderrSize > 65536) stop('diagnostic_too_large'); else diagnostics.push(chunk); });
      child.on('error', () => { failure = 'process_error'; });
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
        if (failure || code !== 0) {
          let category = failure ?? 'read_failed';
          if (!failure) try { const e = JSON.parse(Buffer.concat(diagnostics).toString('utf8')).error; if (['unauthorized', 'forbidden', 'not_found', 'rate_limited', 'timeout', 'transport_error', 'tls_error', 'response_scope_mismatch', 'secret_unavailable', 'unsafe_secret_file', 'redirect_rejected'].includes(e)) category = e; } catch {}
          return resolve(error(category));
        }
        try { const data = JSON.parse(Buffer.concat(out).toString('utf8')); if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) return resolve(error('invalid_response')); resolve({ ok: true, data }); }
        catch { resolve(error('invalid_response')); }
      });
    });
  }
  detail(kbId, knowledgeId, { signal } = {}) { return this.#scope(kbId, knowledgeId) ? this.#read('detail', [kbId, knowledgeId], signal) : Promise.resolve(error('scope_rejected')); }
  status(kbId, knowledgeId, options) { return this.detail(kbId, knowledgeId, options); }
  chunks(kbId, knowledgeId, { page = 1, pageSize = 20, signal } = {}) {
    if (!this.#scope(kbId, knowledgeId) || !Number.isInteger(page) || page < 1 || page > 1000000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) return Promise.resolve(error('invalid_arguments'));
    return this.#read('chunks', [kbId, knowledgeId, `--page=${page}`, `--page-size=${pageSize}`], signal);
  }
  search(kbId, query, { matchCount = 10, signal } = {}) {
    if (!this.#scope(kbId) || typeof query !== 'string' || !query.trim() || query.length > 8192 || !Number.isInteger(matchCount) || matchCount < 1 || matchCount > 100) return Promise.resolve(error('invalid_arguments'));
    // End options before positional query; user text can never inject CLI options.
    return this.#read('search', [`--match-count=${matchCount}`, '--', kbId, query], signal);
  }
  /** Move already-published knowledges into a library folder (POST /knowledge/folder). Trusted host only. */
  moveToFolder(kbId, knowledgeIds, folderPath) {
    if (!this.#scope(kbId) || !Array.isArray(knowledgeIds) || !knowledgeIds.length || knowledgeIds.length > 100 || !knowledgeIds.every(id) || !folderPath || typeof folderPath !== 'string' || folderPath.length > 1024 || /[\x00-\x1f]/.test(folderPath)) return Promise.resolve(error('invalid_arguments'));
    return this.#request('POST', '/knowledge/folder', { kb_id: kbId, knowledge_ids: knowledgeIds, folder_path: folderPath }, { operation: 'moveFolder' });
  }
  /** TRUSTED HOST ONLY. Never expose this port, connector instance, or its methods as Agent tools/RPC. */
  createReviewHost() {
    const approvals = new WeakMap();
    return Object.freeze({
      // Host-internal projection only; not the ordinary Agent-facing detail reader.
      imageDetail: (kbId,knowledgeId) => this.#scope(kbId,knowledgeId) ? this.#request('GET',`/knowledge/${knowledgeId}`,undefined,{operation:'imageDetail',purpose:'read',kbId,knowledgeId}) : Promise.resolve(error('scope_rejected')),
      approve: request => {
        const normalized = this.#validateWrite(request);
        if (normalized.error) return normalized;
        const capability = Object.freeze(Object.create(null));
        approvals.set(capability, normalized);
        return capability;
      },
      execute: async capability => {
        if (!capability || !approvals.has(capability)) return error('review_capability_required');
        const request = approvals.get(capability); approvals.delete(capability);
        return this.#executeWrite(request);
      }
    });
  }
  #validateWrite(r) {
    if (!this.#config.writeSecretFile) return error('write_not_configured');
    if(r?.operation==='publishImage'){
      if(!strictKeys(r,['operation','kbId','title','path','sha256','tagIds'])||!this.#scope(r.kbId))return error('invalid_arguments');
      if(!safeTitle(r.title))return error('invalid_title');
      if(r.tagIds!==undefined&&!safeTags(r.tagIds))return error('invalid_tags');
      const image=snapshotImage(this.#config,r);if(!image.ok)return error(image.error);
      return Object.freeze({operation:r.operation,kbId:r.kbId,title:r.title,sha256:r.sha256,tagIds:Object.freeze([...(r.tagIds??[])]),bytes:image.bytes,mime:image.mime,extension:image.extension});
    }
    if (r?.operation === 'publishPdf') {
      if (!strictKeys(r, ['operation', 'kbId', 'title', 'path', 'tagIds']) || !this.#scope(r.kbId)) return error('invalid_arguments');
      if (!safeTitle(r.title)) return error('invalid_title');
      if (r.tagIds !== undefined && !safeTags(r.tagIds)) return error('invalid_tags');
      const pdf = snapshotPdf(this.#config, r); if (!pdf.ok) return error(pdf.error);
      return Object.freeze({ operation: r.operation, kbId: r.kbId, title: r.title, tagIds: Object.freeze([...(r.tagIds ?? [])]), bytes: pdf.bytes, mime: pdf.mime, extension: pdf.extension, sha256: pdf.sha256 });
    }
    if (r?.operation === 'publishReport') {
      if (!strictKeys(r, ['operation', 'kbId', 'title', 'content', 'tagIds']) || !this.#scope(r.kbId) || !safeTitle(r.title)) return error('invalid_arguments');
      if (typeof r.content !== 'string' || !r.content.trim() || Buffer.byteLength(r.content) > 512 * 1024) return error('invalid_content');
      if (reportImageCheck(r.content)) return error('images_not_supported');
      if (r.tagIds !== undefined && !safeTags(r.tagIds)) return error('invalid_tags');
      return Object.freeze({ ...r, ...(r.tagIds ? { tagIds: Object.freeze([...r.tagIds]) } : {}) });
    }
    // Human review act: overwrite a published chunk with the reviewer's text so weKnora natively
    // records content/content_revision/last_editor_id/chunk_revisions (source_content stays = LLM).
    if (r?.operation === 'updateChunk') {
      if (!strictKeys(r, ['operation', 'kbId', 'knowledgeId', 'chunkId', 'content', 'expectedRevision', 'isEnabled']) || !this.#scope(r.kbId, r.knowledgeId) || !id(r.chunkId)) return error('invalid_arguments');
      if (typeof r.content !== 'string' || !r.content.trim() || Buffer.byteLength(r.content) > 128 * 1024) return error('invalid_content');
      if (r.expectedRevision !== undefined && (!Number.isInteger(r.expectedRevision) || r.expectedRevision < 0 || r.expectedRevision > 1e9)) return error('invalid_arguments');
      if (r.isEnabled !== undefined && typeof r.isEnabled !== 'boolean') return error('invalid_arguments');
      return Object.freeze({ operation: r.operation, kbId: r.kbId, knowledgeId: r.knowledgeId, chunkId: r.chunkId, content: r.content, ...(r.expectedRevision === undefined ? {} : { expectedRevision: r.expectedRevision }), ...(r.isEnabled === undefined ? {} : { isEnabled: r.isEnabled }) });
    }
    // Store the format-excluded human-review marks on the published knowledge (machine-readable).
    if (r?.operation === 'setKnowledgeMetadata') {
      if (!strictKeys(r, ['operation', 'kbId', 'knowledgeId', 'customMetadata']) || !this.#scope(r.kbId, r.knowledgeId)) return error('invalid_arguments');
      if (!r.customMetadata || typeof r.customMetadata !== 'object' || Array.isArray(r.customMetadata) || Buffer.byteLength(JSON.stringify(r.customMetadata)) > 64 * 1024) return error('invalid_arguments');
      return Object.freeze({ operation: r.operation, kbId: r.kbId, knowledgeId: r.knowledgeId, customMetadata: r.customMetadata });
    }
    if (!strictKeys(r, ['operation', 'kbId', 'knowledgeId', 'title', 'content', 'tagIds']) || !this.#scope(r.kbId, r.knowledgeId)) return error('invalid_arguments');
    if (!['publishManual', 'title', 'tags'].includes(r.operation)) return error('unsupported_operation');
    const fields = r.operation === 'publishManual' ? ['operation', 'kbId', 'title', 'content', 'tagIds'] : r.operation === 'title' ? ['operation', 'kbId', 'knowledgeId', 'title'] : ['operation', 'kbId', 'knowledgeId', 'tagIds'];
    if (!strictKeys(r, fields)) return error('invalid_arguments');
    if (r.operation !== 'publishManual' && r.operation !== 'publishReport' && !id(r.knowledgeId)) return error('invalid_arguments');
    if ((r.operation === 'publishManual' || r.operation === 'publishReport') && r.knowledgeId !== undefined) return error('invalid_arguments');
    if (r.operation !== 'tags' && !safeTitle(r.title)) return error('invalid_title');
    if ((r.operation === 'publishManual' || r.operation === 'publishReport') && (typeof r.content !== 'string' || !r.content.trim() || Buffer.byteLength(r.content) > 512 * 1024)) return error('invalid_content');
    if (r.content !== undefined && imageContent(r.content)) return error('images_not_supported');
    if (r.tagIds !== undefined && !safeTags(r.tagIds)) return error('invalid_tags');
    if (r.operation === 'tags' && !safeTags(r.tagIds)) return error('invalid_tags');
    return Object.freeze({ ...r, ...(r.tagIds ? { tagIds: Object.freeze([...r.tagIds]) } : {}) });
  }
  async #reuseExistingFile(kbId, title) {
    const s = await this.search(kbId, title, { matchCount: 30 });
    if (s?.ok !== true) return null;
    const exts = ['.png', '.jpg', '.jpeg', '.pdf'];
    const row = (s.data?.data || []).find(x => x?.knowledge_id && typeof x?.knowledge_title === 'string' && (exts.some(e => x.knowledge_title === `${title}${e}`) || x.knowledge_title.startsWith(`${title}.`)));
    if (!row?.knowledge_id) return null;
    const cur = await this.#request('GET', `/knowledge/${row.knowledge_id}`, undefined, { operation: 'imageDetail', purpose: 'read', kbId, knowledgeId: row.knowledge_id });
    if (cur?.ok !== true) return null;
    return { ok: true, data: { id: cur.data.id, knowledge_base_id: cur.data.knowledge_base_id, file_path: cur.data.file_path, parse_status: cur.data.parse_status }, submitted: true, automatic_retry: false, processing_complete: false, idempotency: 'not_implemented' };
  }
  async #executeWrite(r) {
    if(r.operation==='publishImage'){
      const res = await this.#request('POST',`/knowledge-bases/${r.kbId}/knowledge/file`,undefined,r,imageMultipart(r));
      // Idempotent re-run: the same image title already exists (409). Reuse its resource URI so the
      // markdown can bind to the already-uploaded image instead of failing the whole publication.
      if (res?.ok !== true && res?.error === 'conflict') {
        const reused = await this.#reuseExistingFile(r.kbId, r.title);
        if (reused?.ok === true) return reused;
      }
      return res;
    }
    if(r.operation==='publishPdf'){
      const res = await this.#request('POST',`/knowledge-bases/${r.kbId}/knowledge/file`,undefined,r,pdfMultipart(r));
      if (res?.ok !== true && res?.error === 'conflict') {
        const reused = await this.#reuseExistingFile(r.kbId, r.title);
        if (reused?.ok === true) return reused;
      }
      return res;
    }
    // ID-only mutations verify the parent with the read credential before sending a write.
    if (r.operation !== 'publishManual' && r.operation !== 'publishReport') {
      const checked = await this.detail(r.kbId, r.knowledgeId);
      if (!checked.ok) return error('preflight_read_failed');
    }
    let path, body;
    if (r.operation === 'publishManual' || r.operation === 'publishReport') { path = `/knowledge-bases/${r.kbId}/knowledge/manual`; body = { title: r.title, content: r.content, status: 'publish', channel: 'api', tag_ids: r.tagIds ?? [] }; }
    else if (r.operation === 'title') { path = `/knowledge/${r.knowledgeId}`; body = { title: r.title }; }
    else if (r.operation === 'updateChunk') { path = `/chunks/${r.kbId}/${r.knowledgeId}/${r.chunkId}`; body = { content: r.content, ...(r.expectedRevision === undefined ? {} : { expected_revision: r.expectedRevision }), ...(r.isEnabled === undefined ? {} : { is_enabled: r.isEnabled }) }; }
    else if (r.operation === 'setKnowledgeMetadata') { path = `/knowledge/${r.knowledgeId}`; body = { custom_metadata: r.customMetadata }; }
    else { path = '/knowledge/tags'; body = { kb_id: r.kbId, updates: { [r.knowledgeId]: r.tagIds } }; }
    return this.#request(r.operation === 'publishManual' || r.operation === 'publishReport' ? 'POST' : 'PUT', path, body, r);
  }
  async #request(method, path, body, target, multipart) {
    let file, key;
    try {
      const secretPath = method === 'GET' && target.purpose !== 'publish' ? this.#config.readSecretFile : this.#config.writeSecretFile;
      const before = await lstat(secretPath);
      if (!before.isFile() || before.isSymbolicLink()) return error('unsafe_secret_file');
      file = await open(secretPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const s = await file.stat();
      const posixOwnerUnsafe = typeof process.getuid === 'function' && ((s.mode & 0o077) || s.uid !== process.getuid());
      if (!s.isFile() || s.dev !== before.dev || s.ino !== before.ino || posixOwnerUnsafe || s.size > 4096) return error('unsafe_secret_file');
      const buffer = Buffer.alloc(4097); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      key = buffer.subarray(0, bytesRead).toString('latin1').replace(/[\r\n]+$/, '');
      if (!key || key.length > 4096 || /[^\x21-\x7e]/.test(key)) return error('invalid_secret');
    } catch { return error('secret_unavailable'); } finally { await file?.close(); }
    const payload = multipart?.payload ?? (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
    if (payload.length > (multipart ? 10*1024*1024+8192 : 1024 * 1024)) return error('request_too_large');
    const url = new URL(`/api/v1${path}`, this.#config.baseUrl);
    return new Promise(resolve => {
      let settled = false, timer;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const req = (url.protocol === 'https:' ? https : http).request(url, { method, headers: { 'X-API-Key': key, 'Content-Type': multipart?.contentType ?? 'application/json', 'Content-Length': payload.length, ...(this.#config.tenantId ? { 'X-Tenant-ID': this.#config.tenantId } : {}) }, agent: false }, res => {
        const code = res.statusCode;
        if (code < 200 || code >= 300) { res.destroy(); return finish(error(code >= 300 && code < 400 ? 'redirect_rejected' : ({ 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 429: 'rate_limited' }[code] ?? 'server_error'), ![400, 401, 403, 404, 409, 429].includes(code))); }
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) { res.destroy(); finish(error('response_too_large', true)); } else chunks.push(chunk); });
        res.on('error', () => finish(error('transport_error', true)));
        res.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (target.operation === 'identity') {
              const user = value.data?.user, tenant = value.data?.tenant;
              if (value.success !== true || !user || !validPrincipalId(user.id) || typeof user.username !== 'string' || !user.username.trim() || user.username.length > 256 || /[\x00-\x1f]/.test(user.username) || !tenant || !(typeof tenant.id === 'string' || Number.isSafeInteger(tenant.id)) || !/^[1-9][0-9]*$/.test(String(tenant.id)) || [user.id, user.username, String(tenant.id)].some(x => x.includes(key))) return finish(error('invalid_identity_response'));
              return finish({ ok: true, data: { verified: true, verification: 'GET /api/v1/auth/me', credentialPurpose: target.purpose, authentication: 'scoped_api_key', principal: { userId: user.id, username: user.username, tenantId: String(tenant.id) }, humanIdentityVerified: false, explanation: 'Server-resolved API-key account. This may be a shared tenant account; it is not proof of the current human or administrator role.' } });
            }
            if (target.operation === 'tags' && value.success === true) return finish({ ok: true, data: { id: target.knowledgeId, knowledge_base_id: target.kbId }, submitted: true, automatic_retry: false });
            if (target.operation === 'moveFolder' && value.success === true) return finish({ ok: true, data: value.data || {} });
            // Chunk-level mutation: the response is a Chunk (its id is the chunk, not the knowledge).
            if ((target.operation === 'updateChunk' || target.operation === 'chunkRevisions') && value.success === true) return finish({ ok: true, data: value.data || {}, submitted: true, automatic_retry: false });
            if (value.success !== true || !value.data || value.data.knowledge_base_id !== target.kbId || !id(value.data.id) || (target.knowledgeId && value.data.id !== target.knowledgeId)) return finish(error('invalid_response', true));
            const data = { id: value.data.id, knowledge_base_id: value.data.knowledge_base_id };
            if(['publishImage','publishPdf','imageDetail'].includes(target.operation)){
              if(!validResourcePath(value.data.file_path))return finish(error('invalid_resource_response',true));
              data.file_path=value.data.file_path;
            }
            for (const field of ['parse_status', 'summary_status']) if (typeof value.data[field] === 'string' && !value.data[field].includes(key)) data[field] = value.data[field];
            if (Object.values(data).some(v => v.includes(key))) return finish(error('invalid_response', true));
            if(target.operation==='imageDetail')return finish({ok:true,data,automatic_retry:false});
            finish({ ok: true, data, submitted: true, processing_complete: false, automatic_retry: false, idempotency: 'not_implemented' });
          } catch { finish(error('invalid_response', true)); }
        });
      });
      timer = setTimeout(() => { req.destroy(); finish(error('timeout', true)); }, this.#config.timeoutMs);
      req.on('error', () => finish(error('transport_error', true)));
      req.end(payload);
    });
  }
}
