import { publicAnnotations, markdownBlocks } from './annotations.mjs';
const categories = new Set(['supplement','correction','retraction','judgment','style']);
const human = a => ['user_direct','user_prompt'].includes(a?.source) && typeof a.id === 'string' && a.id.length > 0;
const informationId = annotationId => `human_${annotationId}`;
export function currentHumanAnnotations(draft) {
  const counts = new Map();
  for (const a of draft.annotations || []) if (human(a)) counts.set(a.id,(counts.get(a.id)||0)+1);
  return (draft.annotations || []).filter(a=>human(a)&&counts.get(a.id)===1);
}
export function pruneHumanItems(draft) {
  const ids = new Set(currentHumanAnnotations(draft).map(a=>a.id));
  draft.humanItems = (draft.humanItems || []).filter(i=>ids.has(i.annotationId));
}
export function validateHumanItems(draft, items, fail) {
  if (!Array.isArray(items) || items.length > 10000) fail('INVALID_INPUT','items must be an array (max 10000)');
  const known = new Map(currentHumanAnnotations(draft).map(a=>[a.id,a])), seen = new Set();
  const previous = new Map((draft.humanItems || []).map(i=>[i.annotationId,i]));
  return items.map(item=>{
    if (!item || typeof item!=='object' || Array.isArray(item) || Object.keys(item).some(k=>!['annotationId','category','selected','visibility','publicSource','localNote'].includes(k))) fail('INVALID_INPUT','Only existing annotation references and review settings are accepted');
    if (!known.has(item.annotationId) || seen.has(item.annotationId)) fail('INVALID_INPUT','Unknown, non-human or duplicate annotationId');
    seen.add(item.annotationId);
    if (!categories.has(item.category) || typeof item.selected!=='boolean' || !['public','local'].includes(item.visibility)) fail('INVALID_INPUT','Invalid human item review settings');
    for(const k of ['publicSource','localNote']) if(item[k]!==undefined && (typeof item[k]!=='string' || item[k].length>8192 || item[k].includes('\0'))) fail('INVALID_INPUT',`${k} must be bounded text`);
    return { id: informationId(item.annotationId), annotationId:item.annotationId,category:item.category,selected:item.selected,visibility:item.visibility,...(item.publicSource===undefined?{}:{publicSource:item.publicSource}),...(item.localNote===undefined?(typeof previous.get(item.annotationId)?.localNote==='string'?{localNote:previous.get(item.annotationId).localNote}:{}):{localNote:item.localNote}) };
  });
}
export function humanItemsView(record) {
  const draft=record.draft, settings=new Map((draft.humanItems||[]).map(i=>[i.annotationId,i]));
  const blocks=markdownBlocks(draft.markdown);
  const items=currentHumanAnnotations(draft).map(a=>{
    const verified=a.mappingConfidence!=='low' && blocks.some(b=>!['image','rule'].includes(b.kind) && b.target.startLine===a.target?.startLine && b.target.endLine===a.target?.endLine && b.target.quote===a.target?.quote);
    return {id:informationId(a.id),annotationId:a.id,category:'supplement',selected:false,visibility:'local',...settings.get(a.id),source:a.source,mappingConfidence:verified?'high':'low',stale:!verified,...(verified?{content:a.target.quote}:{unsupported:'ANNOTATION_TARGET_UNVERIFIED'})};
  });
  return {reportId:record.reportId,saveToken:draft.saveToken,status:draft.status,items,warnings:[...(items.some(i=>i.stale)?['HUMAN_ITEM_TARGET_UNVERIFIED']:[]), 'DELETED_RETRACTIONS_UNSUPPORTED']};
}
export function exportHumanItems(version) {
  const verified=new Map(publicAnnotations(version.markdown,version.annotations||[]).map(a=>[a.id,a]));
  return (version.humanItems||[]).filter(i=>i.selected===true && i.visibility==='public' && i.category!=='style' && categories.has(i.category) && verified.has(i.annotationId)).map(i=>{
    const a=verified.get(i.annotationId);
    return {id:informationId(i.annotationId),annotationId:i.annotationId,category:i.category,content:a.target.quote,source:a.source,...(i.publicSource===undefined?{}:{publicSource:i.publicSource}),...(a.authorId?{authorId:a.authorId}:{}),...(a.displayName?{displayName:a.displayName}:{}),...(a.completedAt?{completedAt:a.completedAt}:{})};
  });
}
