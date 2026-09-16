import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,writeFile,rm,chmod,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import http from 'node:http';
const run=(exe,args,opts={})=>new Promise((resolve,reject)=>{const p=spawn(exe,args,{...opts,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',code=>code===0?resolve(out):reject(Error(err)));});
test('tgz-shaped isolated install default Node reads in actual process; no Python/source dependency',async()=>{
 const root=await mkdtemp(join(tmpdir(),'connector-install-'));let mode='ok',calls=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;calls.push(req.url);res.setHeader('content-type','application/json');if(mode==='redirect'){res.writeHead(302,{location:'http://127.0.0.1:1/forbidden'});res.end();return;}if(mode==='encoding'){res.setHeader('content-encoding','gzip');res.end('{}');return;}if(mode==='oversize'){res.end('x'.repeat(2*1024*1024+1));return;}if(mode==='hang'){return;}const data=req.url.includes('hybrid-search')?[{id:'c',knowledge_base_id:mode==='scope'?'evil':'kb',content:'fixture-key safe',ignored:{secret:'no'}}]:req.url.includes('/chunks/')?[{id:'c',knowledge_id:mode==='scope'?'wrong':'doc',content:'text'}]:{id:'doc',knowledge_base_id:mode==='scope'?'evil':'kb',title:'fixture-key'};res.end(JSON.stringify({success:true,data,page:mode==='wrongpage'?2:1,page_size:mode==='wrongsize'?10:20,total:1}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  // Build tar payload then extract elsewhere, using exactly the package's files allowlist.
  const staging=join(root,'staging'),dest=join(root,'installed');await cp(new URL('../src',import.meta.url),join(staging,'package/src'),{recursive:true});await writeFile(join(staging,'package/package.json'),JSON.stringify({type:'module'}));await mkdir(dest,{recursive:true});await run('tar',['-czf',join(root,'module.tgz'),'-C',staging,'package']);await run('tar',['-xzf',join(root,'module.tgz'),'-C',dest]);
  const secret=join(root,'fake.key');await writeFile(secret,'fixture-key',{mode:0o600});
  const entry=pathToFileURL(join(dest,'package/src/index.mjs')).href,config={baseUrl:`http://127.0.0.1:${server.address().port}`,readSecretFile:secret,allowedKbs:['kb'],timeoutMs:150};
  const invoke=body=>run(process.execPath,['--input-type=module','-e',`import {Connector} from ${JSON.stringify(entry)};const c=new Connector(${JSON.stringify(config)});${body}`],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',PATH:'/no-python',HTTP_PROXY:'http://127.0.0.1:1'}}).then(JSON.parse);
  assert.equal((await invoke(`console.log(JSON.stringify(await c.detail('kb','doc')))`)).data.title,'[REDACTED]');
  assert.equal((await invoke(`console.log(JSON.stringify(await c.chunks('kb','doc')))`)).ok,true);
  const s=await invoke(`console.log(JSON.stringify(await c.search('kb','--secret-file=evil')))`);assert.equal(s.ok,true);assert.equal(s.data.data[0].content,'[REDACTED] safe');assert.equal(s.data.data[0].ignored,undefined);
  for(const m of ['wrongpage','wrongsize']){mode=m;assert.equal((await invoke(`console.log(JSON.stringify(await c.chunks('kb','doc')))`)).error,'invalid_response');}
  mode='scope';assert.equal((await invoke(`console.log(JSON.stringify(await c.search('kb','query')))`)).error,'response_scope_mismatch');assert.equal((await invoke(`console.log(JSON.stringify(await c.detail('kb','doc')))`)).error,'response_scope_mismatch');
  for(const [m,error]of [['redirect','redirect_rejected'],['encoding','unsupported_encoding'],['oversize','response_too_large'],['hang','timeout']]){mode=m;const before=calls.length;assert.equal((await invoke(`console.log(JSON.stringify(await c.detail('kb','doc')))`)).error,error);assert.equal(calls.length,before+1);}
  mode='ok';if(process.platform!=='win32'){await chmod(secret,0o644);assert.equal((await invoke(`console.log(JSON.stringify(await c.detail('kb','doc')))`)).error,'unsafe_secret_file');await chmod(secret,0o600);const linked=join(root,'link.key');await symlink(secret,linked);config.readSecretFile=linked;assert.equal((await invoke(`console.log(JSON.stringify(await c.detail('kb','doc')))`)).error,'secret_unavailable');config.readSecretFile=secret;}
  assert.equal((await invoke(`const a=new AbortController();a.abort();console.log(JSON.stringify(await c.detail('kb','doc',{signal:a.signal})))`)).error,'cancelled');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
