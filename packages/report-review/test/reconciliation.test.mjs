import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReportStore} from '../../report-core/src/index.mjs';
import {createReviewHost} from '../src/index.mjs';
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'run19-reconcile-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const core=new ReportStore({rootDir:root});const d=await core.createDraft({sessionId:'s1',title:'fixture',markdown:'# fixture'});
 const b={sessionId:'s1',reportId:d.reportId};const v=await core.confirm({...b,saveToken:d.saveToken,author:{authorId:'u1',displayName:'fixture'}});
 const calls=[];let writes=0;const connector={status:async(kb,id)=>{calls.push([kb,id]);return {ok:true,data:{id,knowledge_base_id:kb,parse_status:'completed',summary_status:'pending',pending_subtasks_count:2,secret:'/Users/secret'}};},search(){throw Error('must not search');},createReviewHost(){writes++;throw Error('must not write');},async identity(){return {verified:true,credentialPurpose:'publish',principal:{userId:'u1',username:'fixture'}};}};
 const make=()=>createReviewHost({core:new ReportStore({rootDir:root}),pdf:{},sessions:{get:id=>['s1','s2'].includes(id)?{id}:undefined},getConnector:()=>connector},{publishKbId:'kb1'});
 const plan=async(phase,remote)=>{const p=await core.savePublicationPlan({...b,versionId:v.versionId,target:'kb1',payload:{secret:'not public'}});await core.recordPublication({...b,planId:p.planId,status:'failed',details:{phase,remote,secret:'private'}});return p;};
 return {core,b,v,calls,connector,make,plan,writes:()=>writes};
}
test('restart reconciles durable known IDs read-only; completed is parseReady not published',async t=>{
 const f=await fixture(t);const p=await f.plan('submitted',{id:'remote1',knowledge_base_id:'kb1'});const first=f.make();first.dispose();const api=f.make();t.after(()=>api.dispose());
 const before=await api.dispatchHuman({...f.b,action:'publicationStatus'});assert.equal(f.calls.length,0);assert.equal(before.records[0].phase,'submitted');
 const value=await api.dispatchHuman({...f.b,action:'reconcile',planId:p.planId});assert.deepEqual(f.calls,[['kb1','remote1']]);const row=value.records[0];assert.equal(row.parseReady,true);assert.equal(row.published,false);assert.equal(row.indexingVerified,false);assert.equal(row.phase,'submitted');assert.ok(row.warnings.includes('SUMMARY_OR_SUBTASKS_PENDING'));assert.ok(!JSON.stringify(value).includes('secret'));
 const record=(await f.core.listPublicationRecords(f.b)).at(-1);assert.equal(record.status,'failed');assert.equal(record.details.phase,'submitted');
 await assert.rejects(api.dispatchHuman({...f.b,action:'publishPlan',versionId:f.v.versionId}),{code:'PUBLICATION_RECONCILIATION_REQUIRED'});assert.equal(f.writes(),0);
 const after=f.make();t.after(()=>after.dispose());assert.equal((await after.dispatchHuman({...f.b,action:'publicationStatus'})).records[0].parseReady,true);
});
test('wrong session and caller remote override rejected without connector access',async t=>{
 const f=await fixture(t);await f.plan('submitted',{id:'remote1'});const api=f.make();t.after(()=>api.dispose());
 await assert.rejects(api.dispatchHuman({...f.b,sessionId:'s2',action:'reconcile'}),{code:'NOT_FOUND'});
 await assert.rejects(api.dispatchHuman({...f.b,action:'reconcile',remoteId:'evil'}),{code:'INVALID_INPUT'});
 await assert.rejects(api.dispatchHuman({...f.b,action:'reconcile',planId:'absent'}),{code:'NOT_FOUND'});assert.equal(f.calls.length,0);assert.equal(f.writes(),0);
});
test('executing or unknown without ID stays unknown; no title guessing or retry',async t=>{
 const f=await fixture(t);await f.plan('executing',{});await f.plan('unknown',{});const api=f.make();t.after(()=>api.dispose());
 const result=await api.dispatchHuman({...f.b,action:'reconcile'});assert.equal(result.records.length,2);for(const r of result.records){assert.equal(r.phase,'unknown');assert.equal(r.outcomeUnknown,true);assert.match(r.message,/manual reconciliation/);assert.equal(r.parseReady,false);}assert.equal(f.calls.length,0);assert.equal(f.writes(),0);
});
test('network errors and scope mismatch are sanitized and never retry remote writes',async t=>{
 const f=await fixture(t);await f.plan('submitted',{id:'remote1',knowledge_base_id:'kb1'});let attempts=0;f.connector.status=async()=>{attempts++;throw Error('/Users/private secret');};const api=f.make();t.after(()=>api.dispose());
 const r=await api.dispatchHuman({...f.b,action:'reconcile'});assert.equal(attempts,1);assert.equal(r.records[0].phase,'submitted');assert.equal(r.records[0].parseReady,false);assert.ok(!JSON.stringify(r).includes('/Users'));assert.equal(f.writes(),0);
 f.connector.status=async()=>({ok:true,data:{id:'different',knowledge_base_id:'kb1',parse_status:'completed'}});
 const mismatch=await api.dispatchHuman({...f.b,action:'reconcile'});assert.equal(mismatch.records[0].parseReady,false);assert.equal(mismatch.records[0].published,false);assert.equal(f.writes(),0);
});
