import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
// Principal (author) ids come from /auth/me and may be platform key users like
// `api_platform:9`; accept safe printable ASCII here without weakening resource/id checks.
const principalIdOK = value => typeof value === 'string' && value.length >= 1 && value.length <= 160 && /^[\x21-\x7e]+$/.test(value) && !value.includes('\x00');
const hashOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value, max = 1000000) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const freeze = value => { if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; };
const prepared = new WeakSet();
const escapeMetadata = value => value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');
const sourceKinds = new Set(['user_direct','user_prompt']);
const categories = new Set(['supplement','correction','retraction','judgment']);
// WeKnora internal/types/resource.go: ResourceHandleLength=22, ParseResourcePath.
const resourceOK = value => typeof value === 'string' && /^resource:\/\/[A-Za-z0-9_-]{22}$/.test(value);
function safeMarkdown(value) {
  if (!text(value) || /<\/?[A-Za-z][^>]*>|data\s*:|file\s*:|resource:\/\//i.test(value)) fail('UNSUPPORTED_PUBLIC_MARKDOWN');
}
function dateLabel(value) {
  if (!text(value, 64) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_PUBLIC_SOURCE_TIME');
  return value.slice(0,16).replace('T','-').replace(':','-');
}
function attribution(value) {
  if (!principalIdOK(value?.authorId) || !text(value?.displayName,256) || !value.displayName.trim() || /[\r\n<>]/.test(value.displayName)) fail('INVALID_PUBLIC_AUTHOR');
  return {authorId:value.authorId,displayName:value.displayName,completedAt:value.completedAt,date:dateLabel(value.completedAt)};
}
/** The leading commodity/variety: a CJK run that stops before a report-type word (周报/月报/日报/…), a non-CJK
 * separator (space/`-`/`：`…), or end. This keeps `锡周报`→`锡` and `碳酸锂周报`→`碳酸锂` correct, instead of over-capturing. */
export function deriveVariety(title) {
  const t = String(title || '').trim();
  return /^([\u4e00-\u9fa5]+?)(?=周报|月报|日报|周度|月度|报告|纪要|[^一-龥]|$)/.exec(t)?.[1] || t.slice(0, 12);
}
/** Standard report title/filename: `商品-报告类型-日期` (e.g. 锡-周报-2026-09-09). Images append the caption. */
function stdReportName(title) {
  const t = String(title || '').trim();
  const variety = deriveVariety(t);
  const date = /（(\d{4}-\d{2}-\d{2})）|(\d{4}-\d{2}-\d{2})/.exec(t)?.[1] || '';
  return `${variety}-周报${date ? '-' + date : ''}`;
}
function footer(sources) {
  const seen=new Set(), lines=[];
  for (const s of sources) {
    const a=attribution(s), key=`${a.authorId}\0${a.completedAt}`;
    if(seen.has(key))continue;seen.add(key);
    lines.push(`人工注释来源（来自${a.date} 用户${escapeMetadata(a.displayName)}）`);
  }
  return lines.length ? '\n\n---\n\n'+lines.join('\n\n')+'\n\n说明：人工修订来源见上；WeKnora 远端加粗及下划线显示尚待验证。\n' : '';
}
/** Pure preparation: accepts core.exportVersion output; does not read asset files or execute publication. */
export function preparePublicationManifest(version,{kbId}={}) {
  if(!idOK(kbId)||!idOK(version?.reportId)||!/^V[1-9]\d*$/.test(version?.versionId)||!text(version?.title,512)||!version.title.trim()||/[\r\n<>]/.test(version.title))fail('INVALID_PUBLIC_VERSION');
  safeMarkdown(version.markdown);
  if(!Array.isArray(version.assets)||!Array.isArray(version.humanItems??[])||!Array.isArray(version.annotations??[]))fail('INVALID_PUBLIC_VERSION');
  const assets=new Map();
  for(const a of version.assets){if(!idOK(a?.id)||!hashOK(a?.sha256)||assets.has(a.id))fail('INVALID_OR_DUPLICATE_ASSET');assets.set(a.id,{id:a.id,sha256:a.sha256});}
  const references=[],captions=new Map();
  const imageRE=/!\[([^\]\r\n]*)\]\(asset:([A-Za-z0-9_-]{1,160})\)/g;
  const remainder=version.markdown.replace(imageRE,(match,caption,id)=>{
    if(!assets.has(id))fail('UNREGISTERED_ASSET');
    caption=caption.trim();if(!caption||caption.length>256||/[<>\\]/.test(caption))fail('INVALID_IMAGE_CAPTION');
    if(captions.has(id)&&captions.get(id)!==caption)fail('AMBIGUOUS_ASSET_CAPTION');
    if(!captions.has(id)){captions.set(id,caption);references.push(id);}return '';
  });
  if(/!\s*\[|asset:/i.test(remainder))fail('UNSUPPORTED_ASSET_REFERENCE');
  if(references.length!==assets.size)fail('UNREFERENCED_ASSET');
  const title=stdReportName(version.title),items=[];
  references.forEach((id,index)=>{const a=assets.get(id);items.push({key:`image:${id}`,type:'image',assetId:id,sha256:a.sha256,hash:a.sha256,title:`${title}-${captions.get(id)}`,caption:captions.get(id),index:index+1});});
  const sources=[];
  for(const a of version.annotations??[]){if(a?.public!==true||!sourceKinds.has(a.source)||a.mappingConfidence==='low')continue;const at=attribution(a);sources.push(at);}
  const human=[],humanIds=new Set();
  for(const h of version.humanItems??[]){
    if(!idOK(h?.id)||!idOK(h.annotationId)||humanIds.has(h.id)||!categories.has(h.category)||!sourceKinds.has(h.source)||!text(h.content)||!h.content.trim())fail('INVALID_HUMAN_ITEM');
    if(h.visibility==='local'||h.selected===false||h.public===false)fail('PRIVATE_HUMAN_ITEM');
    safeMarkdown(h.content);if(/!\s*\[|asset:/i.test(h.content))fail('HUMAN_ITEM_ASSET_UNSUPPORTED');
    if(!version.markdown.includes(h.content))fail('HUMAN_CONTENT_NOT_IN_VERSION');
    const linked=(version.annotations??[]).find(a=>a.id===h.annotationId&&a.public===true&&a.source===h.source&&a.target?.quote===h.content&&a.mappingConfidence!=='low');
    if(!linked||linked.authorId!==h.authorId||linked.displayName!==h.displayName||linked.completedAt!==h.completedAt)fail('HUMAN_ANNOTATION_MISMATCH');
    const at=attribution(h);sources.push(at);humanIds.add(h.id);
    if(h.publicSource!==undefined){safeMarkdown(h.publicSource);if(h.publicSource.length>8192||/!\s*\[|asset:/i.test(h.publicSource))fail('INVALID_PUBLIC_SOURCE');}
    const owned={id:h.id,annotationId:h.annotationId,reportId:version.reportId,versionId:version.versionId,category:h.category,source:h.source,content:h.content,authorId:at.authorId,displayName:at.displayName,completedAt:at.completedAt,...(h.publicSource===undefined?{}:{publicSource:h.publicSource})};
    const markdown=`# ${escapeMetadata(title)} - 人工信息 - ${escapeMetadata(h.id)}\n\n${h.content}\n\n报告：${version.reportId} / ${version.versionId}\n\n修订：${h.annotationId}\n\n类别：${h.category}\n\n来源方式：${h.source}${h.publicSource?'\n\n公开来源：'+escapeMetadata(h.publicSource):''}${footer([at])}`;
    human.push({key:`human:${h.id}`,type:'human',title:`${title} - 人工信息 - ${h.id}`,hash:sha(JSON.stringify(owned)),human:owned,markdown});
  }
  const markdown=version.markdown+footer(sources);
  items.push({key:`report:${version.reportId}:${version.versionId}`,type:'report',title,hash:sha(markdown),markdown,reportId:version.reportId,versionId:version.versionId});
  items.push({key:`pdf:${version.reportId}:${version.versionId}`,type:'pdf',title,hash:sha(markdown),reportId:version.reportId,versionId:version.versionId});
  items.push(...human);
  const plan={reportId:version.reportId,versionId:version.versionId,target:kbId,title,items,warnings:['REMOTE_HUMAN_STYLE_NOT_VERIFIED','IMAGE_RESOURCE_BINDING_AND_RENDERING_NOT_VERIFIED','PREPARATION_ONLY_NO_UPLOAD']};
  const result=freeze({...plan,digest:sha(JSON.stringify(plan))});prepared.add(result);return result;
}
/** Resolve only an in-process prepared manifest; after restart reprepare from frozen public version. */
export function resolvePublicationMarkdown(manifest,bindings) {
  if(!prepared.has(manifest)||!Array.isArray(bindings))fail('UNTRUSTED_MANIFEST');
  const images=manifest.items.filter(i=>i.type==='image'),map=new Map();
  for(const b of bindings){
    if(!b||Object.keys(b).some(k=>!['assetId','sha256','kbId','resourceUri','knowledgeId'].includes(k))||!idOK(b.assetId)||!hashOK(b.sha256)||b.kbId!==manifest.target||!resourceOK(b.resourceUri)||!idOK(b.knowledgeId)||map.has(b.assetId))fail('INVALID_RESOURCE_BINDING');
    const a=images.find(i=>i.assetId===b.assetId);if(!a||a.sha256!==b.sha256)fail('RESOURCE_BINDING_MISMATCH');map.set(b.assetId,b.resourceUri);
  }
  if(map.size!==images.length)fail('INCOMPLETE_RESOURCE_BINDINGS');
  const markdown=manifest.items.find(i=>i.type==='report').markdown;
  return markdown.replace(/(!\[[^\]\r\n]*\]\()asset:([A-Za-z0-9_-]{1,160})(\))/g,(_m,start,id,end)=>start+map.get(id)+end);
}
