import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAiError } from '../src/ai-error.mjs';

// The regression this guards: an AI edit failed, the console showed an object, and the object
// serialized to `{aborted, chunk, name}` because Error#message and #cause are non-enumerable.
// Three debugging rounds were spent guessing at a reason that the code already had in hand.

test('the reason survives JSON-invisible Error fields', () => {
  const err = new Error('Block not found (update)');
  err.name = 'ChunkExecutionError';
  err.chunk = { operation: { type: 'update' } };
  err.aborted = false;
  // `name` is an own enumerable property so it survives; `message` is the one that matters and
  // it does not. This is exactly the shape that kept arriving from the field.
  const serialized = JSON.parse(JSON.stringify(err));
  assert.deepEqual(Object.keys(serialized).sort(), ['aborted', 'chunk', 'name']);
  assert.equal(serialized.message, undefined);
  assert.equal(describeAiError(err), 'Block not found (update)');
});

test('executor results arrive wrapped as {ok:false,error}', () => {
  assert.equal(describeAiError({ ok: false, error: new Error('block must be a string') }), 'block must be a string');
  assert.equal(describeAiError({ ok: false, error: 'id is required' }), 'id is required');
});

test('a cause chain is unwrapped, and a detail cause is rendered as fields', () => {
  const inner = new Error('Invalid table content');
  const outer = new Error('Chunk failed', { cause: inner });
  assert.equal(describeAiError(outer), 'Chunk failed ← Invalid table content');

  // `Block not found (update)` puts a plain detail object on `cause`.
  const withDetail = new Error('Block not found (update)', { cause: { blockId: 'abc-123' } });
  assert.equal(describeAiError(withDetail), 'Block not found (update) ← blockId=abc-123');
});

test('repeated and empty messages do not produce noise', () => {
  const dup = new Error('same', { cause: new Error('same') });
  assert.equal(describeAiError(dup), 'same');
  assert.equal(describeAiError(undefined), '未知错误');
  assert.equal(describeAiError({}), '未知错误');
});
