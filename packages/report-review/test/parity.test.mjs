import { fileURLToPath as testFilePath } from 'node:url';
process.chdir(testFilePath(new URL('../', import.meta.url)));
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);

async function load(source) {
  const result = await build({ stdin: { contents:source, resolveDir:process.cwd()+'/src', loader:'jsx' }, write:false, bundle:true, format:'cjs', platform:'node', external:['react','react/jsx-runtime'], loader:{'.css':'text'} });
  const module = { exports:{} }; new Function('require','module','exports',result.outputFiles[0].text)(require,module,module.exports); return module.exports;
}
test('baseline parity: unchanged Host packages and client payload/preview/identity guards', async () => {
  const files = execFileSync('git',['ls-tree','-r','--name-only','10576e7','--','packages'],{cwd:'../..',encoding:'utf8'}).trim().split('\n').filter(p => !p.startsWith('packages/report-review/') || (/\/src\//.test(p) && !p.endsWith('client.jsx')));
  // Includes core, source, renderer, connector, all review Host logic and helper modules.
  assert.equal(execFileSync('git',['diff','10576e7','--',...files],{cwd:'../..',encoding:'utf8'}),'');
  const baseline = await load(execFileSync('git',['show','10576e7:packages/report-review/src/client.jsx'],{encoding:'utf8',maxBuffer:3e6}));
  const current = await load("export * from './client.jsx';");
  const input = {variety:' 锡 ',end:'2026-09-08',analysisPrompt:' 核对近四周 ',webSearchEnabled:true};
  assert.deepEqual(current.generationInput(input),baseline.generationInput(input));
  for (const value of [{...input,end:'2026-02-30'},{...input,variety:''}]) {
    let oldError,newError; try {baseline.generationInput(value);}catch(e){oldError=e.message;} try{current.generationInput(value);}catch(e){newError=e.message;} assert.equal(newError,oldError);
  }
  assert.deepEqual(current.safeWarnings(['UNCONFIRMED','private/path',{key:'secret'}]),baseline.safeWarnings(['UNCONFIRMED','private/path',{key:'secret'}]));
  const items=[{annotationId:'a',selected:true,visibility:'public',publicSource:'source',localNote:'private'}];
  assert.deepEqual(current.humanItemPayload(items),baseline.humanItemPayload(items));
  for(const status of ['draft','confirmed','unknown']) for(const busy of [false,true]) assert.equal(current.isDraftReadOnly({status},busy),baseline.isDraftReadOnly({status},busy));
  for(const status of ['ready','failed','pending']) for(const dirty of [false,true]) for(const saveToken of ['same','stale']) {
    const receipt={status,saveToken,digest:'d',pdfUrl:'/api/pdf'};
    const draft={saveToken:'same'},pdf={url:'blob:pdf',saveToken:'same',digest:'d'};
    assert.equal(current.isPreviewSynced(receipt,draft,dirty,pdf),baseline.isPreviewSynced(receipt,draft,dirty,pdf));
    assert.equal(current.previewAssetKey(receipt),baseline.previewAssetKey(receipt));
  }
  for(const state of [{phase:'unknown'},{phase:'submitted'},{parseReady:true},{phase:'failed'}]) assert.equal(current.publicationStateText(state),baseline.publicationStateText(state));
  const slots=[]; let selected='session-a';
  current.apply({slots:{inject:(_name,fn)=>fn(),register:(options,component)=>slots.push({options,component})},get:()=>({list:{getSnapshot:()=>({current:selected})}})});
  assert.deepEqual(slots.map(x=>x.options.name),['conversation.session.header.actions','sidebar.footer.action','shell.overlay']);
  const footer=slots[1].options.inject(); assert.equal(footer.getSessionId(),'session-a'); selected='session-b';assert.equal(footer.getSessionId(),'session-b');
});
