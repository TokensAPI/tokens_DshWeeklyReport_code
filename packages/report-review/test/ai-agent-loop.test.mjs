import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportStore } from '../../report-core/src/index.mjs';
import { createReviewHost } from '../src/index.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The AI edit path is an agent loop: the model may call host system tools for several
// turns before issuing applyDocumentOperations. The host executes those calls in-process
// and feeds the results back. These tests pin the wire contracts that loop depends on,
// each of which was silently violated at some point: the DSH Message shape (there is no
// 'tool' role), toolRuntime.execute resolving rather than throwing on tool failure, and
// never leaving a tool-call block without a matching tool-result.

const textChunk = text => ({ type: 'text-delta', text });
const callChunk = (id, name, args) => ({ type: 'block-end', block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } });
const finish = () => ({ type: 'finish', reason: { kind: 'stop' } });

// Build a host whose llm replays one scripted chunk list per turn, recording the messages
// it was handed each time, and whose tool runtime is driven by `execute`.
async function setup(t, { turns, execute, schemas = [{ name: 'web_search', description: 'search', parameters: {} }], config = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'run19-agent-loop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = [];
  const llm = {
    async *stream(options) {
      seen.push(options.messages);
      const script = turns[seen.length - 1] ?? [textChunk('NO_EDIT'), finish()];
      for (const chunk of script) yield chunk;
    },
  };
  const executed = [];
  const toolRuntime = {
    schemas: () => schemas,
    async execute(exec) { executed.push(exec); return execute(exec); },
  };
  const api = createReviewHost({
    core: new ReportStore({ rootDir: join(root, 'core') }),
    pdf: { async render() { return { status: 'ready' }; } },
    sessions: { get: () => undefined },
    getLlm: () => llm,
    getTools: () => toolRuntime,
    getDefaultModel: () => ({ currentSelection: () => ({ provider: 'p', model: 'm' }) }),
  }, config);
  t.after(() => api.dispose());
  return { api, seen, executed };
}

// Drive one ai-stream request and split the NDJSON response into its record kinds.
async function run(api, body = {}) {
  const response = await api.fetchAiStream(new Request('http://x/api/run19/ai-stream', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ id: 'm0', role: 'user', content: [{ type: 'text', text: '把上周锡价补进来' }], source: { kind: 'test' } }], tools: [{ name: 'applyDocumentOperations', parameters: {} }], ...body }),
  }));
  const records = (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {
    records,
    chunks: records.filter(r => r.t === 'chunk').map(r => r.chunk),
    activity: records.filter(r => r.t === 'activity'),
    error: records.find(r => r.t === 'error')?.error,
  };
}

test('a system tool call is executed host-side and fed back as a user-role tool-result message', async t => {
  const { api, seen, executed } = await setup(t, {
    turns: [
      [callChunk('c1', 'web_search', { query: '锡价' }), finish()],
      [callChunk('c2', 'applyDocumentOperations', { operations: [] }), finish()],
    ],
    execute: async () => ({ isError: false, value: { hits: 3 }, content: [{ type: 'text', text: '锡价 26 万/吨' }] }),
  });
  const { chunks, activity, error } = await run(api);
  assert.equal(error, undefined);
  assert.deepEqual(executed.map(e => e.name), ['web_search']);
  assert.ok(executed[0].signal, 'execute must receive a cancellation signal');

  // Second turn's messages: original user turn, the assistant tool-call, then the result.
  const followUp = seen[1];
  assert.equal(seen.length, 2);
  const [, assistant, toolResult] = followUp;
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.content, [{ type: 'tool-call', id: 'c1', name: 'web_search', arguments: JSON.stringify({ query: '锡价' }) }]);

  // There is no 'tool' role in the DSH Message vocabulary — a tool result is a user
  // message holding exactly one tool-result block, with an id and a source like any other.
  assert.equal(toolResult.role, 'user');
  assert.equal(toolResult.content.length, 1);
  assert.deepEqual(toolResult.content[0], { type: 'tool-result', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: '锡价 26 万/吨' }] });
  for (const message of followUp) {
    assert.ok(message.id, 'every message needs a stable id');
    assert.ok(message.source, 'every message needs a source');
    assert.ok(['system', 'user', 'assistant'].includes(message.role), `unexpected role ${message.role}`);
  }

  // Only the final turn reaches the client, and the edit is announced on the activity channel.
  assert.deepEqual(chunks.map(c => c.block?.name ?? c.type), ['applyDocumentOperations', 'finish']);
  assert.deepEqual(activity.filter(a => a.kind === 'edit').map(a => a.status), ['applying', 'done']);
});

test('a tool that resolves with isError is reported to the model and the UI as a failure', async t => {
  // toolRuntime.execute RESOLVES with {isError:true,...}; it does not throw. Reading only
  // the catch would hand the model a failed search dressed up as a successful one.
  const { api, seen } = await setup(t, {
    turns: [
      [callChunk('c1', 'web_search', { query: '锡价' }), finish()],
      [textChunk('NO_EDIT'), finish()],
    ],
    execute: async () => ({ isError: true, error: { code: 'NETWORK', message: 'upstream refused' }, content: [{ type: 'text', text: 'upstream refused' }] }),
  });
  const { activity, error } = await run(api);
  assert.equal(error, undefined);
  const block = seen[1].at(-1).content[0];
  assert.equal(block.isError, true, 'the model must see the call as failed');
  assert.deepEqual(block.content, [{ type: 'text', text: 'upstream refused' }]);
  assert.deepEqual(activity.filter(a => a.kind === 'tool').map(a => a.status), ['running', 'error']);
});

test('an edit issued in the same turn as a system tool call is dropped, never orphaned', async t => {
  const { api, seen } = await setup(t, {
    turns: [
      // The model guesses an edit before its search returns; that edit is stale.
      [callChunk('c1', 'web_search', { query: '锡价' }), callChunk('c2', 'applyDocumentOperations', { operations: [] }), finish()],
      [callChunk('c3', 'applyDocumentOperations', { operations: [{ type: 'update' }] }), finish()],
    ],
    execute: async () => ({ isError: false, value: {}, content: [{ type: 'text', text: '锡价 26 万/吨' }] }),
  });
  const { chunks, error } = await run(api);
  assert.equal(error, undefined);
  const assistant = seen[1][1];
  // Every tool-call block in the history must have a matching tool-result; the stale edit
  // has none, so it must not appear at all.
  const callIds = assistant.content.filter(b => b.type === 'tool-call').map(b => b.id);
  const resultIds = seen[1].flatMap(m => m.content.filter(b => b.type === 'tool-result').map(b => b.toolCallId));
  assert.deepEqual(callIds, ['c1']);
  assert.deepEqual(resultIds, ['c1']);
  // The client only ever sees the edit that was made with the search results in hand.
  assert.deepEqual(chunks.filter(c => c.block?.type === 'tool-call').map(c => c.block.id), ['c3']);
});

test('an unknown client tool is never executed host-side', async t => {
  // "not applyDocumentOperations" does not mean "the host can run it".
  const { api, executed } = await setup(t, {
    turns: [[callChunk('c1', 'someClientOnlyTool', {}), finish()]],
    execute: async () => assert.fail('must not execute a tool the host does not own'),
  });
  const { chunks } = await run(api, { tools: [{ name: 'applyDocumentOperations', parameters: {} }, { name: 'someClientOnlyTool', parameters: {} }] });
  assert.deepEqual(executed, []);
  assert.deepEqual(chunks.filter(c => c.block?.type === 'tool-call').map(c => c.block.name), ['someClientOnlyTool']);
});

test('exhausting the tool-turn cap fails loudly instead of replaying unrunnable tool calls', async t => {
  const { api } = await setup(t, {
    turns: Array.from({ length: 4 }, (_, i) => [callChunk(`c${i}`, 'web_search', { query: 'x' }), finish()]),
    execute: async () => ({ isError: false, value: {}, content: [{ type: 'text', text: 'hit' }] }),
    config: { aiMaxToolTurns: 3 },
  });
  const { chunks, error } = await run(api);
  assert.equal(error?.code, 'AI_TOOL_TURNS_EXHAUSTED');
  // Replaying the last gather turn would hand the client a web_search call it cannot run.
  assert.deepEqual(chunks, []);
});

test('without a tools service the loop degrades to a plain single-turn edit', async t => {
  const { api, seen } = await setup(t, {
    turns: [[callChunk('c1', 'applyDocumentOperations', { operations: [] }), finish()]],
    execute: async () => assert.fail('no tool runtime means no host-side execution'),
    schemas: [],
  });
  const { chunks, error } = await run(api);
  assert.equal(error, undefined);
  assert.equal(seen.length, 1);
  assert.deepEqual(chunks.map(c => c.block?.name ?? c.type), ['applyDocumentOperations', 'finish']);
});
