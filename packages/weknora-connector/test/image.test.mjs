import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {Connector} from '../src/index.mjs';
import {validResourcePath} from '../src/image-asset.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const png=Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex');
test('publishImage frozen bytes multipart capability and fail-closed response contract',async()=>{
 const root=await mkdtemp(join(tmpdir(),'run19-image-'));let mode='ok';const calls=[];
 const handle='aB_09-z'.padEnd(22,'x');
 const server=http.createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);calls.push({url:req.url,headers:req.headers,body:Buffer.concat(chunks)});if(mode==='hang')return;if(mode==='redirect'){res.writeHead(302,{location:'http://127.0.0.1:1/forbidden'});res.end();return;}if(mode==='503'){res.writeHead(503);res.end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data:{id:'image1',knowledge_base_id:mode==='scope'?'other':'kb',file_path:mode==='badresource'?'resource://too-short':mode==='local'?'/tmp/image.png':`resource://${handle}`,parse_status:'pending',secret:'never project'}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const assets=join(root,'assets');await mkdir(assets);const path=join(assets,'hash');await writeFile(path,png);const read=join(root,'read.key'),write=join(root,'write.key');await writeFile(read,'fake-read',{mode:0o600});await writeFile(write,'fake-write',{mode:0o600});
  const config={baseUrl:`http://127.0.0.1:${server.address().port}`,readSecretFile:read,writeSecretFile:write,allowedKbs:['kb'],assetRoots:[assets],timeoutMs:100};const c=new Connector(config),port=c.createReviewHost();
  const req={operation:'publishImage',kbId:'kb',title:'报告 V1 - 1 图表',path,sha256:hash(png),tagIds:['charts']};
  assert.equal(c.capabilities().images,false);assert.equal(c.capabilities().imageUploadConfigured,true);
  assert.equal(new Connector({...config,assetRoots:undefined}).createReviewHost().approve(req).error,'image_roots_not_configured');
  assert.equal(port.approve({...req,kbId:'other'}).error,'invalid_arguments');assert.equal(port.approve({...req,endpoint:'/evil'}).error,'invalid_arguments');assert.equal(port.approve({...req,sha256:'0'.repeat(64)}).error,'asset_hash_mismatch');
  const outside=join(root,'outside.png');await writeFile(outside,png);assert.equal(port.approve({...req,path:outside}).error,'asset_outside_roots');
  if(process.platform!=='win32'){const linked=join(assets,'link');await symlink(path,linked);assert.equal(port.approve({...req,path:linked}).error,'asset_unavailable');}
  const cap=port.approve(req);assert.equal(cap.ok,undefined);await writeFile(path,'mutated bytes after approval');req.title='MUTATED';req.tagIds.push('injected');const result=await port.execute(cap);
  assert.equal(result.ok,true);assert.deepEqual(result.data,{id:'image1',knowledge_base_id:'kb',file_path:`resource://${handle}`,parse_status:'pending'});assert.equal(result.submitted,true);
  const sent=calls[0];assert.equal(sent.url,'/api/v1/knowledge-bases/kb/knowledge/file');assert.equal(sent.headers['x-api-key'],'fake-write');assert.match(sent.headers['content-type'],/^multipart\/form-data; boundary=run19-/);assert.ok(sent.body.includes(png));assert.ok(!sent.body.includes(Buffer.from('mutated bytes')));const text=sent.body.toString();assert.ok(text.includes('name="file"; filename="image.png"'));assert.ok(text.includes('name="fileName"'));assert.ok(text.includes('报告 V1 - 1 图表.png'));assert.ok(!text.includes('MUTATED'));assert.ok(!text.includes('injected'));assert.ok(text.includes('name="tag_ids"'));assert.ok(text.includes('name="channel"\r\n\r\napi'));
  assert.equal((await port.execute(cap)).error,'review_capability_required');assert.equal((await c.createReviewHost().execute({userConfirmed:true})).error,'review_capability_required');
  await writeFile(path,png);for(const m of ['scope','badresource','local','redirect','503','hang']){mode=m;const before=calls.length;const token=port.approve({...req,sha256:hash(png)});const r=await port.execute(token);assert.equal(r.ok,false,m);assert.equal(r.outcome_unknown,true,m);assert.equal(r.automatic_retry,false);assert.equal(calls.length,before+1,m);assert.equal((await port.execute(token)).error,'review_capability_required');}
  mode='ok';await writeFile(path,Buffer.alloc(10*1024*1024+1));assert.equal(port.approve(req).error,'invalid_image_size');await writeFile(path,Buffer.alloc(12));assert.equal(port.approve({...req,sha256:hash(Buffer.alloc(12))}).error,'unsupported_image_magic');
  const jpeg=Buffer.from([255,216,255,224,0,2,255,217]);await writeFile(path,jpeg);assert.equal((await port.execute(port.approve({...req,sha256:hash(jpeg)}))).ok,true);assert.ok(calls.at(-1).body.toString().includes('image/jpeg'));
  const detail=await port.imageDetail('kb','image1');assert.equal(detail.ok,true);assert.equal(detail.submitted,undefined);assert.equal(detail.data.file_path,`resource://${handle}`);assert.equal(calls.at(-1).url,'/api/v1/knowledge/image1');assert.equal(calls.at(-1).headers['x-api-key'],'fake-read');assert.equal((await port.imageDetail('other','image1')).error,'scope_rejected');
  assert.equal(port.approve({operation:'publishManual',kbId:'kb',title:'Report',content:`![x](resource://${handle})`}).error,'images_not_supported');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
test('resource grammar matches types ResourceHandleLength22 canonical opaque handles',()=>{assert.equal(validResourcePath('resource://'+'x'.repeat(22)),true);for(const value of ['resource://'+'x'.repeat(21),'resource://'+'x'.repeat(23),'resource://'+'x'.repeat(21)+'/', 'resource://'+'x'.repeat(22)+'?x','resource://'+ '中'.repeat(22),' resource://'+'x'.repeat(22)])assert.equal(validResourcePath(value),false);});
test('publishReport accepts canonical resource bindings and rejects arbitrary image syntax',async()=>{
 const root=await mkdtemp(join(tmpdir(),'run19-report-'));const calls=[];
 const server=http.createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);calls.push({url:req.url,body:Buffer.concat(chunks).toString()});res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data:{id:'report1',knowledge_base_id:'kb',parse_status:'pending'}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const read=join(root,'read.key'),write=join(root,'write.key');await writeFile(read,'readsecret',{mode:0o600});await writeFile(write,'writesecret',{mode:0o600});
  const c=new Connector({baseUrl:`http://127.0.0.1:${server.address().port}`,readSecretFile:read,writeSecretFile:write,allowedKbs:['kb'],timeoutMs:100}),port=c.createReviewHost();
  const uri='resource://'+'x'.repeat(22);
  const ok=port.approve({operation:'publishReport',kbId:'kb',title:'报告 V1',content:`# 报告\n\n![图](${uri})`});assert.equal(ok.ok,undefined);
  const r=await port.execute(ok);assert.equal(r.ok,true);assert.equal(r.data.id,'report1');
  const sent=calls[0];assert.equal(sent.url,'/api/v1/knowledge-bases/kb/knowledge/manual');assert.ok(sent.body.includes(uri));assert.ok(sent.body.includes('"status":"publish"'));
  assert.equal(port.approve({operation:'publishReport',kbId:'kb',title:'x',content:'![evil](https://x/evil.png)'}).error,'images_not_supported');
  assert.equal(port.approve({operation:'publishReport',kbId:'kb',title:'x',content:'![left](asset:img1)'}).error,'images_not_supported');
  assert.equal(port.approve({operation:'publishReport',kbId:'other',title:'x',content:'ok'}).error,'invalid_arguments');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
test('publishPdf uploads a rendered PDF as a file and rejects non-PDF bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'run19-pdf-'));const calls=[];
 const handle='aB_09-z'.padEnd(22,'x');
 const server=http.createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);calls.push({url:req.url,headers:req.headers,body:Buffer.concat(chunks)});res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data:{id:'pdf1',knowledge_base_id:'kb',file_path:`resource://${handle}`,parse_status:'pending'}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const assets=join(root,'assets');await mkdir(assets);
  const path=join(assets,'report.pdf');const pdf=Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');await writeFile(path,pdf);
  const read=join(root,'read.key'),write=join(root,'write.key');await writeFile(read,'fake-read',{mode:0o600});await writeFile(write,'fake-write',{mode:0o600});
  const config={baseUrl:`http://127.0.0.1:${server.address().port}`,readSecretFile:read,writeSecretFile:write,allowedKbs:['kb'],assetRoots:[assets],timeoutMs:100};const c=new Connector(config),port=c.createReviewHost();
  const req={operation:'publishPdf',kbId:'kb',title:'锡-周报-2026-09-09',path};
  assert.equal(port.approve({...req,kbId:'other'}).error,'invalid_arguments');
  const outside=join(root,'outside.pdf');await writeFile(outside,pdf);assert.equal(port.approve({...req,path:outside}).error,'asset_outside_roots');
  const bad=join(assets,'bad.pdf');await writeFile(bad,Buffer.from('not a pdf at all'));assert.equal(port.approve({...req,path:bad}).error,'unsupported_pdf_magic');
  const cap=port.approve(req);assert.equal(cap.ok,undefined);const result=await port.execute(cap);
  assert.equal(result.ok,true);assert.equal(result.data.file_path,`resource://${handle}`);assert.equal(result.submitted,true);
  const sent=calls[0];assert.equal(sent.url,'/api/v1/knowledge-bases/kb/knowledge/file');assert.equal(sent.headers['x-api-key'],'fake-write');assert.match(sent.headers['content-type'],/^multipart\/form-data; boundary=run19-/);
  const text=sent.body.toString();assert.ok(text.includes('name="file"; filename="report.pdf"'));assert.ok(text.includes('name="fileName"'));assert.ok(text.includes('锡-周报-2026-09-09.pdf'));assert.ok(sent.body.includes(pdf));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
test('publishImage reuses an existing image on conflict (idempotent re-run)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run19-reuse-'));
  const handle = 'reuse_aB'.padEnd(22, 'z');
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const b of req) chunks.push(b);
    calls.push({ url: req.url, body: Buffer.concat(chunks).toString(), key: req.headers['x-api-key'] });
    if (req.url.startsWith('/api/v1/knowledge-bases/kb/knowledge/file')) {
      res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, data: null, error: 'conflict' })); return;
    }
    if (req.url.includes('/hybrid-search')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, data: [{ id: 'existing1', knowledge_id: 'existing1', knowledge_base_id: 'kb', knowledge_title: '报告 V1 - 1 图表.png', content: 'img', score: 1, match_type: 'exact', chunk_index: 0, chunk_type: 'p' }] }));
      return;
    }
    if (req.url.startsWith('/api/v1/knowledge/existing1')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, data: { id: 'existing1', knowledge_base_id: 'kb', file_path: `resource://${handle}`, parse_status: 'completed' } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, data: null }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const assets = join(root, 'assets'); await mkdir(assets);
    const path = join(assets, 'hash'); await writeFile(path, png);
    const read = join(root, 'read.key'), write = join(root, 'write.key');
    await writeFile(read, 'read-secret', { mode: 0o600 }); await writeFile(write, 'write-secret', { mode: 0o600 });
    const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, readSecretFile: read, writeSecretFile: write, allowedKbs: ['kb'], assetRoots: [assets], timeoutMs: 100 };
    const c = new Connector(config), port = c.createReviewHost();
    const req = { operation: 'publishImage', kbId: 'kb', title: '报告 V1 - 1 图表', path, sha256: hash(png) };
    const cap = port.approve(req);
    assert.equal(cap.ok, undefined);
    const r = await port.execute(cap);
    assert.equal(r.ok, true);
    assert.equal(r.data.file_path, `resource://${handle}`);
    assert.equal(r.data.id, 'existing1');
    assert.equal(calls.find(x => x.url.includes('/knowledge/file'))?.key, 'write-secret');
    assert.equal(calls.find(x => x.url.startsWith('/api/v1/knowledge/existing1'))?.key, 'read-secret');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); }
});
