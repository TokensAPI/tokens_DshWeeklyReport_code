import test from 'node:test';
import assert from 'node:assert/strict';
import { isAiHolding, createHoldGate } from '../src/ai-hold.mjs';

// The document only carries suggestion marks (old + new content at once) once a model call has
// started. `closed` and the `user-input` prompt box are both clean states.
test('hold covers every state where the document can carry suggestion marks', () => {
  assert.equal(isAiHolding('closed'), false);
  assert.equal(isAiHolding(undefined), false);
  assert.equal(isAiHolding({ blockId: 'b', status: 'user-input' }), false);
  for (const status of ['thinking', 'ai-writing', 'user-reviewing', 'error']) {
    assert.equal(isAiHolding({ blockId: 'b', status }), true, status);
  }
});

const writing = s => ({ blockId: 'b', status: s });

test('AI writing is held and settles with exactly one final flush', () => {
  const flushes = [];
  const gate = createHoldGate(f => flushes.push(f));

  // Typing before any AI run bubbles straight through.
  assert.equal(gate.onChange(), true);
  assert.deepEqual(flushes, [false]);

  gate.onAiState(writing('thinking'));
  // The executor applies each operation separately, so a real run fires hundreds of these.
  for (let i = 0; i < 200; i++) assert.equal(gate.onChange(), false);
  gate.onAiState(writing('ai-writing'));
  for (let i = 0; i < 200; i++) assert.equal(gate.onChange(), false);
  gate.onAiState(writing('user-reviewing'));
  assert.equal(gate.onChange(), false);
  // Nothing was serialized across the whole run.
  assert.deepEqual(flushes, [false]);
  assert.equal(gate.pending, true);

  // accept/reject -> closeAIMenu: settle once, and only once.
  gate.onAiState('closed');
  assert.deepEqual(flushes, [false, true]);
  assert.equal(gate.pending, false);

  // Repeated `closed` states must not flush again.
  gate.onAiState('closed');
  assert.deepEqual(flushes, [false, true]);
});

test('an AI run that changed nothing does not force a settle flush', () => {
  const flushes = [];
  const gate = createHoldGate(f => flushes.push(f));
  gate.onAiState(writing('thinking'));
  gate.onAiState(writing('user-reviewing'));
  gate.onAiState('closed');
  assert.deepEqual(flushes, []);
});

test('a failed AI run still settles, so leftover marks cannot strand the document', () => {
  const flushes = [];
  const gate = createHoldGate(f => flushes.push(f));
  gate.onAiState(writing('ai-writing'));
  gate.onChange();
  gate.onAiState(writing('error'));
  assert.equal(gate.onChange(), false); // still held while the error is on screen
  assert.deepEqual(flushes, []);
  gate.onAiState('closed');
  assert.deepEqual(flushes, [true]);
});

test('edits after the settle bubble normally again', () => {
  const flushes = [];
  const gate = createHoldGate(f => flushes.push(f));
  gate.onAiState(writing('ai-writing'));
  gate.onChange();
  gate.onAiState('closed');
  assert.deepEqual(flushes, [true]);
  assert.equal(gate.onChange(), true);
  assert.deepEqual(flushes, [true, false]);
});
