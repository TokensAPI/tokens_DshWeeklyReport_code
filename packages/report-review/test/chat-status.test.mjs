import { createNativeChat } from '../src/ai-bridge.mjs';

// Native LLM chat status test: drive createNativeChat (the editor's real path) and
// assert the status transitions (submitted -> ready) plus a single tool part at
// `input-available` (exactly what the StreamToolExecutor consumes).

// ---- mock host stream: uses the NESTED `block` shape the DSH host actually emits ----
const lines = [];
const push = (chunk) => lines.push(JSON.stringify({ t: 'chunk', chunk }));
push({ type: 'block-start' });
for (let i = 0; i < 3; i++) push({ type: 'reasoning-delta', text: 'think' });
const args = JSON.stringify({ operations: [{ type: 'add', referenceId: 'b1', position: 'after', blocks: ['<p>joke</p>'] }] });
push({ type: 'tool-call-delta', id: 'chatcmpl-tool-87bf362d92375a7a', name: 'applyDocumentOperations', argumentsDelta: args });
push({ type: 'block-end', block: { type: 'tool-call', name: 'applyDocumentOperations', id: 'chatcmpl-tool-87bf362d92375a7a' } });
push({ type: 'finish', reason: { kind: 'tool-calls' } });
const hostNdj = lines.join('\n') + '\n';

const fetchFn = async (path, init) => {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(hostNdj)); c.close(); } }), { status: 200, ok: true });
};

const chat = createNativeChat({ fetchFn });

const statuses = [];
chat['~registerStatusCallback'](() => { statuses.push(chat.status); });
chat['~registerMessagesCallback'](() => {
  const last = chat.lastMessage;
  const toolParts = (last?.parts ?? []).filter((p) => String(p.type).startsWith('tool'));
  if (toolParts.length) {
    globalThis.__lastToolParts = toolParts.map((p) => ({ type: p.type, state: p.state, toolCallId: p.toolCallId, inputDefined: p.input !== undefined, inputType: typeof p.input }));
  }
});

const toolDefinitions = {
  applyDocumentOperations: {
    description: 'Apply operations to the document.',
    inputSchema: { type: 'object', properties: { operations: { type: 'array' } }, required: ['operations'], additionalProperties: false },
    outputSchema: { type: 'object' },
  },
};

const message = { role: 'user', id: 'm-user-1', parts: [{ type: 'text', text: 'Add a joke below the selection.' }], metadata: { documentState: { selection: null, blocks: [{ id: 'b1', type: 'paragraph' }], isEmptyDocument: false } } };

// run with a timeout guard
const timer = setTimeout(() => {
  console.log('!!! TIMEOUT: sendMessage did not resolve -> chat.status stuck');
  console.log('statuses so far:', JSON.stringify(statuses));
  console.log('final status:', chat.status);
  process.exit(0);
}, 8000);

try {
  await chat.sendMessage(message, { body: { toolDefinitions } });
  clearTimeout(timer);
  await new Promise((r) => setTimeout(r, 200));
} catch (err) {
  clearTimeout(timer);
  console.log('sendMessage threw:', err?.message || err);
}

console.log('=== chat.status transitions ===');
console.log(JSON.stringify(statuses));
console.log('final status:', chat.status);
console.log('=== tool parts seen in last message ===');
console.log(JSON.stringify(globalThis.__lastToolParts ?? 'NONE', null, 2));

const ok =
  statuses.includes('submitted') &&
  chat.status === 'ready' &&
  (globalThis.__lastToolParts ?? []).length === 1 &&
  globalThis.__lastToolParts[0]?.state === 'input-available';

console.log('=== final check ===');
console.log('PASS?', ok);
process.exit(ok ? 0 : 1);
