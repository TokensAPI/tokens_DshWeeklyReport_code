// Human-readable version timeline derived from report-core version snapshots (pure, no I/O).
//
// The WeKnora knowledge is the machine "learning signal" layer (single evolving report + review_marks +
// human entries). Reading ALL versions and their differences is a HUMAN need, so it is served here from
// report-core's immutable versions[] — the view shows V0 (LLM baseline) → V1 → V2… with an automatic
// adjacent line diff and a badge on human-edited versions, so nobody has to reconstruct diffs by hand.
import { diffLines } from './review-marks.mjs';

const isHumanEdited = v => (Array.isArray(v?.humanItems) && v.humanItems.length > 0)
  || (Array.isArray(v?.annotations) && v.annotations.some(a => a?.public === true && ['user_direct', 'user_prompt'].includes(a.source)));

/**
 * @param {{versionId:string,baseVersionId:?string,markdown:string,author?:object,completedAt?:string,title?:string,humanItems?:Array,annotations?:Array}[]} versions
 * @param {{[versionId:string]:boolean}} [publishedByVersion] whether each version reached the knowledge base.
 * @returns {{baselineVersionId:?string, versions:Array<{versionId:string,baseVersionId:?string,isBaseline:boolean,humanEdited:boolean,published:boolean,author?:object,completedAt?:string,title?:string,diffFromPrevious:?{changed:boolean,add:number,del:number,ops:Array}}>}}
 */
export function computeTimeline(versions, publishedByVersion = {}) {
  const list = Array.isArray(versions) ? versions : [];
  const baseline = list.find(v => !v.baseVersionId) || list[0] || null;
  const out = [];
  let prev = null;
  for (const v of list) {
    const vMarkdown = typeof v?.markdown === 'string' ? v.markdown : '';
    let diffFromPrevious = null;
    if (prev) {
      const ops = diffLines((typeof prev.markdown === 'string' ? prev.markdown : '').split('\n'), vMarkdown.split('\n'));
      const meaningful = ops.filter(o => o.op !== 'same');
      diffFromPrevious = {
        changed: meaningful.length > 0,
        add: meaningful.filter(o => o.op === 'add' || o.op === 'addblock').length,
        del: meaningful.filter(o => o.op === 'del' || o.op === 'delblock').length,
        ops: ops.slice(0, 400), // cap for rendering
      };
    }
    out.push({
      versionId: v.versionId,
      baseVersionId: v.baseVersionId,
      isBaseline: baseline ? v.versionId === baseline.versionId : !v.baseVersionId,
      humanEdited: isHumanEdited(v),
      published: publishedByVersion[v.versionId] === true,
      author: v.author ? { authorId: v.author.authorId, displayName: v.author.displayName } : undefined,
      completedAt: v.completedAt,
      title: v.title,
      diffFromPrevious,
    });
    prev = v;
  }
  return { baselineVersionId: baseline?.versionId || null, versions: out };
}
