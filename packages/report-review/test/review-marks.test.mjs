import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripMarkdownFormatting, extractReviewMarks, diffLines } from '../src/review-marks.mjs';

test('stripMarkdownFormatting removes emphasis but keeps wording', () => {
  assert.equal(
    stripMarkdownFormatting('# 本周价格 **425,770**，_环比 +2.3%_。'),
    '本周价格 425,770，环比 +2.3%。',
  );
  assert.equal(stripMarkdownFormatting('[数据](http://x) 与 ![图](asset:a) 内容'), '数据 与 图 内容');
  assert.equal(stripMarkdownFormatting('- 第一点\n- 第二点'), '第一点\n第二点');
  assert.equal(stripMarkdownFormatting('> 引用句'), '引用句');
  assert.equal(stripMarkdownFormatting('`code` 与 ~~删除~~'), 'code 与 删除');
});

test('formatting-only changes are formatOnly, not substantive', () => {
  const marks = extractReviewMarks(
    '# 标题\n\n价格 **425,770**，库存 _416,898_。',
    '## 标题\n\n价格425,770，库存416,898。',
  );
  assert.equal(marks.formatOnly, true);
  assert.equal(marks.substantive, false);
  assert.deepEqual(marks.edits, []);
});

test('re-wrapping in emphasis only is formatOnly', () => {
  const marks = extractReviewMarks('库存 416,898。', '**库存 416,898。**');
  assert.equal(marks.formatOnly, true);
  assert.equal(marks.substantive, false);
});

test('a wording/number change is substantive', () => {
  const marks = extractReviewMarks('库存 416,898。', '库存 416,900。');
  assert.equal(marks.formatOnly, false);
  assert.equal(marks.substantive, true);
  const texts = marks.edits.map(e => e.text);
  assert.ok(texts.some(t => t.includes('416,898') || t.includes('416,900')));
});

test('an added human sentence is surfaced as an edit', () => {
  const marks = extractReviewMarks(
    '本周多空：偏多。',
    '本周多空：偏多。\n\n风险提示：警惕进口到港冲击。',
  );
  assert.equal(marks.substantive, true);
  assert.ok(marks.edits.some(e => e.op === 'add' && /警惕进口到港冲击/.test(e.text)));
});

test('link/whitespace-only normalization is formatOnly', () => {
  const marks = extractReviewMarks('[数据](http://x) 价格', '数据    价格');
  assert.equal(marks.formatOnly, true);
});

test('diffLines reports add/del/same correctly', () => {
  const out = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);
  assert.ok(out.some(d => d.op === 'del' && d.before === 'b'));
  assert.ok(out.some(d => d.op === 'add' && d.after === 'x'));
  assert.ok(out.some(d => d.op === 'same'));
});
