import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generate } from '../lib/generate.js';
const root = fileURLToPath(new URL('../.test-output/', import.meta.url));
await mkdir(root, { recursive: true });

test('validation rejects missing root, nonlocal API and unapproved web before generation', async () => {
  await assert.rejects(generate({ variety: '锡' }), /outputRoot/);
  await assert.rejects(generate({ variety: '锡' }, { outputRoot: root, baseUrl: 'https://example.com' }), /loopback/);
  await assert.rejects(generate({ variety: '锡', materials: [{ kind: 'web', id: 'x', title: 'x', text: 'x' }] }, { outputRoot: root }), /opt-in/);
});

test('MD manifest hashes, injected material allowlist and unique concurrent runs; GET only', async t => {
  const methods = [];
  const server = createServer((req, res) => {
    methods.push(req.method);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ time: 1788220800000, value: 100 }, { time: 1788825600000, value: 110 }]));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const opts = { outputRoot: await mkdtemp(root + 'case-'), baseUrl: `http://127.0.0.1:${server.address().port}` };
  const input = { variety: '锡', charts: false, end: '2026-09-08', materials: [{ id: 'K1', kind: 'weknora', title: '参考', text: '库存观察', token: 'DO_NOT_FORWARD' }] };
  const [a, b] = await Promise.all([generate(input, opts), generate(input, opts)]);
  assert.notEqual(a.runDir, b.runDir);
  assert.equal(a.schemaVersion, 'run19.weekly-source.v1');
  assert.equal(a.status, 'draft');
  assert.equal(a.config.webSearchExecuted, false);
  assert.deepEqual(a.assets, []);
  const md = await readFile(a.markdown.absolutePath, 'utf8');
  assert.match(md, /库存观察/);
  assert.equal(a.markdown.sha256, createHash('sha256').update(md).digest('hex'));
  assert.ok(methods.length > 0 && methods.every(x => x === 'GET'));
  assert.ok(!JSON.stringify(a).includes('DO_NOT_FORWARD'));
  assert.ok(!(await readdir(a.runDir)).some(p => p.endsWith('.pdf')));
});

test('timeout aborts Python and records controlled failure', async () => {
  await assert.rejects(generate({ variety: '锡', charts: false }, {
    outputRoot: root, timeoutMs: 1,
  }), asyncError => asyncError.code === 'GENERATION_TIMEOUT');
});

test('adapter imports exclude PDF and bootstrap entrypoints', async () => {
  const src = await readFile(new URL('../python/generate.py', import.meta.url), 'utf8');
  assert.ok(!/from rzlib import[^\n]*pdfbuilder/.test(src));
  assert.ok(!/^import (cli|fitz|pdfbuilder)/m.test(src));
  const vendorFiles = await readdir(new URL('../python/rzlib/', import.meta.url));
  assert.ok(!vendorFiles.includes('pdfbuilder.py'));
});

test('empty data fails explicitly with no successful manifest', async t => {
  const server = createServer((_, res) => res.end('[]'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  await assert.rejects(generate({ variety: '锡', charts: false }, {
    outputRoot: root, baseUrl: `http://127.0.0.1:${server.address().port}`,
  }), e => e.code === 'GENERATION_FAILED' && e.diagnostic.includes('NO_USABLE_DATA'));
});
