import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import toolsPlugin from '../src/tools.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ReportStore } from '../../report-core/src/index.mjs';
import { createReviewHost, apply, registerReviewTools } from '../src/index.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(),'run19-review-')); t.after(() => rm(root,{recursive:true,force:true}));
  const core = new ReportStore({rootDir:join(root,'core')}), file=join(root,'preview.pdf'); await writeFile(file,'%PDF-1.7\nfixture');
  const calls=[], connector = { async identity(options) { assert.equal(options.forPublication,true); return {verified:true,credentialPurpose:'publish',principal:{userId:'u1',username:'Test Account'}}; }, createReviewHost() { return {approve(value){calls.push(value);return Object.freeze({});}, async execute(){return {ok:true,data:{id:'k1',knowledge_base_id:'kb1'},submitted:true};}}; } };
  const pdf = { async render(d) { return {status:'ready',saveToken:d.saveToken,digest:hash(d.markdown),pdfPath:file,warnings:[]}; } };
  const api = createReviewHost({core,pdf,sessions:{get:id=>['s1','s2'].includes(id)?{id}:undefined},getConnector:()=>connector,getSource:()=>options.source,getLlm:()=>options.getLlm,getDefaultModel:()=>options.getDefaultModel}, {allowedSessionIds:['s1'],publishKbId:'kb1',sourceOutputRoot:options.sourceOutputRoot,...options.config});
  t.after(()=>api.dispose());
  const call=(action,args={})=>api.dispatchHuman({action,sessionId:'s1',...args});
  return {root,core,pdf,api,call,connector,calls,file};
}
test('formal routes use connection authenticated exact registry and clean lifecycle',()=>{
  const routes=[],effects=[],services={}; const ctx={reportCore:{},reportPdf:{},sessions:{get:()=>({})},get:()=>undefined,provide:(k,v)=>services[k]=v,connection:{fetch:{register:r=>routes.push(r)}},effect:f=>effects.push(f())};
  apply(ctx,{allowedSessionIds:['s1']}); assert.deepEqual(routes.map(r=>[r.path,r.methods,r.requestBody]),[['/api/run19/review',['POST'],'buffered'],['/api/run19/generate',['POST'],'buffered'],['/api/run19/ai-stream',['POST'],'buffered'],['/api/run19/lookup',['POST'],'buffered'],['/api/run19/asr',['POST'],'buffered'],['/api/run19/asr-polish',['POST'],'buffered'],['/api/run19/pdf',['GET'],'buffered']]);
  assert.ok(services.reportReview); effects.forEach(f=>f());
});
test('draft projection strips paths, arbitrary metadata, audit prompts; session and conflict checks',async t=>{
  const {call,core,api,root}=await setup(t); const png=join(root,'secret.png');await writeFile(png,'fixture');
  const d=await core.createDraft({sessionId:'s1',title:'T',markdown:'# Base',assets:[{path:png}],markers:[{prompt:'hidden'}],annotations:[{id:'a',public:false,prompt:'hidden'}]});
  const shown=await call('get',{reportId:d.reportId}); const json=JSON.stringify(shown);assert.ok(!json.includes(root));assert.ok(!json.includes('prompt'));assert.ok(!json.includes('markers'));
  await assert.rejects(api.dispatchHuman({action:'get',sessionId:'s2',reportId:d.reportId}),{code:'SESSION_FORBIDDEN'});
  await assert.rejects(call('get',{reportId:'r_unknown'}));
  const saved=await call('save',{reportId:d.reportId,saveToken:d.saveToken,markdown:'# Changed',author:{displayName:'fake'},source:'agent_inference'});
  await assert.rejects(call('save',{reportId:d.reportId,saveToken:d.saveToken,markdown:'overwrite'}),{code:'CONFLICT'});
  const events=await call('audit',{reportId:d.reportId});assert.equal(events.baselineMarkdown,'# Base');assert.equal(events.entries.at(-1).source,'user_direct');assert.ok(!JSON.stringify(events).includes(root));
  assert.equal((await call('list')).reports.length,1);assert.equal(saved.markdown,'# Changed');
});
test('identity comes from upload credential; fake client author cannot confirm',async t=>{
  const {call,connector}=await setup(t);const d=await call('create',{title:'T',markdown:'# T'});
  connector.identity=async()=>({verified:true,credentialPurpose:'read',principal:{userId:'forged',username:'admin'}});
  assert.equal((await call('identity')).confirmed,false);
  await assert.rejects(call('confirm',{reportId:d.reportId,saveToken:d.saveToken,author:{authorId:'admin',displayName:'admin'}}),{code:'IDENTITY_UNVERIFIED'});
  connector.identity=async()=>({verified:true,credentialPurpose:'publish',principal:{userId:'u1',username:'Account'}});
  const v=await call('confirm',{reportId:d.reportId,saveToken:d.saveToken,author:{authorId:'admin',displayName:'admin'}});assert.equal(v.author.displayName,'Account');
  assert.equal((await call('versions',{reportId:d.reportId})).versions[0].markdown,'# T');
  const next=await call('startRevision',{reportId:d.reportId});assert.equal(next.baseVersionId,'V1');
});
test('preview digest map authorizes bytes and refuses stale or path-controlled download',async t=>{
  const {call,api,pdf}=await setup(t);const d=await call('create',{title:'T',markdown:'# T'});
  const p=await call('preview',{reportId:d.reportId,saveToken:d.saveToken});assert.equal(p.status,'ready');assert.equal(p.pdfPath,undefined);
  const response=await api.fetchPdf(new Request('http://dsh.internal'+p.pdfUrl));assert.equal(response.status,200);assert.ok((await response.text()).startsWith('%PDF-'));
  assert.equal((await api.fetchPdf(new Request('http://dsh.internal'+p.pdfUrl+'&path=/etc/passwd'))).status,404);
  await call('save',{reportId:d.reportId,saveToken:d.saveToken,markdown:'# New'});
  assert.equal((await api.fetchPdf(new Request('http://dsh.internal'+p.pdfUrl))).status,409);
  pdf.render=async d=>({status:'ready',saveToken:'obsolete',digest:hash(d.markdown),pdfPath:'/etc/passwd'});
  assert.equal((await call('preview',{reportId:d.reportId})).status,'stale');
});
test('private/inference/low-confidence annotations never enter renderer',async t=>{
  const {core,pdf,call}=await setup(t);const d=await core.createDraft({sessionId:'s1',title:'T',markdown:'Hello',annotations:[{public:true,source:'agent_inference',target:{startLine:1,endLine:1,quote:'Hello'},secret:'x'},{public:true,source:'user_direct',mappingConfidence:'low',target:{startLine:1,endLine:1,quote:'Hello'}}]});
  let input;pdf.render=async d=>{input=d;return {status:'failed'};}; const p=await call('preview',{reportId:d.reportId});assert.deepEqual(input.annotations,[]);assert.ok(p.warnings.includes('LOW_CONFIDENCE_ANNOTATION_MAPPING'));
});
test('publication requires bound one-time token; submitted is not published; no blind replay',async t=>{
  const {call,core,calls}=await setup(t);const d=await call('create',{title:'T',markdown:'# T'});const v=await call('confirm',{reportId:d.reportId,saveToken:d.saveToken});
  const plan=await call('publishPlan',{reportId:d.reportId,versionId:v.versionId});
  await assert.rejects(call('publish',{reportId:d.reportId,...plan,userInitiated:false}),{code:'HUMAN_CLICK_REQUIRED'});
  await assert.rejects(call('publish',{reportId:d.reportId,...plan,digest:hash('forged'),userInitiated:true}),{code:'PUBLISH_TOKEN_INVALID'});
  const receipt=await call('publish',{reportId:d.reportId,...plan,userInitiated:true});assert.equal(receipt.status,'submitted');assert.equal(receipt.published,false);assert.equal(calls.length,2);
  await assert.rejects(call('publish',{reportId:d.reportId,...plan,userInitiated:true}),{code:'PUBLISH_TOKEN_INVALID'});
  await assert.rejects(call('publishPlan',{reportId:d.reportId,versionId:v.versionId}),{code:'PUBLICATION_RECONCILIATION_REQUIRED'});
  const records=await core.listPublicationRecords({sessionId:'s1',reportId:d.reportId});
  const itemRecords=await core.listPublicationItemRecords({sessionId:'s1',reportId:d.reportId,planId:plan.planId});
  assert.equal(records.at(-1).status,'failed');assert.equal(records.at(-1).details.phase,'submitted');
  assert.equal(itemRecords.length,2);assert.equal(itemRecords[0].details.phase,'submitted');assert.equal(itemRecords[0].details.remote.id,'k1');
});
test('publishing a human-revised version records format-excluded review marks',async t=>{
  const {call,calls}=await setup(t);
  const d=await call('create',{title:'T',markdown:'# LLM base'});
  const v1=await call('confirm',{reportId:d.reportId,saveToken:d.saveToken});
  const rev=await call('startRevision',{reportId:d.reportId});assert.equal(rev.baseVersionId,v1.versionId);
  const saved=await call('save',{reportId:d.reportId,saveToken:rev.saveToken,markdown:'# Human revised\n\n## 风险\n警惕到港冲击。'});
  const v2=await call('confirm',{reportId:d.reportId,saveToken:saved.saveToken});assert.equal(v2.baseVersionId,v1.versionId);
  const plan=await call('publishPlan',{reportId:d.reportId,versionId:v2.versionId});
  const receipt=await call('publish',{reportId:d.reportId,...plan,userInitiated:true});
  assert.equal(receipt.status,'submitted');
  const meta=calls.find(c=>c.operation==='setKnowledgeMetadata');
  assert.ok(meta,'setKnowledgeMetadata invoked on the published report');
  assert.equal(meta.knowledgeId,'k1');
  const marks = JSON.parse(meta.customMetadata.review_marks);
  assert.equal(marks.llmBaselineVersionId,v1.versionId);
  assert.equal(marks.substantive,true);
  assert.ok(marks.edits.some(e=>e.text.includes('到港冲击')));
  assert.ok(receipt.warnings.some(w=>w.includes('人工审阅标记')));
});
test('images block publication rather than pretending full report upload',async t=>{
  const {call,calls}=await setup(t);const d=await call('create',{title:'T',markdown:'![image](https://example.org/x.png)'});await call('confirm',{reportId:d.reportId,saveToken:d.saveToken});
  await assert.rejects(call('publishPlan',{reportId:d.reportId,versionId:'V1'}),{code:'IMAGES_UNSUPPORTED'});assert.equal(calls.length,0);
});
test('route errors are sanitized and HTTP JSON contract stable',async t=>{
  const {api,core}=await setup(t);const req=x=>new Request('http://dsh.internal/api/run19/review',{method:'POST',body:JSON.stringify(x)});
  let response=await api.fetchReview(req({action:'create',sessionId:'s1',title:'T',markdown:'Text'}));assert.equal((await response.json()).ok,true);
  core.listDrafts=()=>{throw new Error('/private/secret key=value');};response=await api.fetchReview(req({action:'list',sessionId:'s1'}));assert.deepEqual(await response.json(),{ok:false,error:{code:'INTERNAL_ERROR',message:'Host operation failed; private diagnostics are not exposed.'}});
});
test('generation validates manifest hash and root; client paths never forwarded',async t=>{
  const stage=await mkdtemp(join(tmpdir(),'run19-source-'));t.after(()=>rm(stage,{recursive:true,force:true}));const run=join(stage,'weekly-one');await mkdir(run);await writeFile(join(run,'report.md'),'# Generated');
  let request;const descriptor={path:'report.md',absolutePath:join(run,'report.md'),sha256:hash('# Generated'),bytes:11};const source={async generate(x){request=x;return {runDir:run,title:'Generated',markdown:descriptor,assets:[],runId:'one'};}};
  const {call}=await setup(t,{source,sourceOutputRoot:stage});const d=await call('generate',{variety:'锡',outputRoot:'/etc',materials:[{text:'secret'}]});assert.equal(d.markdown,'# Generated');assert.deepEqual(request,{variety:'锡'});
  descriptor.sha256=hash('bad');await assert.rejects(call('generate',{variety:'锡'}),{code:'SOURCE_HASH_MISMATCH'});
});
test('tools exact definition derives session from exec.agent, no model publish capability',async t=>{
  const {api,call}=await setup(t);const d=await call('create',{title:'T',markdown:'Text'}),defs=[];
  const dispose=registerReviewTools({get:k=>k==='tools'?{register:d=>{defs.push(d);return ()=>{};}}:api},api);
  assert.deepEqual(defs.map(x=>x.name),['run19_report_list','run19_report_read','run19_report_save']);assert.ok(defs.every(d=>d.output.schema && d.output.render));
  await assert.rejects(defs[0].execute({reportId:d.reportId},{agent:{id:'s2'}}),{code:'SESSION_FORBIDDEN'});
  assert.equal((await defs[0].execute({}, {agent:{id:'s1'}})).reports[0].reportId,d.reportId);
  const saved=await defs[2].execute({reportId:d.reportId,saveToken:d.saveToken,markdown:'New',source:'user_prompt',instruction:'private instruction',sessionId:'s2'},{agent:{id:'s1'}});assert.equal(saved.markdown,'New');
  const audit=await call('audit',{reportId:d.reportId});assert.equal(audit.entries.at(-1).source,'user_prompt');assert.ok(!JSON.stringify(audit).includes('private instruction'));dispose();
});
test('opt-in tools plugin declares exact dependencies and only registers read/save',()=>{
  const definitions=[]; const registry={register:d=>{definitions.push(d);return ()=>{};}};
  assert.deepEqual(toolsPlugin.inject,['tools','reportReview']);
  toolsPlugin.apply({reportReview:{read(){},save(){}},get:k=>k==='tools'?registry:undefined});
  assert.deepEqual(definitions.map(d=>d.name),['run19_report_list','run19_report_read','run19_report_save']);
});
test('default is pure 7-day data; prompt/web opt in to LLM analysis',async t=>{
  const stage=await mkdtemp(join(tmpdir(),'run19-materials-'));t.after(()=>rm(stage,{recursive:true,force:true}));const run=join(stage,'weekly-m');await mkdir(run);await writeFile(join(run,'report.md'),'# Generated');
  const requests=[];const source={async generate(x){requests.push(x);return {runDir:run,title:'T',markdown:{path:'report.md',sha256:hash('# Generated')},assets:[]};}};
  const {call,connector}=await setup(t,{source,sourceOutputRoot:stage});
  let searchQuery=null;const chunksCalls=[];
  connector.search=async (kb,q,opts)=>{searchQuery={kb,q,opts};return {ok:true,data:{knowledge_base_id:kb,data:[{id:'wk-row',knowledge_id:'k1',knowledge_title:`${q} 周报`,content:'search snippet 短内容'}]}};};
  connector.chunks=async (kb,kid,{page,pageSize})=>{chunksCalls.push({kb,kid,page,pageSize});return {ok:true,data:{data:[{content:`FULL-${kid}-p${page} 完整周报正文`}]}};};
  // Pure data: no prompt, no web -> neither knowledge nor web nor LLM runs; materials key absent.
  const d=await call('generate',{variety:'锡'});
  assert.equal('materials' in requests.at(-1),false);assert.equal(searchQuery,null);assert.equal(chunksCalls.length,0);assert.ok(!d.warnings.includes('LLM_SYNTHESIS_UNSUPPORTED')&&!d.warnings.includes('WEB_SEARCH_UNAVAILABLE'));
  // Analysis requirement that explicitly asks for historical weeks triggers WeKnora past-report retrieval (search → RAG fragments) AND LLM synthesis (no llm service -> LLM_SYNTHESIS_UNSUPPORTED, non-fatal).
  // The script feeds relevant search fragments only; it must NOT paginate whole documents via connector.chunks anymore.
  const d2=await call('generate',{variety:'锡',analysisPrompt:'近5周锡周报综合分析'});
  assert.equal(searchQuery.kb,'kb1');assert.equal(searchQuery.q,'锡');assert.equal(chunksCalls.length,0);assert.ok(d2.warnings.includes('KNOWLEDGE_RETRIEVED'));assert.ok(d2.warnings.includes('LLM_SYNTHESIS_UNSUPPORTED'));
  const chunkCountAfterD2=chunksCalls.length;
  // An analysis prompt WITHOUT a historical/weekly keyword must NOT pull past reports (history is human-driven), even with web enabled.
  const d3=await call('generate',{variety:'锡',analysisPrompt:'补充多空逻辑',webSearchEnabled:true});
  assert.equal(chunksCalls.length,chunkCountAfterD2);assert.ok(d3.warnings.includes('WEB_SEARCH_UNAVAILABLE'));
});
test('real generator manifest and four PNG files import into actual core snapshots',async t=>{
  const stage=fileURLToPath(new URL('../../weekly-report-source/validation/',import.meta.url));
  const runDir=join(stage,'weekly-8V6p06');
  const manifest=JSON.parse(await readFile(new URL('../../weekly-report-source/validation/weekly-8V6p06/manifest.json',import.meta.url),'utf8'));
  manifest.runDir=runDir;
  manifest.markdown.absolutePath=join(runDir,manifest.markdown.path);
  for(const asset of manifest.assets)asset.absolutePath=join(runDir,asset.path);
  const {call,core}=await setup(t,{source:{generate:async()=>manifest},sourceOutputRoot:stage});
  const d=await call('generate',{variety:'锡'});assert.equal(d.assets.length,4);assert.ok(d.markdown.includes('asset:'));assert.ok(!JSON.stringify(d).includes(stage));
  const internal=await core.getDraft({sessionId:'s1',reportId:d.reportId});assert.equal(internal.markers[0].generator.upstreamVersion,'0.1.5');
  for(const a of internal.assets)assert.equal(hash(await readFile(a.path)),a.sha256);
});
test('per-session prompt templates: save/list/delete round-trip via dispatch; isolated per session',async t=>{
  const {call,core,api}=await setup(t);
  assert.deepEqual((await call('templateList')).templates,[]);
  const saved=await call('templateSave',{name:'默认综合分析',content:'## 风险提示\n- a'});
  assert.ok(saved.template.id); assert.equal(saved.template.name,'默认综合分析'); assert.equal(saved.template.content,'## 风险提示\n- a');
  const listed=await call('templateList');
  assert.equal(listed.templates.length,1); assert.equal(listed.templates[0].id,saved.template.id);
  // Update same id, then delete.
  const updated=await call('templateSave',{id:saved.template.id,name:'改名',content:'## 风险提示\n- b'});
  assert.equal(updated.template.id,saved.template.id); assert.equal(updated.template.name,'改名');
  // Delete a missing id returns false; the real id returns true.
  assert.equal((await call('templateDelete',{id:'nope'})).deleted,false);
  const d=await call('templateDelete',{id:saved.template.id});
  assert.equal(d.deleted,true); assert.deepEqual((await call('templateList')).templates,[]);
});
test('LLM context overflow surfaces a clear actionable warning, not a generic failure', async t => {
  const sourceOutputRoot=await mkdtemp(join(tmpdir(),'run19-overflow-'));t.after(()=>rm(sourceOutputRoot,{recursive:true,force:true}));
  const runDir=join(sourceOutputRoot,'w');await mkdir(runDir);const md=Buffer.from('# T');await writeFile(join(runDir,'report.md'),md);
  const source={async generate(){return {runDir,title:'T',markdown:{path:'report.md',sha256:hash(md)},assets:[],sourceMeta:{dataSummary:'锡价 425,770'}};}};
  const fakeLlm={async *stream(){throw new Error("This model's maximum context length is 128000 tokens");}};
  const defaultModel={currentSelection:()=>({provider:'p',model:'m'})};
  const {call}=await setup(t,{source,sourceOutputRoot,getLlm:fakeLlm,getDefaultModel:defaultModel});
  const d=await call('generate',{variety:'锡',analysisPrompt:'近四周周报综合分析'});
  assert.ok(d.warnings.includes('LLM_SYNTHESIS_CONTEXT_OVERFLOW'));
  assert.ok(!d.warnings.includes('LLM_SYNTHESIS_FAILED'));
  // A non-context error still maps to the generic failure code.
  const fakeLlm2={async *stream(){throw new Error('network exploded');}};
  const {call:call2}=await setup(t,{source,sourceOutputRoot,getLlm:fakeLlm2,getDefaultModel:defaultModel});
  const e=await call2('generate',{variety:'锡',analysisPrompt:'近四周周报综合分析'});
  assert.ok(e.warnings.includes('LLM_SYNTHESIS_FAILED'));
});
test('wantHistory honors explicit negative intent: "不对比/不参考历史" pull no past reports; a real history ask does', async t => {
  const sourceOutputRoot=await mkdtemp(join(tmpdir(),'run19-wanthistory-'));t.after(()=>rm(sourceOutputRoot,{recursive:true,force:true}));
  const runDir=join(sourceOutputRoot,'w');await mkdir(runDir);const md=Buffer.from('# T');await writeFile(join(runDir,'report.md'),md);
  const source={async generate(){return {runDir,title:'T',markdown:{path:'report.md',sha256:hash(md)},assets:[],sourceMeta:{dataSummary:'锡价 425,770'}};}};
  const {call,connector}=await setup(t,{source,sourceOutputRoot});
  let searchCount=0; connector.search=async()=>{searchCount++;return {ok:true,data:{data:[{id:'r',knowledge_id:'k',knowledge_title:'周报.pdf',content:'x'}]}};};
  // User explicitly declines history/comparison -> must NOT retrieve past reports.
  const a=await call('generate',{variety:'锡',analysisPrompt:'只做本周多空分析，不参考历史周报，不做连续四周对比'});
  assert.equal(searchCount,0);assert.ok(!a.warnings.some(w=>String(w).includes('KNOWLEDGE_RETRIEVED')));
  // User explicitly asks for historical continuity -> retrieves.
  const b=await call('generate',{variety:'锡',analysisPrompt:'结合近四周同品类周报做连贯性分析'});
  assert.equal(searchCount,1);assert.ok(b.warnings.includes('KNOWLEDGE_RETRIEVED'));
});
