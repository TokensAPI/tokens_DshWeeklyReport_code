import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PdfRenderer, apply } from '../index.js';
const root = fileURLToPath(new URL('../.test-output/', import.meta.url));
const pythonPath = process.env.RUN19_PYTHON || '/Users/rz/.runzhou/venv/bin/python';
const fontPath = process.env.RUN19_FONT || '/System/Library/Fonts/STHeiti Medium.ttc';
await fs.mkdir(root, { recursive: true });
const image = path.join(root, 'chart.png');
execFileSync(pythonPath, ['-c', 'import pymupdf as f,sys; d=f.open();p=d.new_page(width=240,height=100);p.draw_rect((10,10,220,80),fill=(0.1,0.5,0.7));p.get_pixmap().save(sys.argv[1])', image]);
const bytes = await fs.readFile(image);
const asset = { id: 'chart', path: image, sha256: createHash('sha256').update(bytes).digest('hex') };
const md = '# 中文周报\n\n人工修订段落。\n\n| 商品 | 价格 |\n| --- | --- |\n| 锡 | 260000 |\n\n![价格图](asset:chart)';
const annotation = (startLine,endLine) => ({ public: true, source: 'user_direct', target: { startLine,endLine,quote:md.split('\n').slice(startLine-1,endLine).join('\n') }, displayName:'测试用户',completedAt:'2026-09-08-22-00' });
const input = {reportId:'test',markdown:md,assets:[asset],saveToken:'s1',annotations:[annotation(1,1),annotation(3,3),annotation(5,7)]};
const renderer = new PdfRenderer({cacheDir:path.join(root,'cache'),assetRoots:[root],pythonPath,fontPath});
test('real Chinese/table/image PDF; source markers and cache digest', async () => {
  const result = await renderer.render(input);
  assert.equal(result.status,'ready',JSON.stringify(result));
  assert.equal(result.markedBlocks,3);
  assert.equal(result.imageCount,1);
  const report = JSON.parse(execFileSync(pythonPath,['-c', 'import pymupdf as f,json,sys;d=f.open(sys.argv[1]);print(json.dumps({"text":"".join(p.get_text() for p in d),"images":sum(len(p.get_images()) for p in d),"drawings":sum(len(p.get_drawings()) for p in d)}))',result.pdfPath],{encoding:'utf8'}));
  assert.match(report.text,/中文周报/); assert.match(report.text,/260000/);assert.match(report.text,/加粗下划线/);
  assert.ok(report.images>0);assert.ok(report.drawings>5);
  const cached = await renderer.render({...input,saveToken:'s2'});
  assert.equal(cached.cached,true);assert.equal(cached.digest,result.digest);assert.equal(cached.saveToken,'s2');
  const changed = await renderer.render({...input,annotations:[],saveToken:'s3'});
  assert.notEqual(changed.digest,result.digest);
  await fs.writeFile(path.join(root,'verification.json'),JSON.stringify({result,text:report.text,images:report.images,drawings:report.drawings},null,2));
});
test('reject missing hash, arbitrary image references, outside whitelist and imprecise annotation', async () => {
  for (const patch of [{assets:[{...asset,sha256:'0'.repeat(64)}]}, {markdown:'![remote](https://example.com/a.png)'},{markdown:'![local](/etc/passwd)'},{annotations:[{...annotation(5,7),target:{startLine:7,endLine:7,quote:'| 锡 | 260000 |'}}]}]) {
    const out = await renderer.render({...input,...patch});assert.equal(out.status,'failed');assert.equal(out.pdfPath,undefined);
  }
  const noRoots = new PdfRenderer({cacheDir:path.join(root,'cache'),assetRoots:[],pythonPath,fontPath});
  assert.equal((await noRoots.render(input)).error,'ASSET_OUTSIDE_WHITELIST');noRoots.dispose();
});
test('latest queued snapshot wins per report; dispose blocks work', async () => {
  const first = renderer.render({...input,saveToken:'old'});
  const second = renderer.render({...input,saveToken:'new'});
  assert.equal((await first).status,'stale');assert.equal((await second).status,'ready');
  renderer.dispose();assert.equal((await renderer.render(input)).status,'stale');
});
test('active outdated jobs return no path; private fields excluded; symlink escape rejected', async () => {
  const r = new PdfRenderer({cacheDir:path.join(root,'extra-cache'),assetRoots:[root],pythonPath,fontPath});
  const process = r.process.bind(r);
  let started;
  const start = new Promise(resolve => { started = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  r.process = async args => { if (++calls === 1) { started(); await gate; } return process(args); };
  const old = r.render({...input,saveToken:'active-old'});
  await start;
  const next = r.render({...input,saveToken:'active-new'});
  release();
  const outdated = await old;
  assert.equal(outdated.status,'stale');assert.equal(outdated.pdfPath,undefined);
  const fresh = await next;assert.equal(fresh.status,'ready');
  const privateIgnored = await r.render({...input,annotations:[...input.annotations,{public:false,target:{quote:'secret prompt'}}]});
  assert.equal(privateIgnored.digest,fresh.digest);
  const futureFields = await r.render({...input,annotations:input.annotations.map(a=>({...a,prompt:'SECRET',target:{...a.target,privateNote:'SECRET'}}))});
  assert.equal(futureFields.digest,fresh.digest);
  if (globalThis.process.platform !== 'win32') {
    const link = path.join(root,'escape.png');
    await fs.rm(link,{force:true});await fs.symlink('/etc/passwd',link);
    assert.equal((await r.render({...input,assets:[{...asset,path:link}]})).error,'ASSET_OUTSIDE_WHITELIST');
  }
  r.dispose();
});
test('installed-package exports resolve to ESM entry with Python/license payload', async () => {
  const packageRoot = fileURLToPath(new URL('../',import.meta.url));
  const installRoot = await fs.mkdtemp(path.join(root,'install-'));
  const destination = path.join(installRoot,'node_modules','@run19','report-pdf');
  await fs.mkdir(destination,{recursive:true});
  const pkg = {exports:'./index.js',files:['index.js','renderer.py','LICENSE']};
  for (const file of ['package.json',...pkg.files]) await fs.copyFile(path.join(packageRoot,file),path.join(destination,file));
  assert.equal(pkg.exports,'./index.js');
  const code = `import {PdfRenderer} from '@run19/report-pdf'; if(typeof PdfRenderer!=='function') throw Error('missing class'); console.log('installed-esm-ok');`;
  await fs.writeFile(path.join(installRoot,'smoke.mjs'),code);
  const stdout = execFileSync(process.execPath,[path.join(installRoot,'smoke.mjs')],{encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  assert.match(stdout,/installed-esm-ok/);
});
test('Cordis provider registration and reversible disposal', () => {
  let service, cleanup;
  apply({provide:(name,value)=>{assert.equal(name,'reportPdf');service=value;},effect:fn=>{cleanup=fn();}}, {cacheDir:root});
  assert.ok(service instanceof PdfRenderer);cleanup();assert.equal(service.closed,true);
});
