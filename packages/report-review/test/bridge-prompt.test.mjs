import { createDshLlmModel } from '../src/ai-bridge.mjs';

// Capture the request body the model POSTs to the host.
let captured = null;
const fetchFn = async (path, init) => {
  captured = { path, body: JSON.parse(init.body) };
  const enc = new TextEncoder();
  // Faux host: reply with a text-delta stream then done, so doStream completes.
  const lines = [
    JSON.stringify({ t:'chunk', chunk: { type:'block-start' } }),
    JSON.stringify({ t:'chunk', chunk: { type:'text-delta', text:'hi' } }),
    JSON.stringify({ t:'chunk', chunk: { type:'block-end', block: { type:'text' } } }),
    JSON.stringify({ t:'chunk', chunk: { type:'usage' } }),
    JSON.stringify({ t:'chunk', chunk: { type:'finish', reason:{ kind:'stop' } } }),
    JSON.stringify({ t:'done' }),
  ].join('\n') + '\n';
  return { ok: true, status: 200, body: new ReadableStream({ start(c){ c.enqueue(enc.encode(lines)); c.close(); } }) };
};

const model = createDshLlmModel({ fetchFn, provider: 'tokensapi', model: 'deepseek-v4-flash-vision-exp' });

const tool = { name: 'applyDocumentOperations', description: 'edit', inputSchema: { jsonSchema: { type:'object', properties:{operations:{type:'array'}}, required:['operations'] } } };

// V3 shape: messages under `prompt`, system folded into prompt[0].
const result = await model.doStream({
  prompt: [
    { role: 'system', content: 'You are editing a document. Use applyDocumentOperations.' },
    { role: 'user', content: [{ type: 'text', text: 'Make the selected text more formal.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'This is the document state: {"blocks":[]}' }] },
  ],
  tools: [tool],
  temperature: 0.2,
  maxTokens: 500,
});

// Drain the stream so the fetch path fully executes.
const reader = result.stream.getReader();
while (true) { const {done} = await reader.read(); if (done) break; }

console.log('captured path =', captured?.path);
console.log('captured.system =', JSON.stringify(captured?.body?.system));
console.log('captured.messages =', JSON.stringify(captured?.body?.messages, null, 2));
console.log('captured.tools =', JSON.stringify(captured?.body?.tools));
console.log('captured.messages.length =', captured?.body?.messages?.length);
console.log('captured.tools.length =', captured?.body?.tools?.length);

const msgs = captured?.body?.messages || [];
const ok = msgs.length === 2
  && msgs[0].role === 'user' && msgs[0].content[0].text === 'Make the selected text more formal.'
  && msgs[1].role === 'assistant' && msgs[1].content[0].text.includes('document state')
  && (captured?.body?.system || '').includes('applyDocumentOperations')
  && (captured?.body?.tools?.length === 1);
console.log('PASS?', ok);
process.exit(ok ? 0 : 1);
