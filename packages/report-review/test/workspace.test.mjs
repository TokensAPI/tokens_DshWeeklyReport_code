import { fileURLToPath as testFilePath } from 'node:url';
process.chdir(testFilePath(new URL('../', import.meta.url)));
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

test('workspace: host themes, responsive layout, save conflicts and explicit publication', async () => {
  const bundled = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {Workspace} from './src/client.jsx'; function App(){const [open,setOpen]=React.useState(true); return <><button onClick={()=>setOpen(true)}>打开工作台</button>{open && <Workspace sessionId="test" close={()=>setOpen(false)}/>}</>};createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const requests = [];
  let conflict = false;
  let draft = { reportId: 'r1', title: '锡 · 周度研究 / 2026.09.08', status: 'draft', saveToken: 's1', markdown: '# 锡周度研究\n\n## 核心判断\n库存变化仍需结合供需结构核对。\n\n## 下周跟踪\n关注库存与价格变化。', annotations: [] };
  await page.route('http://workspace.test/**', async route => {
    const url = route.request().url();
    if (url.endsWith('/api/run19/review')) {
      const data = route.request().postDataJSON(); requests.push(data);
      if (data.action === 'save' && conflict) return route.fulfill({ status: 409, json: { ok: false, error: { code: 'SAVE_CONFLICT', message: '版本冲突' } } });
      const result = {
        list: () => ({ reports: [draft] }), identity: () => ({ confirmed: true, displayName: '测试研究员' }), templateList: () => ({ templates: [] }),
        get: () => draft, preview: () => ({ status: 'pending', saveToken: draft.saveToken }),
        timeline: () => ({ versions: [] }),
        save: () => (draft = { ...draft, markdown: data.markdown, saveToken: draft.saveToken + 's' }),
        confirm: () => (draft = { ...draft, status: 'confirmed', saveToken: 'confirmed' }),
        versions: () => ({ versions: [{ versionId: 'v1', title: draft.title, markdown: draft.markdown }] }),
        publishPlan: () => ({ versionId: 'v1', planId: 'plan1', digest: 'digest1', publishToken: 'one-shot' }),
        publish: () => ({ phase: 'submitted' }), publicationStatus: () => ({ records: [] }), reconcile: () => ({ records: [] }),
        startRevision: () => (draft = { ...draft, status: 'draft', saveToken: 'revision' })
      }[data.action];
      assert.ok(result, `Unexpected action ${data.action}`);
      return route.fulfill({ json: { ok: true, value: result() } });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><meta charset="utf-8"><body><div id="root"></div></body></html>' });
  });
  try {
    await page.goto('http://workspace.test/');
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    await page.getByRole('button', { name: /锡 · 周度研究/ }).click();
    await expect(page.locator('.cm-content')).toContainText('库存变化');
    const editorNode = await page.locator('.cm-editor').elementHandle();
    // Use the real reference palettes when supplied; CI uses a minimal semantic host.
    if (process.env.TOKENSAPI_THEME_ROOT) {
      for (const file of ['theme-contract.css', 'themes/clean.css', 'themes/glass.css', 'themes/aurora.css', 'themes/electrox.css']) {
        await page.addStyleTag({ content: await readFile(join(process.env.TOKENSAPI_THEME_ROOT, file), 'utf8') });
      }
    } else {
      await page.addStyleTag({ content: '[data-color-scheme="light"]{color-scheme:light;--theme-bg-surface:#fffefa;--theme-fg-primary:#26352f;--theme-accent-primary:#285548}[data-color-scheme="dark"]{color-scheme:dark;--theme-bg-surface:#222b26;--theme-fg-primary:#edf2ee;--theme-accent-primary:#8ed1ac}' });
    }
    await mkdir('test-results', { recursive: true });
    for (const theme of ['clean', 'glass', 'aurora', 'electrox']) {
      const colors = [];
      for (const scheme of ['light', 'dark']) {
        await page.evaluate(({theme,scheme}) => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.colorScheme = scheme; }, {theme,scheme});
        const actual = await page.locator('.cm-editor').evaluate(el => {
          const probe = document.createElement('span'); probe.style.color = 'var(--theme-fg-primary)'; el.append(probe);
          const result = { editor: getComputedStyle(el).color, host: getComputedStyle(probe).color, scheme: getComputedStyle(el).colorScheme };
          probe.remove(); return result;
        });
        assert.equal(actual.editor, actual.host, `${theme}/${scheme} must inherit host foreground`);
        assert.equal(actual.scheme, scheme);
        colors.push(actual.editor);
        assert.ok(await editorNode.evaluate(el => el.isConnected), 'Theme switching must not recreate the editor');
        if (theme === 'clean') await page.screenshot({ path: `test-results/workspace-${scheme}.png` });
      }
      // Some host themes intentionally have a single palette; clean supports both.
      if (theme === 'clean') assert.notEqual(colors[0], colors[1]);
    }
    for (const width of [1440, 900, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.locator('.rr-workspace').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      assert.ok(await page.locator('.rr-main').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      if (width === 390) await page.screenshot({ path: 'test-results/workspace-mobile.png' });
    }
    await page.getByRole('button', { name: '1 生成与分析', exact:true }).click();
    assert.ok(await page.locator('.rr-main').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Expanded generation settings fit narrow screens');
    await page.getByRole('button', { name: '2 正文编辑', exact:true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'PDF 实时浏览', exact: true }).click();
    await expect(page.locator('.rr-sidebar')).toBeHidden();
    await expect(page.getByLabel('报告版式')).toContainText('尚无可用实际 PDF');
    await page.getByRole('button', { name: '正文编辑', exact: true }).click();
    await page.getByRole('button', {name:'退出专注', exact:true}).click();
    assert.ok(await editorNode.evaluate(el => el.isConnected), 'View switching preserves editor history');
    await page.evaluate(() => { document.head.querySelectorAll('style').forEach(el => el.remove()); delete document.documentElement.dataset.theme; delete document.documentElement.dataset.colorScheme; });
    const fallbackColors = [];
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      fallbackColors.push(await page.locator('.cm-editor').evaluate(el => getComputedStyle(el).color));
    }
    assert.notEqual(...fallbackColors, 'Without a host provider, follow OS appearance');
    await page.addStyleTag({content: ':root { --theme-bg-canvas:rgba(240,242,240,.2); --theme-bg-shell:rgba(230,235,230,.3); --theme-bg-surface:rgba(250,252,250,.4); --theme-bg-surface-raised:rgba(220,230,220,.5) }'});
    for (const selector of ['.rr-workspace', '.rr-sidebar', '.rr-source-pane', '.rr-pane-heading']) {
      const opaque = await page.locator(selector).first().evaluate(el => {
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
        ctx.fillStyle = getComputedStyle(el).backgroundColor; ctx.fillRect(0,0,1,1);
        return ctx.getImageData(0,0,1,1).data[3] === 255;
      });
      assert.ok(opaque, `${selector} must stay opaque with translucent host tokens`);
    }
    await page.getByRole('button', {name:'专注正文', exact:true}).click();
    await expect(page.locator('.rr-sidebar')).toBeHidden();
    await page.getByRole('button', {name:'退出专注', exact:true}).click();
    conflict = true;
    await page.locator('.cm-content').fill('# 人工修订\n\n本地内容必须保留');
    await expect(page.getByRole('alert')).toContainText('SAVE_CONFLICT');
    await expect(page.locator('.cm-content')).toContainText('本地内容必须保留');
    await expect(page.getByRole('button', {name:'仅确认版本', exact:true})).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', {name:'返回编辑'})).toBeVisible();
    await page.getByRole('button', {name:'返回编辑'}).click();
    conflict = false;
    await page.getByRole('button', {name:'保存 / 重试'}).click();
    await expect(page.getByRole('button', {name:'仅确认版本', exact:true})).toBeEnabled();
    assert.equal(requests.find(r => r.action === 'save').saveToken, 's1');
    await page.getByRole('button', {name:'版本历史与差异', exact:true}).click();
    await expect(page.getByRole('button', {name:'关闭详情', exact:true})).toBeEnabled();
    assert.ok(await editorNode.evaluate(el => el.isConnected), 'Read-only busy state preserves the editor and undo history');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+z');
    await expect(page.locator('.cm-content')).toContainText('库存变化');
    await page.keyboard.press('Control+y');
    await expect(page.locator('.cm-content')).toContainText('本地内容必须保留');
    await expect(page.getByRole('button', {name:'仅确认版本', exact:true})).toBeEnabled();
    await page.getByRole('button', {name:'仅确认版本', exact:true}).click();
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    assert.equal(requests.filter(r => r.action === 'publish').length, 0, 'Freezing must never upload');
    await page.getByRole('button', {name:'查看此版本发布清单'}).click();
    const publish = page.getByRole('button', {name:'发布此确认版至 WeKnora'});
    await expect(publish).toBeVisible();
    await publish.evaluate(el => el.click());
    assert.equal(requests.filter(r => r.action === 'publish').length, 0, 'Untrusted events cannot publish');
    await publish.click();
    await expect(page.getByRole('heading', {name:'发布回执'})).toBeVisible();
    assert.equal(requests.filter(r => r.action === 'publish').length, 1);
    await page.getByRole('button', {name:'只读核对', exact:true}).click();
    assert.equal(requests.filter(r => r.action === 'publish').length, 1, 'Reconciliation cannot upload again');
    await page.getByRole('button', {name:'开启新一轮修订'}).click();
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
    const marker = requests.length;
    await page.getByRole('button', {name:'确认发布', exact:true}).click();
    await page.getByRole('button', {name:'确认发布并上传', exact:true}).click();
    await expect(page.getByRole('button', {name:'开启新一轮修订'})).toBeEnabled();
    const chain = requests.slice(marker).filter(r=>['confirm','versions','publishPlan','publish','reconcile','get'].includes(r.action));
    assert.deepEqual(chain.slice(0,6).map(r=>r.action), ['confirm','versions','publishPlan','publish','reconcile','get'], 'Restore the exact baseline publication sequence');
    assert.equal(chain.find(r=>r.action==='publish').saveToken, 'revision');
    await page.getByRole('button', {name:'关闭', exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
