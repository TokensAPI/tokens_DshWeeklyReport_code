// Original Node implementation of the read contract; no development-tree source dependency.
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
const fields = {
 detail: ['id','knowledge_base_id','title','type','parse_status','summary_status','enable_status','pending_subtasks_count','created_at','updated_at','processed_at'],
 chunks: ['id','knowledge_id','content','chunk_index','chunk_type','start_at','end_at','is_enabled','content_revision','last_editor_id','index_status'],
 search: ['id','knowledge_id','knowledge_base_id','knowledge_title','content','score','match_type','chunk_index','chunk_type','start_at','end_at'],
 list: ['id','knowledge_base_id','title','folder_path','type','source','channel','parse_status','enable_status','created_at','updated_at']
};
const failure = error => ({ok:false,error,outcome_unknown:false,automatic_retry:false});
const integer = (x,min,max) => Number.isSafeInteger(x) && x>=min && x<=max;
export async function readHttp(config, command, args, signal) {
 if(signal?.aborted) return failure('cancelled');
 let handle,key;
 try {
  const before=await lstat(config.readSecretFile);
  if(!before.isFile() || before.isSymbolicLink())return failure('unsafe_secret_file');
  handle=await open(config.readSecretFile,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const s=await handle.stat();
  const posixOwnerUnsafe=typeof process.getuid==='function' && ((s.mode&0o077) || s.uid!==process.getuid());
  if(!s.isFile() || s.dev!==before.dev || s.ino!==before.ino || posixOwnerUnsafe || s.size>4096) return failure('unsafe_secret_file');
  const bytes=Buffer.alloc(4097),r=await handle.read(bytes,0,bytes.length,0);
  key=bytes.subarray(0,r.bytesRead).toString('latin1').replace(/[\r\n]+$/,'');
  if(!key || key.length>4096 || /[^\x21-\x7e]/.test(key))return failure('invalid_secret');
 }catch{return failure('secret_unavailable');}finally{await handle?.close();}
 const project=(row,type)=>Object.fromEntries(fields[type].filter(f=>row[f]===null || ['string','boolean'].includes(typeof row[f]) || (typeof row[f]==='number' && Number.isFinite(row[f]))).map(f=>[f,typeof row[f]==='string'?row[f].split(key).join('[REDACTED]'):row[f]]));
 const request=(method,path,payload)=>new Promise(resolve=>{
  let done=false,timer; const finish=v=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(v);};
  const url=new URL('/api/v1'+path,config.baseUrl),body=payload===undefined?null:Buffer.from(JSON.stringify(payload));
  if(body?.length>1024*1024)return resolve(failure('request_too_large'));
  const req=(url.protocol==='https:'?https:http).request(url,{method,agent:false,headers:{'X-API-Key':key,Accept:'application/json','Accept-Encoding':'identity','Content-Type':'application/json',...(config.tenantId?{'X-Tenant-ID':config.tenantId}:{}),...(body?{'Content-Length':body.length}:{})}},res=>{
   if(res.statusCode<200 || res.statusCode>=300){res.destroy();return finish(failure(res.statusCode>=300 && res.statusCode<400?'redirect_rejected':({400:'bad_request',401:'unauthorized',403:'forbidden',404:'not_found',409:'conflict',413:'request_too_large',422:'bad_request',429:'rate_limited'}[res.statusCode]??'server_error')));}
   if((res.headers['content-encoding']??'identity').toLowerCase()!=='identity'){res.destroy();return finish(failure('unsupported_encoding'));}
   const chunks=[];let size=0;
   res.on('data',b=>{size+=b.length;if(size>2*1024*1024){res.destroy();finish(failure('response_too_large'));}else chunks.push(b);});
   res.on('error',()=>finish(failure('transport_error')));
   res.on('end',()=>{try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!value || value.success!==true || !('data'in value))throw Error();finish({ok:true,value});}catch{finish(failure('invalid_response'));}});
  });
  const abort=()=>{req.destroy();finish(failure('cancelled'));};
  req.on('error',()=>finish(failure('transport_error')));
  timer=setTimeout(()=>{req.destroy();finish(failure('timeout'));},config.timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();else req.end(body);
 });
 let kb,doc,count,page,pageSize,knowledgeIds,folderPath,keyword,startTime,endTime,recursive;
 const sep=args.indexOf('--');
 const pre=sep===-1?args.slice():args.slice(0,sep);
 const post=sep===-1?[]:args.slice(sep+1);
 const flag=n=>{for(const a of pre){if(a.startsWith(n+'='))return a.slice(n.length+1);}return undefined;};
 const has=n=>pre.includes(n);
 if(command==='search'){
  count=Number(flag('--match-count')??10);
  [kb,doc]=post; // kbId, query
  const kj=flag('--knowledge-ids'); if(kj!==undefined){try{knowledgeIds=JSON.parse(kj);}catch{knowledgeIds=undefined;}}
 } else if(command==='list'){
  kb=post.length?post[0]:args[0];
  folderPath=flag('--folder-path'); keyword=flag('--keyword'); startTime=flag('--start-time'); endTime=flag('--end-time');
  recursive=has('--recursive');
  page=Number(flag('--page')??1); pageSize=Number(flag('--page-size')??100);
 } else {
  [kb,doc]=args; if(command==='chunks'){page=Number(args[2].split('=')[1]);pageSize=Number(args[3].split('=')[1]);}
 }
 let result,rows,value;
 if(command!=='search' && command!=='list'){
  const parent=await request('GET',`/knowledge/${doc}`);if(!parent.ok)return parent;
  const row=parent.value.data;if(!row || row.id!==doc || row.knowledge_base_id!==kb)return failure('response_scope_mismatch');
  if(command==='detail')return {ok:true,data:project(row,'detail')};
  result=await request('GET',`/chunks/${doc}?page=${page}&page_size=${pageSize}`);
  if(!result.ok)return result; value=result.value; rows=value.data;
  if(!Array.isArray(rows))return failure('invalid_response');
  if(rows.some(r=>!r || typeof r!=='object' || Array.isArray(r) || r.knowledge_id!==doc))return failure('response_scope_mismatch');
  if(rows.length>pageSize || !integer(value.page,1,1000000) || value.page!==page || !integer(value.page_size,1,100) || value.page_size!==pageSize || !integer(value.total,0,1e12))return failure('invalid_response');
  return {ok:true,data:{knowledge_base_id:kb,knowledge_id:doc,page:value.page,page_size:value.page_size,total:value.total,data:rows.slice(0,pageSize).map(r=>project(r,'chunks'))}};
 }
 if(command==='search'){
  const body={query_text:doc,match_count:count}; if(Array.isArray(knowledgeIds)&&knowledgeIds.length)body.knowledge_ids=knowledgeIds;
  result=await request('POST',`/knowledge-bases/${kb}/hybrid-search?resource_urls=handle`,body);
  if(!result.ok)return result; value=result.value; rows=value.data;
  if(!Array.isArray(rows))return failure('invalid_response');
  if(rows.some(r=>!r || typeof r!=='object' || Array.isArray(r) || ![undefined,null,'',kb].includes(r.knowledge_base_id)))return failure('response_scope_mismatch');
  return {ok:true,data:{knowledge_base_id:kb,data:rows.slice(0,count).map(r=>project(r,'search'))}};
 }
 // command==='list'
 const qs=new URLSearchParams();
 if(folderPath!==undefined)qs.set('folder_path',folderPath);
 if(recursive)qs.set('folder_recursive','true');
 if(keyword!==undefined)qs.set('keyword',keyword);
 if(startTime!==undefined)qs.set('start_time',startTime);
 if(endTime!==undefined)qs.set('end_time',endTime);
 qs.set('page',String(page)); qs.set('page_size',String(pageSize));
 result=await request('GET',`/knowledge-bases/${kb}/knowledge?${qs.toString()}`);
 if(!result.ok)return result; value=result.value;
 if(!Array.isArray(value.data) || !integer(value.total,0,1e12) || !integer(value.page,1,1000000) || !integer(value.page_size,1,1000))return failure('invalid_response');
 if(value.data.some(r=>!r || typeof r!=='object' || Array.isArray(r) || ![undefined,null,'',kb].includes(r.knowledge_base_id)))return failure('response_scope_mismatch');
 return {ok:true,data:{knowledge_base_id:kb,total:value.total,page:value.page,page_size:value.page_size,data:value.data.slice(0,pageSize).map(r=>project(r,'list'))}};
}
