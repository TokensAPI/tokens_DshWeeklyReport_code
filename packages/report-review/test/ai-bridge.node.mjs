// Standalone node test of the DSH-backed model bridge (ai-bridge.mjs) WITHOUT the
// AI SDK. It mocks the host /api/run19/ai-stream as an in-process function returning
// NDJSON chunks (text-delta, tool-call-delta, block-end tool-call, finish) exactly like
// index.mjs fetchAiStream would when llm.stream emits tool calls.
//
// Now that the editor drives the LLM natively (createNativeChat), we assert directly on
// `model.doStream` output and on `createNativeChat`'s single tool part.
//
// Run from packages/report-review: node test/ai-bridge.node.mjs

import { createDshLlmModel, createNativeChat } from '../src/ai-bridge.mjs';

function ndjsonResponse(lines) {
  const body = new ReadableStream({
    start(ctrl) {
      const enc = new TextEncoder();
      for (const line of lines) ctrl.enqueue(enc.encode(JSON.stringify(line) + '\n'));
      ctrl.close();
    },
  });
  return new Response(body, { status: 200, ok: true });
}

function fakeFetch(lines) {
  return async (path, init) => {
    if (path !== '/api/run19/ai-stream') throw new Error('unexpected path ' + path);
    return ndjsonResponse(lines);
  };
}

// Drain a model.doStream into an array of plain chunks.
async function drainDoStream(model, prompt, tools) {
  const { stream } = await model.doStream({ prompt, tools });
  const reader = stream.getReader();
  const out = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out.push(value);
  }
  return out;
}

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log('  ok: ' + msg); } else { failed++; console.log('  FAIL: ' + msg); } }

async function main() {
  // 1) model returns a tool-call (update) chunk stream -> doStream yields a tool-call chunk.
  {
    console.log('--- test: model emits tool-call chunks -> doStream tool-call ---');
    const lines = [
      { t: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'Working...' } },
      { t: 'chunk', chunk: { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'update', argumentsDelta: '{"blockId":"b1","content":"' } },
      { t: 'chunk', chunk: { type: 'tool-call-delta', index: 1, id: 'call_1', argumentsDelta: 'new text"}' } },
      { t: 'chunk', chunk: { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_1', name: 'update', arguments: '{"blockId":"b1","content":"new text"}' } } },
      { t: 'chunk', chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
      { t: 'done' },
    ];
    const model = createDshLlmModel({ fetchFn: fakeFetch(lines), provider: 'dsh', model: 'test-model' });
    const chunks = await drainDoStream(model, [{ role: 'user', content: [{ type: 'text', text: 'rewrite block' }] }], [{ name: 'update', description: 'd', inputSchema: { type: 'object' } }]);
    const tc = chunks.find((c) => c.type === 'tool-call');
    assert(!!tc, 'one tool-call chunk surfaced');
    assert(tc?.toolName === 'update', 'tool name = update');
    assert(JSON.parse(tc?.input).content === 'new text', 'tool input parses to {content:"new text"} (raw string = ' + tc?.input + ')');
    const finish = chunks.find((c) => c.type === 'finish');
    assert(finish?.finishReason === 'tool-calls', 'finishReason = tool-calls (got ' + finish?.finishReason + ')');
  }

  // 2) model returns only text (no tool call) -> finish stop, no tool-call chunk.
  {
    console.log('--- test: model emits text only -> finish stop, no tool-call ---');
    const lines = [
      { t: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'Hello' } },
      { t: 'chunk', chunk: { type: 'text-delta', index: 0, text: ' world' } },
      { t: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } },
      { t: 'done' },
    ];
    const model = createDshLlmModel({ fetchFn: fakeFetch(lines), provider: 'dsh', model: 'test-model' });
    const chunks = await drainDoStream(model, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], []);
    const textDeltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta || '').join('') || chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('');
    assert(textDeltas === 'Hello world', 'text deltas concatenated to "Hello world" (got "' + textDeltas + '")');
    const finish = chunks.find((c) => c.type === 'finish');
    assert(finish?.finishReason === 'stop', 'finishReason = stop');
    assert(!chunks.some((c) => c.type === 'tool-call'), 'no tool-call chunk');
  }

  // 3) Native LLM path (what the editor uses): createNativeChat yields a single
  //    `tool-applyDocumentOperations` part at `input-available`.
  {
    console.log('--- test: createNativeChat -> single input-available tool part ---');
    const args = JSON.stringify({ operations: [{ type: 'add', referenceId: 'b1', position: 'after', blocks: ['<p>joke</p>'] }] });
    const lines = [
      { t: 'chunk', chunk: { type: 'block-start' } },
      { t: 'chunk', chunk: { type: 'tool-call-delta', id: 'call_2', name: 'applyDocumentOperations', argumentsDelta: args } },
      { t: 'chunk', chunk: { type: 'block-end', blockType: 'tool-call', blockName: 'applyDocumentOperations', blockId: 'call_2' } },
      { t: 'chunk', chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
      { t: 'done' },
    ];
    const chat = createNativeChat({ fetchFn: fakeFetch(lines) });
    const toolDefinitions = {
      applyDocumentOperations: {
        description: 'Apply operations to the document.',
        inputSchema: { type: 'object', properties: { operations: { type: 'array' } }, required: ['operations'], additionalProperties: false },
        outputSchema: { type: 'object' },
      },
    };
    await chat.sendMessage({ role: 'user', id: 'm1', parts: [{ type: 'text', text: 'rewrite' }] }, { body: { toolDefinitions } });
    const toolParts = (chat.lastMessage?.parts ?? []).filter((p) => p.type === 'tool-applyDocumentOperations');
    assert(chat.status === 'ready', 'chat.status = ready (got ' + chat.status + ')');
    assert(toolParts.length === 1, 'exactly one tool part (got ' + toolParts.length + ')');
    assert(toolParts[0]?.state === 'input-available', 'state = input-available');
    assert(typeof toolParts[0]?.input === 'object' && Array.isArray(toolParts[0]?.input?.operations), 'input is an object with operations array');
  }

  // 4) Regression: the tool NAME must reach the host body (it lives on the tool, not
  //    the array index). Before the fix this sent name "0".
  {
    console.log('--- test: tool name transmitted to host (not array index) ---');
    let captured = null;
    const capturingFetch = async (path, init) => { captured = JSON.parse(init.body); return ndjsonResponse([{ t: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }, { t: 'done' }]); };
    const model = createDshLlmModel({ fetchFn: capturingFetch, provider: 'dsh', model: 'test-model' });
    await drainDoStream(model, [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], [{ name: 'applyDocumentOperations', description: 'd', inputSchema: { type: 'object' } }]);
    assert(Array.isArray(captured?.tools), 'body.tools is an array');
    assert(captured?.tools?.[0]?.name === 'applyDocumentOperations', 'tool name transmitted as applyDocumentOperations (got ' + (captured?.tools?.[0]?.name) + ')');
  }

  console.log(`\nAI bridge tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
