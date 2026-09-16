import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('shipping plugin factory routes visual and preview modes to their editors using DSH React 18 modules', async () => {
  const bootstrap = await build({ stdin: { contents: `
    import React from 'react';
    import * as jsx from 'react/jsx-runtime';
    import * as dom from 'react-dom';
    import * as client from 'react-dom/client';
    import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
    const modules = {react:React,'react/jsx-runtime':jsx,'react-dom':dom,'react-dom/client':client,'@deepseek-ai/dsh-client-ui-primitives':{Button,Tooltip}};
    window.hostVersion=React.version;
    window.__ModuleLoader__={load(registration){
      window.imported=[];
      const plugin=registration.factory(id=>{window.imported.push(id);if(!modules[id])throw Error('Unknown host module: '+id);return modules[id];});
      client.createRoot(document.getElementById('root')).render(React.createElement(plugin.Workspace,{initialMode:'demo',close(){}}));
    }};
  `, resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), loader: 'jsx' },
    bundle: true, write: false, format: 'iife', outdir: 'test-results/host-runtime', loader: { '.css': 'local-css', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } });
  const plugin = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://host-runtime.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
  try {
    await page.goto('http://host-runtime.test/');
    for (const file of bootstrap.outputFiles) {
      if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text });
      else await page.addScriptTag({ content: file.text });
    }
    assert.equal(await page.evaluate(() => window.hostVersion), '18.3.1');
    await page.addScriptTag({ content: plugin });
    await expect(page.getByRole('dialog', { name: '周报审阅工作台' })).toBeVisible();
    await page.getByRole('button', { name: '生成演示周报', exact: true }).click();
    await expect(page.locator('.bn-editor')).toBeVisible();
    const paragraph = page.locator('.bn-block-content[data-content-type="paragraph"]').first();
    await paragraph.click(); await page.keyboard.press('End');
    await page.keyboard.insertText('宿主兼容性验证。');
    await expect(paragraph).toContainText('宿主兼容性验证。');
    await page.keyboard.press('Enter'); await page.keyboard.type('/');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('选择编辑器')).toHaveCount(0);
    await page.getByRole('button', { name: 'PDF 实时浏览', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('宿主兼容性验证。');
    await expect(page.locator('.bn-editor')).toHaveCount(0);
    await page.getByRole('button', { name: 'Markdown 实时浏览', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('宿主兼容性验证。');
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n\n源码回写验证。');
    await page.getByRole('button', { name: '可视化编辑', exact: true }).click();
    await expect(page.locator('.bn-editor')).toContainText('源码回写验证。');
    await expect(page.locator('.bn-editor')).toContainText('宿主兼容性验证。');
    await expect(page.getByRole('button', {name:'保存 / 重试'})).toBeDisabled();
    assert.ok((await page.evaluate(() => window.imported)).includes('react-dom/client'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
