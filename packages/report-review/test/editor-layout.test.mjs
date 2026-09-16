import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

for (const variant of [{name:'desktop',width:1440,scheme:'light'},{name:'narrow-dark',width:700,scheme:'dark'}]) test(`visual document scrolling, link form and stable slash menu: ${variant.name}`, async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {BlockEditor} from './src/block-editor.jsx';import css from './src/workspace.css';
    function App(){const [text,setText]=React.useState(Array.from({length:80},(_,i)=>'第 '+i+' 段，核实数据口径与来源。').join('\\n\\n'));const [status,setStatus]=React.useState('已保存');const dialog=React.useRef();React.useEffect(()=>{dialog.current.showModal()},[]);return <dialog ref={dialog} className="rr-workspace"><style>{css}</style><header className="rr-header">周报编辑 · {status}</header><div className="rr-layout"><aside/><main className="rr-main"><div className="rr-report-header"><h1>长文编辑测试</h1></div><section className="rr-editor-stage"><div className="rr-document-panes" data-view="editor"><div className="rr-source-pane"><div className="rr-pane-heading">文档</div><section className="rr-canvas"><BlockEditor value={text} readOnly={false} onSource={()=>{}} onChange={v=>{setText(v);setStatus('保存中');setTimeout(()=>setStatus('已保存'),250)}} /></section></div></div></section></main><aside/></div></dialog>};createRoot(document.getElementById('root')).render(<App/>);
  `, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx' }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: variant.width, height: 900 }, colorScheme: variant.scheme });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.setContent('<!doctype html><div id="root"></div>'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const scroller = page.locator('.rr-block-editor');
    await expect(page.locator('.bn-editor')).toContainText('第 79 段');
    await scroller.hover(); await page.mouse.wheel(0, 650);
    await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(300);
    await scroller.evaluate(el => { el.scrollTop = 0; });
    const paragraph = page.locator('.bn-block-content[data-content-type="paragraph"]').first();
    await paragraph.click(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
    await page.locator('[data-test="createLink"]').click();
    const form = page.locator('.bn-form-popover'); await expect(form).toBeVisible();
    const input = form.locator('input').first(); await input.fill('https://example.com/report');
    await expect.poll(() => form.evaluate(el => {let opacity=1;for(let n=el;n;n=n.parentElement)opacity*=Number(getComputedStyle(n).opacity);return opacity;})).toBe(1);
    assert.ok(await input.evaluate(el => { const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit === el || el.contains(hit); }), 'link form is not clipped or covered');
    assert.ok(await form.evaluate(el => {const r=el.getBoundingClientRect();return r.width > 200 && r.height >= 28 && r.bottom < innerHeight;}));
    await page.screenshot({ path: fileURLToPath(new URL(`../test-results/editor-link-form-${variant.name}.png`, import.meta.url)) });
    await input.press('Enter');
    await expect(paragraph.locator('a')).toHaveAttribute('href', 'https://example.com/report');
    await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('/');
    const menu=page.getByRole('listbox'); await expect(menu).toBeVisible();
    const positions=await menu.evaluate(async el => {
      const out=[];const until=performance.now()+900;
      while(performance.now()<until){await new Promise(requestAnimationFrame);const r=el.getBoundingClientRect();out.push({x:r.x,y:r.y});}return out;
    });
    const xs=positions.map(p=>p.x),ys=positions.map(p=>p.y);
    assert.ok(Math.max(...xs)-Math.min(...xs)<8 && Math.max(...ys)-Math.min(...ys)<8, JSON.stringify(positions));
    const caret=await page.evaluate(()=>{const r=getSelection().getRangeAt(0).getBoundingClientRect();return {x:r.x,y:r.y};});
    assert.ok(Math.abs(positions.at(-1).x-caret.x)<40, 'slash menu stays aligned to caret');
    await scroller.evaluate(el => { el.scrollTop = 60; });
    await expect.poll(async () => (await menu.boundingBox()).y).toBeLessThan(positions.at(-1).y-40);
    await page.keyboard.press('Escape');
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => scroller.evaluate(el => el.scrollHeight-el.clientHeight-el.scrollTop)).toBeLessThan(2);
    await expect(page.getByText('第 79 段，核实数据口径与来源。', {exact:true})).toBeInViewport();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
