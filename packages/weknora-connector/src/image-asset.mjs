import {openSync,closeSync,fstatSync,readSync,realpathSync,constants} from 'node:fs';
import {isAbsolute,relative,sep} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
export const validResourcePath = value => typeof value==='string' && /^resource:\/\/[A-Za-z0-9_-]{22}$/.test(value);
const inside=(root,file)=>{const r=relative(root,file);return r!=='' && r!=='..' && !r.startsWith('..'+sep) && !isAbsolute(r);};
export function snapshotImage(config,request) {
 let fd;
 try {
  if(!config.assetRoots?.length)return {ok:false,error:'image_roots_not_configured'};
  if(typeof request.path!=='string'||!isAbsolute(request.path)||request.path.includes('\0')||typeof request.sha256!=='string'||!/^[a-f0-9]{64}$/.test(request.sha256))return {ok:false,error:'invalid_asset'};
  const actual=realpathSync(request.path),roots=config.assetRoots.map(r=>realpathSync(r));
  if(!roots.some(r=>inside(r,actual)))return {ok:false,error:'asset_outside_roots'};
  fd=openSync(request.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=fstatSync(fd);
  if(!before.isFile()||before.size<8||before.size>10*1024*1024)return {ok:false,error:'invalid_image_size'};
  // Re-resolve after opening and compare the actual target with the open inode.
  const afterPath=realpathSync(request.path);
  if(afterPath!==actual)return {ok:false,error:'asset_changed'};
  let check;try{check=openSync(afterPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const s=fstatSync(check);if(s.dev!==before.dev||s.ino!==before.ino)return {ok:false,error:'asset_changed'};}finally{if(check!==undefined)closeSync(check);}
  const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)return {ok:false,error:'asset_changed'};offset+=n;}
  const extra=Buffer.alloc(1);if(readSync(fd,extra,0,1,offset)!==0)return {ok:false,error:'asset_changed'};
  const after=fstatSync(fd);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)return {ok:false,error:'asset_changed'};
  if(createHash('sha256').update(bytes).digest('hex')!==request.sha256)return {ok:false,error:'asset_hash_mismatch'};
  let mime,extension;
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){mime='image/png';extension='png';}
  else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255){mime='image/jpeg';extension='jpg';}
  else return {ok:false,error:'unsupported_image_magic'};
  return {ok:true,bytes,mime,extension};
 }catch{return {ok:false,error:'asset_unavailable'};}finally{if(fd!==undefined)closeSync(fd);}
}
export function imageMultipart(r) {
 const boundary='run19-'+randomBytes(24).toString('hex');
 const parts=[];const field=(name,value)=>parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
 const fileName=/\.(png|jpe?g)$/i.test(r.title)?r.title:`${r.title}.${r.extension}`;
 field('fileName',fileName);field('tag_ids',(r.tagIds??[]).join(','));field('channel','api');
 parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${r.extension}"\r\nContent-Type: ${r.mime}\r\n\r\n`),r.bytes,Buffer.from(`\r\n--${boundary}--\r\n`));
 return {payload:Buffer.concat(parts),contentType:`multipart/form-data; boundary=${boundary}`};
}
/** Snapshot a rendered PDF for publication via /knowledge/file. Mirrors snapshotImage's safe-open/hash checks. */
export function snapshotPdf(config,request) {
 let fd;
 try {
  if(!config.assetRoots?.length)return {ok:false,error:'pdf_roots_not_configured'};
  if(typeof request.path!=='string'||!isAbsolute(request.path)||request.path.includes('\0'))return {ok:false,error:'invalid_asset'};
  const actual=realpathSync(request.path),roots=config.assetRoots.map(r=>realpathSync(r));
  if(!roots.some(r=>inside(r,actual)))return {ok:false,error:'asset_outside_roots'};
  fd=openSync(request.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=fstatSync(fd);
  if(!before.isFile()||before.size<8||before.size>20*1024*1024)return {ok:false,error:'invalid_pdf_size'};
  const afterPath=realpathSync(request.path);
  if(afterPath!==actual)return {ok:false,error:'asset_changed'};
  const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)return {ok:false,error:'asset_changed'};offset+=n;}
  const extra=Buffer.alloc(1);if(readSync(fd,extra,0,1,offset)!==0)return {ok:false,error:'asset_changed'};
  const after=fstatSync(fd);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)return {ok:false,error:'asset_changed'};
  if(!(bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&bytes[3]===0x46))return {ok:false,error:'unsupported_pdf_magic'};
  return {ok:true,bytes,mime:'application/pdf',extension:'pdf',sha256:createHash('sha256').update(bytes).digest('hex')};
 }catch{return {ok:false,error:'asset_unavailable'};}finally{if(fd!==undefined)closeSync(fd);}
}
export function pdfMultipart(r) {
 const boundary='run19-'+randomBytes(24).toString('hex');
 const parts=[];const field=(name,value)=>parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
 const fileName=/\.pdf$/i.test(r.title)?r.title:`${r.title}.pdf`;
 field('fileName',fileName);field('tag_ids',(r.tagIds??[]).join(','));field('channel','api');
 parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="report.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),r.bytes,Buffer.from(`\r\n--${boundary}--\r\n`));
 return {payload:Buffer.concat(parts),contentType:`multipart/form-data; boundary=${boundary}`};
}
