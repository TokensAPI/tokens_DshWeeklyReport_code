import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createNativeChat } from '../src/ai-bridge.mjs';

const require = createRequire(import.meta.url);
// The format lives in the TypeScript editor-ai tree, so it has to be bundled before Node can
// read it — same approach as parity.test.mjs and editor-playground.test.mjs.
async function loadFormat() {
  const result = await build({
    stdin: {
      contents: "export { htmlBlockLLMFormat } from './editor-ai/api/formats/html-blocks/htmlBlocks.js';",
      resolveDir: fileURLToPath(new URL('../src', import.meta.url)),
      loader: 'ts',
    },
    write: false, bundle: true, format: 'cjs', platform: 'node',
    external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'text' },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports.htmlBlockLLMFormat;
}

// Block ids are handed to the model with a trailing `$` (DocumentStateBuilder calls suffixIDs),
// and every operation tool rejects an id that comes back without it. Only the format's own
// system prompt tells the model to preserve it. Upstream xl-ai sends that prompt as part of its
// LLM request; this fork drives DSH directly and the rewrite dropped it, so the model stripped
// the `$` it was given and every edit died with "id must end with $".

test('the html-block format prompt still carries the trailing-$ rule', async () => {
  const prompt = (await loadFormat()).systemPrompt;
  assert.ok(typeof prompt === 'string' && prompt.length > 0);
  assert.match(prompt, /trailing \$/, 'the id rule is what makes operations apply at all');
  assert.match(prompt, /applyDocumentOperations/);
});

function capturingFetch(sink) {
  return async (path, init) => {
    sink.push({ path, body: JSON.parse(init.body) });
    const body = new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(JSON.stringify({ t: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }) + '\n'));
        c.enqueue(enc.encode(JSON.stringify({ t: 'done' }) + '\n'));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  };
}

test('createNativeChat forwards the format system prompt to the host', async () => {
  const sent = [];
  const chat = createNativeChat({
    fetchFn: capturingFetch(sent),
    sessionId: 's1',
    reportId: 'r1',
    system: (await loadFormat()).systemPrompt,
  });
  await chat.sendMessage(
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: '把锡价填进表格' }] },
    { body: { toolDefinitions: { applyDocumentOperations: { description: 'edit', inputSchema: {} } } } },
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.system, /trailing \$/, 'the model must be told to keep the id suffix');
  // The per-report anchor still rides along with it.
  assert.match(sent[0].body.system, /r1/);
});
