import test from 'node:test';
import assert from 'node:assert/strict';
import {draftView} from '../src/index.mjs';
test('persisted generation warning codes survive draft reload without exposing marker payload',()=>{
 const data=draftView({reportId:'r1',markdown:'# Body',markers:[{kind:'source_provenance',secret:'private',reviewGeneration:{warnings:['KNOWLEDGE_VERSION_FILTER_NOT_IMPLEMENTED','KNOWLEDGE_EXCERPTS_ARE_UNVERIFIED','/Users/private/secret','KNOWLEDGE_VERSION_FILTER_NOT_IMPLEMENTED']}}],annotations:[]});
 assert.deepEqual(data.warnings,['KNOWLEDGE_VERSION_FILTER_NOT_IMPLEMENTED','KNOWLEDGE_EXCERPTS_ARE_UNVERIFIED']);
 assert.equal('markers' in data,false); assert.ok(!JSON.stringify(data).includes('/Users'));
});
