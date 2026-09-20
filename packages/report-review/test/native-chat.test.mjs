// Native LLM chat test: createNativeChat must drive the DSH host stream and emit a
// SINGLE `tool-applyDocumentOperations` part at state `input-available` (that is what
// the xl-ai StreamToolExecutor consumes). No AI SDK involved in the call path.
import { createNativeChat } from '../src/ai-bridge.mjs';

function makeHostStream(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const line of lines) ctrl.enqueue(encoder.encode(line + '\n'));
      ctrl.close();
    },
  });
}

async function main() {
  const args = JSON.stringify({ operations: [{ type: 'add', referenceId: 'b1', position: 'after', blocks: ['<p>joke</p>'] }] });

  // Host emits the REAL flat block-end shape (blockType/blockName/blockId, NO block object, NO arguments).
  const hostLines = [
    JSON.stringify({ t: 'chunk', chunk: { type: 'block-start' } }),
    JSON.stringify({ t: 'chunk', chunk: { type: 'text-delta', text: 'Let me add that.' } }),
    JSON.stringify({ t: 'chunk', chunk: { type: 'tool-call-delta', id: 'chatcmpl-tool-87bf362d92375a7a', name: 'applyDocumentOperations', argumentsDelta: args } }),
    JSON.stringify({ t: 'chunk', chunk: { type: 'block-end', blockType: 'tool-call', blockName: 'applyDocumentOperations', blockId: 'chatcmpl-tool-87bf362d92375a7a' } }),
    JSON.stringify({ t: 'chunk', chunk: { type: 'finish', reason: { kind: 'tool-calls' } } }),
    JSON.stringify({ t: 'done' }),
  ];

  const fetchFn = async () => new Response(makeHostStream(hostLines), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });

  const chat = createNativeChat({ fetchFn });

  // Simulate sendMessageWithAIRequest: it sets metadata.documentState, then calls sendMessage with toolDefinitions in body.
  const userMsg = { role: 'user', id: 'm-user-1', parts: [{ type: 'text', text: 'write a joke' }], metadata: { documentState: { selection: null, blocks: [{ id: 'b1', type: 'paragraph' }], isEmptyDocument: false } } };

  const toolDefinitions = {
    applyDocumentOperations: { description: 'Apply operations.', inputSchema: { type: 'object', properties: { operations: { type: 'array' } }, required: ['operations'] } },
  };

  // Register the same callbacks setupToolCallStreaming uses, so we can capture behavior.
  let msgCbCalls = 0;
  let statusCbCalls = 0;
  chat['~registerMessagesCallback'](() => { msgCbCalls++; });
  chat['~registerStatusCallback'](() => { statusCbCalls++; });

  await chat.sendMessage(userMsg, { body: { toolDefinitions } });

  const parts = chat.lastMessage?.parts ?? [];
  const toolParts = parts.filter((p) => p.type === 'tool-applyDocumentOperations');

  console.log('status =', chat.status);
  console.log('lastMessage.parts =', JSON.stringify(parts));
  console.log('tool parts count =', toolParts.length);
  for (const t of toolParts) console.log('  tool part:', t.state, 'inputDefined=', t.input !== undefined, 'inputType=', typeof t.input, 'toolCallId=', t.toolCallId);

  const ok =
    chat.status === 'ready' &&
    toolParts.length === 1 &&
    toolParts[0].state === 'input-available' &&
    typeof toolParts[0].input === 'object' &&
    Array.isArray(toolParts[0].input.operations) &&
    toolParts[0].input.operations.length === 1 &&
    msgCbCalls > 0 &&
    statusCbCalls > 0;

  console.log('msgCbCalls =', msgCbCalls, 'statusCbCalls =', statusCbCalls);
  console.log('PASS?', ok);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
