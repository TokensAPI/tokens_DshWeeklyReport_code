import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
function load(extra = {}) {
  let registration;
  const context = vm.createContext({ console, URL, TextDecoder, Blob, AbortController, crypto: globalThis.crypto, navigator: { userAgent: "test", platform: "Win32" },
    document: { documentElement: {style:{}}, createElement: () => ({}) },
    setTimeout, clearTimeout, setInterval, clearInterval,
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
    location: { origin: 'http://127.0.0.1:43120' }, ...extra });
  vm.runInContext(code, context);
  assert.equal(registration.id, '@tokensapi/dsh-weekly-report');
  const exports = registration.factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' ? {Button:()=>null,Tooltip:()=>null} : require(id));
  return { exports, context };
}
test('formal module wrapper registers lazy factory and plugin slot', () => {
  const { exports } = load();
  assert.deepEqual(Array.from(exports.inject), ['slots']);
  const registrations = [];
  exports.apply({ slots: { inject(n, cb) { cb(); }, register(meta, component) { registrations.push({meta,component}); } } });
  assert.deepEqual(registrations.map(r=>r.meta.name), ['conversation.session.header.actions','sidebar.footer.action','shell.overlay']);
  assert.ok(registrations.every(r=>typeof r.component === 'function'));
});
test('only ready matching clean receipts certify PDF synchronization', () => {
  const { exports:e } = load();
  const d = {saveToken:'s2'}, ready = {status:'ready',saveToken:'s2',digest:'hash'};
  assert.equal(e.acceptsPreview(ready,d,false),true);
  assert.equal(e.acceptsPreview({...ready,saveToken:'s1'},d,false),false);
  assert.equal(e.acceptsPreview(ready,d,true),false);
  assert.equal(e.acceptsPreview({...ready,digest:null},d,false),false);
  for (const status of ['failed','pending','queued','rendering','running','stale',undefined]) {
    const result = {...ready,status};
    assert.equal(e.acceptsPreview(result,d,false),false);
    assert.equal(e.isPreviewSynced(result,d,false,{url:'blob:old',digest:'hash',saveToken:'s2'}),false);
  }
  assert.equal(e.matchesPreviewReceipt({...ready,status:'failed'},d,false),true, 'failure receipt stays visible');
});
test('confirmed drafts are readonly and require a new revision', () => {
  const {exports:e}=load();
  assert.equal(e.isDraftReadOnly({status:'confirmed'},false),true);
  assert.equal(e.isDraftReadOnly({status:'draft'},false),false);
  assert.equal(e.isDraftReadOnly({status:'draft'},true),true);
  assert.equal(e.isDraftReadOnly(null,false),true);
  const source=readFileSync(new URL('../src/client.jsx',import.meta.url),'utf8');
  assert.match(source,/readOnly=\{readOnly\}/);
  assert.match(source,/if \(isDraftReadOnly\(current.current.draft, current.current.busy\)\) return/);
  assert.match(source,/确认稿只读/);
});
test('same cached PDF under a new saveToken has a new effect key and requires new receipt', () => {
  const {exports:e}=load();
  const a={status:'ready',pdfUrl:'/api/run19/pdf?digest=hash',digest:'hash',saveToken:'s1'}, b={...a,saveToken:'s2'};
  assert.notEqual(e.previewAssetKey(a),e.previewAssetKey(b));
  assert.equal(e.previewAssetKey({...b,status:'failed'}),null);
  assert.equal(e.isPreviewSynced(b,{saveToken:'s2'},false,{url:'blob:old',digest:'hash',saveToken:'s1'}),false);
  assert.equal(e.isPreviewSynced(b,{saveToken:'s2'},false,{url:'blob:new',digest:'hash',saveToken:'s2'}),true);
  const source=readFileSync(new URL('../src/client.jsx',import.meta.url),'utf8');
  assert.match(source,/\}, \[assetKey\]\)/);
});
test('generation and preview warnings are visible as safe codes, never arbitrary details', () => {
  const {exports:e}=load();
  const warnings=e.safeWarnings(['KNOWLEDGE_VERSION_FILTER_NOT_IMPLEMENTED','LOW_CONFIDENCE_ANNOTATION_MAPPING'],['LOW_CONFIDENCE_ANNOTATION_MAPPING','/Users/private/secret.key','ERROR: /private/foo', {message:'private prompt'}, 'https://private.example/token']);
  assert.equal(warnings.length,3);
  assert.match(warnings[0].message,/历史或撤回/);
  assert.match(warnings[1].message,/置信度低/);
  assert.equal(warnings[2].code,'WARNING_DETAILS_REDACTED');
  assert.doesNotMatch(JSON.stringify(warnings),/secret|\/Users|\/private|private prompt|https:/);
  const source=readFileSync(new URL('../src/client.jsx',import.meta.url),'utf8');
  assert.match(source,/aria-label="审阅注意事项"/);
  assert.match(source,/safeWarnings\(value\?\.warnings, d.warnings\)/);
  assert.match(source,/safeWarnings\(reportWarnings.map\(w => w.code\), draft\?\.warnings, preview\?\.warnings\)/);
});
test('PDF URLs allow same-origin only, never script/data/external paths', () => {
  const { exports:e } = load(); const origin='http://127.0.0.1:43120';
  assert.equal(e.safePdfUrl('/api/run19/pdf?digest=x',origin),origin+'/api/run19/pdf?digest=x');
  for (const url of ['javascript:alert(1)','data:application/pdf,x','https://evil.example/a','//evil.example/a']) assert.equal(e.safePdfUrl(url,origin),null);
});
test('API uses Electron transport with internal base, preserving response envelope', async () => {
  let captured;
  const { exports:e } = load({location:{origin:'null'}, __DSH_TRANSPORT__: {fetch:async (url,init) => {captured={url,init}; return {ok:true,json:async()=>({ok:true,value:{saveToken:'ok'}})};}}, fetch:()=>{throw new Error('Native fetch must not run');}});
  assert.equal((await e.api('session-1','save',{reportId:'r',markdown:'test'})).saveToken,'ok');
  assert.equal(captured.url,'http://dsh.internal/api/run19/review');
  assert.equal(JSON.parse(captured.init.body).sessionId,'session-1');
  assert.equal(JSON.parse(captured.init.body).action,'save');
});
test('API preserves Host conflict errors', async () => {
  const { exports:e }=load({fetch:async()=>({ok:false,status:409,json:async()=>({ok:false,error:{code:'conflict',message:'stale token'}})})});
  await assert.rejects(e.api('s','save'),error=>error.code==='conflict'&&error.message==='stale token');
});
test('missing Host route explicitly recommends complete restart, not GUI success', async () => {
  const {exports:e}=load({fetch:async()=>({ok:false,status:404,json:async()=>{throw new Error('not JSON');}})});
  await assert.rejects(e.api('s','list'),error=>error.code==='HOST_NOT_LOADED' && error.message.includes('重新启动 TokensCowork'));
});
test('generate validates fields and defaults to pure data unless prompted', async () => {
  let sent;
  const { exports:e }=load({fetch:async (url,init)=>{sent=JSON.parse(init.body);return {ok:true,json:async()=>({ok:true,value:{reportId:'generated'}})};}});
  const input=e.generationInput({variety:' 锡 ',end:'2026-09-08',analysisPrompt:' 做连续性梳理 ',webSearchEnabled:true});
  await e.api('s','generate',input);
  assert.equal(sent.action,'generate'); assert.equal(sent.variety,'锡'); assert.equal(sent.end,'2026-09-08'); assert.equal(sent.analysisPrompt,'做连续性梳理'); assert.equal(sent.webSearchEnabled,true);
  assert.equal('includeKnowledge' in sent,false); assert.equal('knowledgeQuery' in sent,false); assert.equal('webSearch' in sent,false);
  assert.equal(e.generationInput({variety:'锡',end:'2026-09-08'}).analysisPrompt,'');
  assert.throws(()=>e.generationInput({...input,end:'2026-02-30'}));
  assert.throws(()=>e.generationInput({...input,variety:' '}));
});
test('publication read helper sends independent actions without publish retries or tokens', async () => {
  const calls=[];
  const {exports:e}=load({fetch:async (url,init)=>{calls.push(JSON.parse(init.body));return {ok:true,json:async()=>({ok:true,value:{records:[]}})};}});
  await e.readPublication('s','r','publicationStatus'); await e.readPublication('s','r','reconcile');
  assert.deepEqual(calls,[{reportId:'r',action:'publicationStatus',sessionId:'s'},{reportId:'r',action:'reconcile',sessionId:'s'}]);
  assert.throws(()=>e.readPublication('s','r','publish'));
  assert.equal(calls.length,2);
  const failedCalls=[];
  const f=load({fetch:async (url,init)=>{failedCalls.push(JSON.parse(init.body).action);return {ok:false,status:500,json:async()=>({ok:false,error:{code:'READ_FAILED',message:'failed'}})};}}).exports;
  await assert.rejects(f.readPublication('s','r','reconcile'));
  assert.deepEqual(failedCalls,['reconcile']);
});
test('publication record buttons call only dedicated read actions; parse readiness is not indexing', () => {
  const {exports:e}=load(); const actions=[];
  const tree=e.PublicationRecords({value:{records:[{planId:'p',versionId:'V1',phase:'submitted',parseReady:true}]},busy:false,onRead:a=>actions.push(a)});
  const buttons=[];function walk(n){if(Array.isArray(n))return n.forEach(walk);if(!n||typeof n!=='object')return;if(n.type==='button')buttons.push(n);walk(n.props?.children);}
  walk(tree);buttons.forEach(b=>b.props.onClick());
  assert.deepEqual(actions,['publicationStatus','reconcile']);
  assert.match(e.publicationStateText({phase:'submitted'}),/已提交上传.*不代表解析或检索完成/);
  assert.match(e.publicationStateText({parseReady:true}),/解析就绪；检索未核验/);
  assert.match(e.publicationStateText({parseReady:true}),/未标记发布完成/);
  assert.match(e.publicationStateText({outcomeUnknown:true}),/不要自动重传/);
  const source=readFileSync(new URL('../src/client.jsx',import.meta.url),'utf8');
  assert.match(source,/showPublication\('publicationStatus'\)\}>发布记录/);
  assert.match(source,/showPublication\('reconcile'\)\}>只读核对/);
  const readSection=source.slice(source.indexOf('async function showPublication'),source.indexOf('async function publishAll'));
  assert.doesNotMatch(readSection,/setInterval|setTimeout|request\('publish'/);
});
test('human item controls default unselected local and omit private notes from payload',()=>{
  const {exports:e}=load();const payload=e.humanItemPayload([{annotationId:'a',content:'current',localNote:'PRIVATE',category:'style'}]);
  assert.deepEqual(JSON.parse(JSON.stringify(payload)),[{annotationId:'a',category:'style',selected:false,visibility:'local'}]);
  const source=readFileSync(new URL('../src/client.jsx',import.meta.url),'utf8');
  assert.match(source,/action\('humanItems'\)/);assert.match(source,/action\('saveHumanItems',\{items,saveToken\}\)/);
  assert.match(source,/保存人工信息选择（仅本地）/);assert.match(source,/已确认稿只读，请先开启新一轮修订/);
  for(const category of ['supplement','correction','retraction','judgment','style'])assert.ok(source.includes(category));
  assert.match(source,/name === 'saveHumanItems'[\s\S]*?request\('get'/);
});
test('bundle uses the host React and React DOM without a private renderer', () => {
  assert.match(code,/require\("react"\)/);
  assert.match(code,/require\("react-dom"\)/);
  assert.match(code,/require\("react-dom\/client"\)/);
  assert.doesNotMatch(code,/node_modules\/(?:react|react-dom|scheduler)\//);
  assert.doesNotMatch(code,/__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE/);
  assert.doesNotMatch(code,/require\("@codemirror\//);
  assert.match(code,/new MergeView/);
  assert.match(code,/nativeEvent.isTrusted/);
});
