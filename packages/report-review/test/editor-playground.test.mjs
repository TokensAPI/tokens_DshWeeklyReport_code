import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { sampleReport, createDemoApi } from '../src/demo-api.mjs';

test('expanded demo is a new draft and never overwrites existing user edits', async () => {
  const memory = new Map(), storage = {getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v)};
  const api=createDemoApi(storage), old=(await api('list')).reports[0];
  const saved=await api('save',{reportId:old.reportId,saveToken:old.saveToken,markdown:'我的旧演示稿'});
  const fresh=await api('generate',{});
  assert.equal((await api('get',{reportId:old.reportId})).markdown,'我的旧演示稿');
  assert.notEqual(fresh.reportId,saved.reportId);
  for(const token of ['- [x]','- [ ]','```python','###### 六级','![模拟库存','~~已撤回','[^demo]']) assert.ok(fresh.markdown.includes(token),token);
});

test('blocknote: expanded demo blocks edit and serialize, images stay offline', async () => {
  const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BlockEditor} from './src/block-editor.jsx';import {sampleReport} from './src/demo-api.mjs';import css from './src/workspace.css';
    window.changes=[];function App(){const [text,setText]=React.useState(sampleReport()),[ro,setRo]=React.useState(false),[revision,setRevision]=React.useState(0);const E=BlockEditor;return <dialog open className="rr-workspace"><style>{css}</style><button onClick={()=>setRo(v=>!v)}>只读</button><button onClick={()=>setRevision(v=>v+1)}>重新打开</button><section className="rr-canvas"><E key={revision} value={text} readOnly={ro} onSource={()=>{}} onChange={v=>{window.changes.push(v);setText(v)}}/></section></dialog>};createRoot(document.getElementById('root')).render(<App/>);`,loader:'jsx',resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'text'}});
  const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1200,height:900}});const errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{requests.push(r.request().url());return r.abort();});
  try {
    await page.setContent('<!doctype html><div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
    const doc=page.locator('.bn-editor');
    await expect(doc).toContainText('编辑体验区');await expect(doc.locator('h6')).toContainText('六级标题');
    await expect(doc.locator('.rr-preserved-block')).toHaveCount(2);
    assert.deepEqual(await page.evaluate(()=>window.changes),[],'opening the full demo must not save');
    const cell=doc.locator('td').filter({hasText:'268,500'}).first();await cell.click();await page.keyboard.press('End');await page.keyboard.insertText('1');
    await expect.poll(()=>page.evaluate(()=>window.changes.at(-1))).toContain('268,5001');
    const after=await page.evaluate(()=>window.changes.at(-1));const original=sampleReport();
    assert.equal(after.slice(after.indexOf('## 三、')),original.slice(original.indexOf('## 三、')));
    const quote=doc.locator('[data-content-type=quote]').filter({hasText:'模拟访谈'}).first();await quote.click();await page.keyboard.press('End');await page.keyboard.insertText('已核实。');
    await expect.poll(()=>page.evaluate(()=>window.changes.at(-1))).toContain('已核实。');
    const code=doc.locator('pre code').first();await code.click();await page.keyboard.press('End');await page.keyboard.insertText('\n# edited');
    await expect.poll(()=>page.evaluate(()=>window.changes.at(-1))).toMatch(/```python[\s\S]*# edited[\s\S]*```/);
    await doc.getByRole('checkbox').nth(1).check();
    await expect.poll(()=>page.evaluate(()=>window.changes.at(-1))).toMatch(/[-*] \[x\] 补充下游订单证据/);
    const image=doc.locator('.rr-editable-image img');await expect(image).toHaveCount(1);
    assert.ok(await image.evaluate(el=>el.complete&&el.naturalWidth>0));
    await doc.getByLabel('图片说明').fill('人工修改的图注');
    await expect.poll(()=>page.evaluate(()=>window.changes.at(-1))).toContain('![人工修改的图注]');
    assert.ok((await page.evaluate(()=>window.changes.at(-1))).includes('[^demo]:'));
    await image.scrollIntoViewIfNeeded();await page.screenshot({path:fileURLToPath(new URL(`../test-results/playground-blocknote.png`,import.meta.url))});
    const changesBefore=await page.evaluate(()=>window.changes.length);
    await page.getByRole('button',{name:'重新打开',exact:true}).click();
    await expect(doc.getByLabel('图片说明')).toHaveValue('人工修改的图注');
    await expect(doc.getByRole('checkbox').nth(1)).toBeChecked();
    assert.equal(await page.evaluate(()=>window.changes.length),changesBefore,'reopening must not normalize or save');
    await page.getByRole('button',{name:'只读',exact:true}).click();await expect(doc.getByLabel('图片说明')).toBeDisabled();
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  } finally {await browser.close();}
});

test('nested custom blocks preserve source, images and children when serialized', async () => {
  const bundle = await build({stdin:{contents:`import {BlockNoteEditor} from '@blocknote/core';import {schema} from './src/block-editor.jsx';import {loadBlockMarkdown,saveBlockMarkdown,fingerprint} from './src/block-markdown.mjs';
    window.runNested = () => {
      const editor=BlockNoteEditor.create({schema});
      const state=loadBlockMarkdown(editor,'Parent\\n\\n![图](assets/chart.png)\\n\\n[^ref]: 原始脚注');
      editor.replaceBlocks(editor.document,state.blocks);state.snapshot=fingerprint(editor.document);
      const [parent,picture,source]=editor.document;
      editor.replaceBlocks(editor.document,[{...parent,children:[{...picture,children:[source]}]}]);
      return saveBlockMarkdown(editor,state);
    };`,loader:'jsx',resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,write:false,format:'iife',loader:{'.css':'text'}});
  const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
  try {
    const page=await browser.newPage();await page.setContent('<!doctype html><div></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
    const markdown=await page.evaluate(()=>window.runNested());
    assert.ok(markdown.includes('![图](<assets/chart.png>)'),markdown);
    assert.ok(markdown.includes('[^ref]: 原始脚注'),markdown);
    assert.ok(markdown.includes('Parent'),markdown);
    assert.ok(!markdown.includes('RRCustomMarkdownBlock'),markdown);
  } finally {await browser.close();}
});
