import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from 'prosemirror-model';

// Why this test exists: every attempt to have the AI fill in a table failed with
//   ChunkExecutionError: unexpected, openEnd > 0 and size > 1, this should have been split ...
// thrown by changeset.ts. The granular splitter there can only peel one level of nesting (it
// requires `openStart === 0`, which stops holding once a level is peeled), while a table is
// table > row > cell > paragraph. The fix replaces such a block in one whole-node step.
//
// Both halves of that reasoning are pure prosemirror-model behaviour, so they can be pinned
// down here without a browser — unlike the editor itself.

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    table: { group: 'block', content: 'row+' },
    row: { content: 'cell+' },
    cell: { content: 'paragraph+' },
    text: {},
  },
});

const cell = text => schema.nodes.cell.create(null, schema.nodes.paragraph.create(null, schema.text(text)));
const row = (...texts) => schema.nodes.row.create(null, texts.map(cell));
const doc = schema.nodes.doc.create(null, [
  schema.nodes.paragraph.create(null, schema.text('前言')),
  schema.nodes.table.create(null, [row('指标', '本期'), row('参考价格', '271,500')]),
  schema.nodes.paragraph.create(null, schema.text('结语')),
]);

const tablePos = (() => {
  let found = -1;
  doc.forEach((node, offset) => { if (node.type.name === 'table' && found < 0) found = offset; });
  return found;
})();

test('a slice ending inside a table is open several levels deep', () => {
  const table = doc.nodeAt(tablePos);
  // Anywhere short of the table's closing token leaves row/cell/paragraph hanging open.
  const partial = doc.slice(tablePos, tablePos + table.nodeSize - 2);
  assert.ok(partial.openEnd > 1, `expected a deeply open slice, got openEnd=${partial.openEnd}`);
  assert.ok(partial.size > 1);
  // This is exactly the shape changeset.ts used to throw on, and the shape its splitter cannot
  // express: peeling the first level leaves openStart > 0, so the `openStart === 0` branch that
  // does the splitting never fires again.
});

test('a whole-node slice is closed at both ends, which is what the fallback relies on', () => {
  const table = doc.nodeAt(tablePos);
  const whole = doc.slice(tablePos, tablePos + table.nodeSize);
  assert.equal(whole.openStart, 0);
  assert.equal(whole.openEnd, 0);
  assert.equal(whole.content.childCount, 1);
  assert.equal(whole.content.firstChild.type.name, 'table');
  // agent.ts rejects any non-structure step whose slice has openStart/openEnd > 0; a whole-node
  // slice satisfies that contract, so the replacement travels the normal pipeline.
});

test('the whole-node slice really does carry the updated content', () => {
  const updated = doc.replace(
    tablePos,
    tablePos + doc.nodeAt(tablePos).nodeSize,
    doc.slice(tablePos, tablePos + doc.nodeAt(tablePos).nodeSize),
  );
  const table = updated.nodeAt(tablePos);
  assert.equal(table.type.name, 'table');
  assert.match(table.textContent, /271,500/);
});
