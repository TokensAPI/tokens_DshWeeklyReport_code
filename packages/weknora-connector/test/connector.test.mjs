import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import plugin, { Connector, name, apply } from '../src/index.mjs';

test('fake HTTP contract: separate keys, scope, read, publish, title, tags, capabilities and unknown writes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'run19-connector-'));
  const readSecretFile = join(temp, 'read.key'), writeSecretFile = join(temp, 'write.key');
  await writeFile(readSecretFile, 'test-read', { mode: 0o600 });
  await writeFile(writeSecretFile, 'test-write', { mode: 0o600 });
  const requests = []; let mode = 'ok';
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body: raw && JSON.parse(raw) });
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET' && mode === '503') { res.writeHead(503); res.end('{}'); return; }
    if (req.method !== 'GET' && mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/stolen' }); res.end(); return; }
    if (req.url === '/api/v1/auth/me') { if (mode === 'identity-denied') { res.writeHead(403); res.end('{}'); return; } res.end(JSON.stringify({ success: true, data: { user: { id: 'u1', username: req.headers['x-api-key'] === 'test-write' ? 'uploader' : 'reader' }, tenant: { id: 10000 } } })); }
    else if (req.url === '/api/v1/knowledge/tags') res.end(JSON.stringify({ success: true }));
    else if (req.url.startsWith('/api/v1/chunks/')) res.end(JSON.stringify({ success: true, data: [{ id: 'chunk', knowledge_id: 'doc', content: 'fixture' }], page: 1, page_size: 20, total: 1 }));
    else if (req.url.includes('hybrid-search')) res.end(JSON.stringify({ success: true, data: [{ id: 'chunk', knowledge_id: 'doc', knowledge_base_id: 'kb', content: 'fixture' }] }));
    else res.end(JSON.stringify({ success: true, data: { id: 'doc', knowledge_base_id: 'kb', parse_status: 'pending', title: 'fixture' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, readSecretFile, writeSecretFile, allowedKbs: ['kb'] };
    const c = new Connector(config);
    assert.equal(plugin.name, 'weknora-connector'); assert.equal(name, plugin.name); assert.equal(apply, plugin.apply);
    let provided; apply({ provide: (key, value) => { assert.equal(key, 'weknoraConnector'); provided = value; } }, config); assert.ok(provided instanceof Connector);
    assert.equal((await c.identity()).principal.username, 'uploader');
    assert.equal((await c.identity({ forPublication: true })).credentialPurpose, 'publish');
    assert.equal((await c.identity({ purpose: 'read' })).principal.username, 'reader');
    assert.equal((await new Connector({ ...config, writeSecretFile: undefined }).identity({ forPublication: true })).verified, false);
    mode = 'identity-denied'; assert.equal((await c.identity()).verified, false); mode = 'ok';
    assert.equal((await c.detail('other', 'doc')).error, 'scope_rejected');
    assert.equal((await c.detail('kb', 'doc')).ok, true);
    assert.equal(requests.at(-1).key, 'test-read');
    assert.equal((await c.chunks('kb', 'doc')).ok, true);
    assert.equal((await c.search('kb', '--secret-file=/evil')).ok, true);
    assert.equal(requests.at(-1).body.query_text, '--secret-file=/evil');
    const host = c.createReviewHost();
    assert.equal((await host.execute({ userConfirmed: true })).error, 'review_capability_required');
    assert.equal(host.approve({ operation: 'publishManual', kbId: 'kb', title: 'x', content: '![x](data:image/png;base64,AA)' }).error, 'images_not_supported');
    const request = { operation: 'publishManual', kbId: 'kb', title: 'Title', content: '# Body', tagIds: ['tag'] };
    const cap = host.approve(request); request.content = 'changed';
    assert.equal((await host.execute(cap)).ok, true);
    assert.equal(requests.at(-1).key, 'test-write');
    assert.equal(requests.at(-1).body.content, '# Body');
    assert.deepEqual(requests.at(-1).body.tag_ids, ['tag']);
    assert.equal((await host.execute(cap)).error, 'review_capability_required');
    assert.equal((await host.execute(host.approve({ operation: 'title', kbId: 'kb', knowledgeId: 'doc', title: 'new' }))).ok, true);
    assert.equal(requests.at(-1).method, 'PUT');
    assert.deepEqual(requests.at(-1).body, { title: 'new' });
    assert.equal((await host.execute(host.approve({ operation: 'tags', kbId: 'kb', knowledgeId: 'doc', tagIds: ['tag'] }))).ok, true);
    assert.deepEqual(requests.at(-1).body, { kb_id: 'kb', updates: { doc: ['tag'] } });
    // Human-review writes: overwrite a chunk so weKnora records content_revision/last_editor/chunk_revisions.
    assert.equal((await host.execute(host.approve({ operation: 'updateChunk', kbId: 'kb', knowledgeId: 'doc', chunkId: 'chunk1', content: '人工修订后的文本', expectedRevision: 0 }))).ok, true);
    assert.equal(requests.at(-1).method, 'PUT');
    assert.equal(requests.at(-1).url, '/api/v1/chunks/doc/chunk1');
    assert.deepEqual(requests.at(-1).body, { content: '人工修订后的文本', expected_revision: 0 });
    // Store format-excluded human-review marks on the published knowledge.
    assert.equal(host.approve({ operation: 'setKnowledgeMetadata', kbId: 'kb', knowledgeId: 'doc', customMetadata: { review_marks: { substantive: true } } }).error, 'invalid_arguments');
    assert.equal((await host.execute(host.approve({ operation: 'setKnowledgeMetadata', kbId: 'kb', knowledgeId: 'doc', customMetadata: { review_marks: JSON.stringify({ substantive: true, edits: [{ op: 'add', text: '风险提示' }] }) } }))).ok, true);
    assert.equal(requests.at(-1).method, 'PUT');
    assert.ok(requests.at(-1).url.endsWith('/api/v1/knowledge/doc'));
    assert.equal(JSON.parse(requests.at(-1).body.custom_metadata.review_marks).substantive, true);
    // Validation guards.
    assert.equal(host.approve({ operation: 'updateChunk', kbId: 'kb', knowledgeId: 'doc', chunkId: 'bad chunk', content: 'x' }).error, 'invalid_arguments');
    assert.equal(host.approve({ operation: 'updateChunk', kbId: 'kb', knowledgeId: 'doc', chunkId: 'c', content: '  ' }).error, 'invalid_content');
    assert.equal(host.approve({ operation: 'setKnowledgeMetadata', kbId: 'kb', knowledgeId: 'doc', customMetadata: [] }).error, 'invalid_arguments');
    mode = '503'; const before = requests.length;
    const failed = await host.execute(host.approve({ ...request, content: 'body' }));
    assert.equal(failed.outcome_unknown, true); assert.equal(failed.automatic_retry, false); assert.equal(requests.length, before + 1);
    mode = 'redirect'; assert.equal((await host.execute(host.approve({ ...request, content: 'body' }))).error, 'redirect_rejected');
    assert.throws(() => new Connector({ ...config, allowedKbs: [] }));
    assert.throws(() => new Connector({ ...config, writeSecretFile: readSecretFile }));
    assert.equal(new Connector({ ...config, writeSecretFile: undefined }).createReviewHost().approve(request).error, 'write_not_configured');
  } finally { await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }); }
});
