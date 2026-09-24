import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// End-to-end guard for the failure that took the visual editor down mid-AI-edit: the AI rewrites
// a price table, and because suggest-changes keeps the replaced rows in the document (marked
// deleted) alongside the new ones, every intermediate transaction used to be serialized. A
// half-rewritten table has no consistent column grid, so `saveBlockMarkdown` either bubbled
// invalid Markdown (which autosave then persisted) or threw, which flipped the editor into its
// permanent "cannot edit visually" fallback.
//
// This drives the real path: a mocked host NDJSON stream -> createNativeChat -> the xl-ai
// executor -> the live BlockNote document.

const TABLE = `# 锡周报

## 价格变化

| 项目 | 上周 | 本周 |
| --- | --- | --- |
| 沪锡收盘价 | 待填 | 待填 |
| LME 锡 | 待填 | 待填 |

结语。
`;

// The host sends flat block-end records (see native-chat.test.mjs); the nested `block` shape in
// ai-agent-loop.test.mjs is the host's *internal* llm.stream shape and is not what arrives here.
function hostStreamLines(operations) {
  const args = JSON.stringify({ operations });
  return [
    { t: 'chunk', chunk: { type: 'block-start', blockType: 'tool-call', blockId: 'c1', blockName: 'applyDocumentOperations' } },
    ...Array.from({ length: Math.ceil(args.length / 64) }, (_, i) => ({
      t: 'chunk',
      chunk: { type: 'tool-call-delta', id: 'c1', argumentsDelta: args.slice(i * 64, (i + 1) * 64) },
    })),
    { t: 'chunk', chunk: { type: 'block-end', blockType: 'tool-call', blockId: 'c1', blockName: 'applyDocumentOperations' } },
    { t: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } },
    { t: 'done' },
  ];
}

const isBadTable = md => {
  const rows = md.split('\n').filter(l => l.trim().startsWith('|'));
  if (!rows.length) return false;
  const widths = new Set(rows.map(r => r.split('|').length));
  return widths.size > 1 || md.includes('​') || md.includes('RRCustomMarkdownBlock');
};

test('AI rewriting a table never serializes a mid-flight document', async () => {
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {BlockEditor} from './src/block-editor.jsx';import css from './src/workspace.css';
        window.changes=[];window.initial=${JSON.stringify(TABLE)};
        function App(){const [text,setText]=React.useState(window.initial);return <dialog open className="rr-workspace"><style>{css}</style><section className="rr-canvas"><BlockEditor value={text} readOnly={false} onSource={()=>{}} sessionId="s1" reportId="r1" onAiBusy={()=>{}} onChange={v=>{window.changes.push(v);setText(v)}}/></section></dialog>}
        createRoot(document.getElementById('root')).render(<App/>);`,
      loader: 'jsx',
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'text' },
  });

  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    // Replace the whole table with the filled-in version: one update operation, which the
    // executor still applies in many delayed steps.
    const filled = '<table><tr><td>项目</td><td>上周</td><td>本周</td></tr><tr><td>沪锡收盘价</td><td>268,500</td><td>271,200</td></tr><tr><td>LME 锡</td><td>33,100</td><td>33,480</td></tr></table>';
    const lines = hostStreamLines([{ type: 'update', id: '$table', block: filled }]);
    await page.route('**/api/run19/ai-stream', route => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    }));
    await page.route(/^(?!.*api\/run19).*$/, r => r.abort());

    await page.setContent('<!doctype html><div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const doc = page.locator('.bn-editor');
    await expect(doc).toContainText('价格变化');
    assert.deepEqual(await page.evaluate(() => window.changes), [], 'opening the report must not save');

    // Drive a real AI edit through the slash menu.
    await doc.locator('td').filter({ hasText: '沪锡收盘价' }).first().click();
    await page.keyboard.type('//');
    await page.keyboard.type('把上周和本周的锡价填进表格');
    await page.keyboard.press('Enter');

    // While the AI writes, nothing may be serialized and the editor must stay alive.
    await expect(page.locator('.rr-editor-fallback')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.changes.length), { timeout: 15000 }).toBe(0);

    // Accept: exactly one settle, and it must be valid Markdown.
    await page.getByRole('button', { name: /接受|Accept/ }).first().click();
    await expect.poll(() => page.evaluate(() => window.changes.length), { timeout: 15000 }).toBe(1);
    const saved = await page.evaluate(() => window.changes.at(-1));
    assert.ok(!isBadTable(saved), `settled Markdown must be a valid table:\n${saved}`);
    assert.ok(saved.includes('271,200'), 'the AI result must survive the settle');
    await expect(page.locator('.rr-editor-fallback')).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
