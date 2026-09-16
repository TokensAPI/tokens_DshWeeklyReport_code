import { fileURLToPath as testFilePath } from 'node:url';
process.chdir(testFilePath(new URL('../', import.meta.url)));
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);

test('native footer: vertical layout, collapsed icon and shell-owned workspace', async () => {
  const result = await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {Button} from '@deepseek-ai/dsh-client-ui-primitives';
      import {apply} from './src/entry.jsx';
      const slots = [];
      apply({slots:{inject:(_,fn)=>fn(),register:(options,Component)=>slots.push({options,Component})},get:()=>null});
      const roots = Object.fromEntries(slots.map(({options})=>[options.name,createRoot(document.getElementById(options.name))]));
      window.renderEntries = wide => slots.forEach(({options,Component})=>roots[options.name].render(<>
        {options.name==='sidebar.footer.action' && <Button className="market" variant="ghost" icon={<svg width="16" height="16"/>}>插件市场</Button>}
        <Component {...options.inject()} wide={wide}/>
      </>));
      window.renderEntries(true);
    `, loader:'jsx', resolveDir:process.cwd() },
    bundle:true, write:false, format:'iife', outdir:'test-results/entry',
    alias:{react:dirname(require.resolve('react/package.json')), 'react-dom':dirname(require.resolve('react-dom/package.json'))},
    loader:{'.css':'local-css','.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'},
    plugins:[{name:'workspace-css-text',setup(b){b.onLoad({filter:/workspace\.css$/},async args=>({contents:await readFile(args.path,'utf8'),loader:'text'}));}}],
  });
  const browser = await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
  const page = await browser.newPage({viewport:{width:1200,height:800}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  try {
    // Reproduce the host's horizontal footer with its default display:contents slot.
    await page.setContent(`<style>.footer{display:flex;width:248px}.market{flex:none;box-sizing:border-box;width:calc(100% + 4px);margin:4px -2px;padding:0 10px 0 8px;gap:8px;justify-content:flex-start;height:42px;white-space:nowrap}[data-slot]{display:contents}</style>
      <div id="conversation.session.header.actions"></div><div class="footer"><div data-slot="sidebar.footer.action" id="sidebar.footer.action"></div></div><div id="shell.overlay"></div>`);
    for(const f of result.outputFiles) if(f.path.endsWith('.css')) await page.addStyleTag({content:f.text});
    await page.addStyleTag({content:await page.locator('style').first().textContent()});
    await page.addScriptTag({content:result.outputFiles.find(f=>f.path.endsWith('.js')).text});
    const entry=page.getByRole('button',{name:'周报工作台',exact:true});
    await expect(entry).toBeVisible();
    const market=await page.getByRole('button',{name:'插件市场'}).boundingBox();
    const box=await entry.boundingBox();
    assert.ok(box.y>=market.y+market.height,'entries must stack vertically');
    assert.equal(box.width,252); assert.equal(box.height,42);
    const icon=await entry.locator('svg').boundingBox();
    const marketIcon=await page.locator('.market svg').boundingBox();
    assert.equal(icon.x,marketIcon.x,'icon boxes must share the same left edge');
    assert.equal(icon.width,marketIcon.width,'icon boxes must have the same width');
    assert.equal(await entry.evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    await entry.click();
    await expect(page.locator('[id="shell.overlay"] dialog')).toBeVisible();
    await expect(page.locator('[data-slot] dialog')).toHaveCount(0);
    await expect(entry).toHaveAttribute('aria-expanded','true');
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.evaluate(()=>window.renderEntries(false));
    await expect(entry).toHaveAttribute('data-wide','false');
    const collapsed=await entry.boundingBox(); assert.equal(collapsed.width,36); assert.equal(collapsed.height,36);
    await expect(entry).toHaveText('');
    await entry.click(); await expect(page.locator('dialog')).toHaveCount(1);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
