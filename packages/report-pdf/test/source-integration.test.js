import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ReportStore } from '../../report-core/src/index.mjs';
import { PdfRenderer } from '../index.js';

const output = fileURLToPath(new URL('../.test-output/source-integration/',import.meta.url));
const manifestPath = fileURLToPath(new URL('../../weekly-report-source/validation/weekly-8V6p06/manifest.json',import.meta.url));
const pythonPath = process.env.RUN19_PYTHON || '/Users/rz/.runzhou/venv/bin/python';
const fontPath = process.env.RUN19_FONT || '/System/Library/Fonts/STHeiti Medium.ttc';
const sha = bytes=>createHash('sha256').update(bytes).digest('hex');

test('real 13-series tin source → core snapshots → preview/edit/confirmed-public PDFs',async()=>{
  const manifest = JSON.parse(await fs.readFile(manifestPath,'utf8'));
  const fixtureRoot = path.dirname(manifestPath);
  manifest.runDir = fixtureRoot;
  manifest.markdown.absolutePath = path.join(fixtureRoot, manifest.markdown.path);
  for (const asset of manifest.assets) asset.absolutePath = path.join(fixtureRoot, asset.path);
  assert.equal(manifest.sources.series.length,13);
  assert.equal(manifest.assets.length,4);
  assert.ok(manifest.sources.series.every(s=>s.status==='ok'));
  const markdownBytes = await fs.readFile(manifest.markdown.absolutePath);
  assert.equal(sha(markdownBytes),manifest.markdown.sha256);
  for (const a of manifest.assets) assert.equal(sha(await fs.readFile(a.absolutePath)),a.sha256);
  await fs.mkdir(output,{recursive:true});
  const rootDir = await fs.mkdtemp(path.join(output,'core-'));
  const store = new ReportStore({rootDir});
  const sessionId = 'fixture-source-integration';
  let draft = await store.createDraft({sessionId,title:manifest.title,markdown:markdownBytes.toString('utf8'),source:'agent_inference'});
  draft = await store.snapshotAssets({sessionId,reportId:draft.reportId,saveToken:draft.saveToken,assets:manifest.assets.map(a=>({path:a.absolutePath,markdownPath:a.path}))});
  assert.equal(draft.assets.length,4);
  assert.equal((draft.markdown.match(/\]\(asset:/g)||[]).length,4);
  assert.ok(draft.assets.every(a=>a.path.startsWith(rootDir)));
  const renderer = new PdfRenderer({cacheDir:path.join(output,'cache'),assetRoots:[rootDir],pythonPath,fontPath});
  const initial = await renderer.render(draft);
  assert.equal(initial.status,'ready',JSON.stringify(initial));assert.equal(initial.imageCount,4);
  const replacement = '集成测试人工补充：本段仅验证修订留痕，不构成市场事实或投资建议。';
  const changedMarkdown = draft.markdown.replace('- 待填充：本周重点事件（政策/供需/资金/产业）。',replacement);
  draft = await store.saveDraft({sessionId,reportId:draft.reportId,saveToken:draft.saveToken,markdown:changedMarkdown,source:'user_direct'});
  const pending = draft.annotations.filter(a=>a.public===true);
  assert.equal(pending.length,1);
  assert.ok(!pending[0].completedAt);assert.ok(!pending[0].displayName);
  // Do not invent a verified identity or completion time in private draft preview.
  const edited = await renderer.render(draft);
  assert.equal(edited.status,'ready',JSON.stringify(edited));assert.equal(edited.markedBlocks,1);
  assert.ok(edited.warnings.some(w=>w.includes('UNCONFIRMED')));
  const version = await store.confirm({sessionId,reportId:draft.reportId,saveToken:draft.saveToken,author:{authorId:'fixture-not-weknora-user',displayName:'集成测试账号（非知识库身份）'}});
  assert.equal(version.versionId,'V1');
  const exported = await store.exportVersion({sessionId,reportId:draft.reportId,versionId:version.versionId});
  assert.equal(exported.annotations.length,1);
  assert.equal(exported.annotations[0].displayName,'集成测试账号（非知识库身份）');
  const confirmed = await renderer.render({...exported,saveToken:'fixture-V1'});
  assert.equal(confirmed.status,'ready',JSON.stringify(confirmed));assert.equal(confirmed.imageCount,4);assert.equal(confirmed.markedBlocks,1);
  assert.notEqual(confirmed.digest,edited.digest);
  const results={initial,edited,confirmed};
  const evidence={fixture:true,identityDisclaimer:'Confirmation uses a synthetic test identity, NOT a verified WeKnora account. No publication occurred.',manifestPath,sourceSeries:manifest.sources.series.length,sourceAssets:manifest.assets.length,reportId:draft.reportId,results,checks:{}};
  for (const [name,result] of Object.entries(results)) {
    const prefix=path.join(output,name);
    const checks=JSON.parse(execFileSync(pythonPath,['-c',`import pymupdf as f,json,sys
with f.open(sys.argv[1]) as d:
 text=''.join(p.get_text() for p in d)
 for i,p in enumerate(d): p.get_pixmap(matrix=f.Matrix(1,1)).save(sys.argv[2]+'-page-'+str(i+1)+'.png')
 print(json.dumps({'pages':len(d),'images':sum(len(p.get_images()) for p in d),'text':text,'drawings':sum(len(p.get_drawings()) for p in d)},ensure_ascii=False))`,result.pdfPath,prefix],{encoding:'utf8'}));
    assert.equal(checks.images,4);assert.match(checks.text,/418,950/);assert.match(checks.text,/14,000/);assert.match(checks.text,/锡/);
    if(name==='edited'){assert.match(checks.text,/时间未确认/);assert.match(checks.text,/身份未确认/);}
    if(name==='confirmed'){assert.match(checks.text,/集成测试账号/);assert.match(checks.text,/不构成市场事实/);}
    evidence.checks[name]=checks;
  }
  await fs.writeFile(path.join(output,'integration-evidence.json'),JSON.stringify(evidence,null,2));
  renderer.dispose();
});
