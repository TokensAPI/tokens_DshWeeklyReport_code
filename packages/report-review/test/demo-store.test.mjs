import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApi, DEMO_STORAGE_KEY } from '../src/demo-api.mjs';

test('demo store: persistence, concurrency, immutable versions and one-shot simulated publication', async () => {
  const data = new Map([['production', 'keep']]);
  const storage = { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v) };
  const a = createDemoApi(storage), b = createDemoApi(storage);
  const draft = (await a('list')).reports[0];
  const saved = await a('save', { reportId:draft.reportId, saveToken:draft.saveToken, markdown:'# 人工判断' });
  await assert.rejects(b('save', {reportId:draft.reportId,saveToken:draft.saveToken,markdown:'stale'}), {code:'SAVE_CONFLICT'});
  const confirmed = await a('confirm', {reportId:saved.reportId,saveToken:saved.saveToken});
  const frozen = await b('get', {reportId:saved.reportId});
  await assert.rejects(a('save', {reportId:frozen.reportId,saveToken:frozen.saveToken,markdown:'replace'}), {code:'READ_ONLY'});
  const plan = await a('publishPlan', {reportId:frozen.reportId,versionId:confirmed.versionId});
  await assert.rejects(a('publish', {reportId:frozen.reportId,...plan,userInitiated:false}), {code:'INVALID_PLAN'});
  await a('publish', {reportId:frozen.reportId,...plan,userInitiated:true});
  await assert.rejects(a('publish', {reportId:frozen.reportId,...plan,userInitiated:true}), {code:'INVALID_PLAN'});
  assert.equal((await a('reconcile',{reportId:frozen.reportId})).records.length,1);
  const revision = await a('startRevision',{reportId:frozen.reportId,saveToken:frozen.saveToken});
  await a('save',{reportId:revision.reportId,saveToken:revision.saveToken,markdown:'new version'});
  assert.equal((await b('versions',{reportId:revision.reportId})).versions[0].markdown,'# 人工判断');
  assert.equal(data.get('production'),'keep');
  assert.ok(data.has(DEMO_STORAGE_KEY));
});

