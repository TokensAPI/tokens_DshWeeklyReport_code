import { randomUUID } from 'node:crypto';

/** Boundaries mirror report-pdf/renderer.py blocks; lists/quotes use paragraph boundaries. */
export function markdownBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    const start = i;
    let kind;
    if (/^(```|~~~)/.test(s)) {
      kind = 'code'; const marker = s.slice(0, 3);
      while (++i < lines.length && !lines[i].trim().startsWith(marker)) {}
      i = Math.min(i, lines.length - 1);
    } else if (/^#{1,6}\s/.test(s)) kind = 'heading';
    else if (/^!\[([^\]]*)\]\(([^\s)]+)\)$/.test(s)) kind = 'image';
    else if (/^(?:---+|\*\*\*+|___+)$/.test(s)) kind = 'rule';
    else if (s.startsWith('|')) {
      kind = 'table'; while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) i++;
    } else {
      kind = /^\s*([-*+]\s|\d+\.\s)/.test(s) ? 'list' : s.startsWith('>') ? 'blockquote' : 'paragraph';
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#{1,6}\s|!\[|\||```|~~~|---+$)/.test(lines[i + 1].trim())) i++;
    }
    blocks.push({ kind, target: { startLine: start + 1, endLine: i + 1, quote: lines.slice(start, i + 1).join('\n') } });
  }
  return blocks;
}
const key = b => `${b.kind}\0${b.target.quote}`;
export function annotateChanges(before, after, previous, source) {
  if (before === after) return { annotations: structuredClone(previous), warnings: [] };
  const old = markdownBlocks(before), next = markdownBlocks(after);
  const count = list => { const map = new Map(); for (const b of list) map.set(key(b), (map.get(key(b)) || 0) + 1); return map; };
  const oldCount = count(old), nextCount = count(next);
  const annotations = [], warnings = [];
  for (const block of next) {
    const k = key(block), prior = old.find(b => key(b) === k);
    const ambiguous = (oldCount.get(k) || 0) > 1 || nextCount.get(k) > 1;
    if (prior && !ambiguous) {
      const matches = previous.filter(a => a.target?.startLine === prior.target.startLine && a.target?.endLine === prior.target.endLine && a.target?.quote === prior.target.quote);
      annotations.push(...matches.map(a => ({ ...structuredClone(a), target: block.target })));
      continue;
    }
    if (ambiguous) warnings.push({ code: 'ANNOTATION_AMBIGUOUS_BLOCK', startLine: block.target.startLine, message: 'Repeated identical block: provenance cannot be mapped reliably' });
    if (prior && ambiguous) {
      const candidates = previous.filter(a => a.target?.quote === block.target.quote);
      // Shallow snapshot only: never embed a candidate's own nested provenanceCandidates,
      // which would grow exponentially on repeated edits and break JSON serialization.
      annotations.push({ id: randomUUID(), kind: block.kind, target: block.target, source: 'agent_inference', public: false, mappingConfidence: 'low', warning: 'ANNOTATION_AMBIGUOUS_BLOCK', provenanceCandidates: candidates.map(c => ({ id: c?.id, kind: c?.kind, target: c?.target, source: c?.source, public: c?.public, mappingConfidence: c?.mappingConfidence, warning: c?.warning })) });
      continue;
    }
    annotations.push({ id: randomUUID(), kind: block.kind, target: block.target, source,
      public: ['user_direct', 'user_prompt'].includes(source), pending: true,
      mappingConfidence: ambiguous ? 'low' : 'high', ...(ambiguous ? { warning: 'ANNOTATION_AMBIGUOUS_BLOCK' } : {}) });
  }
  return { annotations, warnings };
}
export function publicAnnotations(markdown, annotations) {
  const blocks = markdownBlocks(markdown);
  return annotations.filter(a => a.public === true && ['user_direct', 'user_prompt'].includes(a.source) && a.mappingConfidence !== 'low' && a.target && blocks.some(b => b.target.startLine === a.target.startLine && b.target.endLine === a.target.endLine && b.target.quote === a.target.quote && !['image', 'rule'].includes(b.kind))).map(a => ({
    ...(a.id ? { id: a.id } : {}), target: { startLine: a.target.startLine, endLine: a.target.endLine, quote: a.target.quote }, source: a.source, public: true,
    ...(typeof a.authorId === 'string' ? { authorId: a.authorId } : {}),
    ...(typeof a.displayName === 'string' ? { displayName: a.displayName } : {}),
    ...(typeof a.completedAt === 'string' ? { completedAt: a.completedAt } : {})
  }));
}
