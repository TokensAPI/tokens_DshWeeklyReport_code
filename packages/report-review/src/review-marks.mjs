// Format-excluded "human review" extraction.
//
// The human edits an LLM-generated report in the markdown editor. The report's
// "baseline" is the LLM version (baseVersionId), and the "current" is what the
// human left. We must mark WHICH text the human changed substantively, ignoring
// pure Markdown-formatting-only edits (re-wrapping in **/**/_, adding/removing
// heading hashes, links, blockquote markers, whitespace). That surfaced,
// format-excluded signal is the machine-readable "human review" record we store
// on the published knowledge so TokensCowork can learn/distill it.
//
// Pure functions; no store/connector dependency, so it is unit-testable.
const EMPTY = new Set(['', ' ']);

/** Strip Markdown formatting but keep the textual content, for comparison.
 *  Emphasis (**, __, *, _, ~~, `code`), heading hashes, blockquote/list markers,
 *  images/links (keep the visible text), and HTML tags are removed; runs of
 *  whitespace collapse so only wording/number changes remain. */
export function stripMarkdownFormatting(value) {
  const text = String(value ?? '');
  let out = text
    // images / links: keep alt/caption text
    .replace(/!\[([^\]\r\n]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]\r\n]*)\]\([^)]*\)/g, '$1')
    // inline code markers, then emphasis & strikethrough
    .replace(/`+/g, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    // inline HTML tags
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    // line-prefix markdown (headings, lists, blockquote) and hard breaks
    .replace(/^[ \t]*(#{1,6}\s+|[>*+-]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[ \t]{2,}$/gm, '')
    .replace(/\\\\([\\`*_{}\[\]()#+.!|>~-])/g, '$1')
    .replace(/\\([\\`*_{}\[\]()#+.!|>~-])/g, '$1');
  // collapse whitespace per line, drop fully-empty/whitespace lines
  out = out.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => !EMPTY.has(l));
  return out.join('\n');
}

/** A compact line diff (LCS) returning added/removed lines with their sides.
 *  Good enough for report-size markdown (up to ~1500 lines each). Returns
 *  [{op:'same'|'add'|'del', before?:string, after?:string}]. */
export function diffLines(beforeLines, afterLines) {
  const a = beforeLines, b = afterLines, n = a.length, m = b.length;
  if (n === 0 || m === 0) {
    const out = [];
    if (n === 0) for (const x of b) out.push({ op: 'add', after: x });
    else for (const x of a) out.push({ op: 'del', before: x });
    return out;
  }
  // guard against pathological sizes; fall back to naive
  if (n * m > 4_000_000) return naiveDiff(a, b);
  const dp = new Uint16Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + (j + 1)] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: 'same', before: a[i], after: a[i] }); i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) { out.push({ op: 'del', before: a[i] }); i++; }
    else { out.push({ op: 'add', after: b[j] }); j++; }
  }
  while (i < n) { out.push({ op: 'del', before: a[i] }); i++; }
  while (j < m) { out.push({ op: 'add', after: b[j] }); j++; }
  return out;
}

function naiveDiff(a, b) {
  const out = [];
  const i = 0;
  // Simple: mark everything as a block replacement to stay correct (rarely hit).
  if (a.length || b.length) { out.push({ op: 'delblock', after: a }); out.push({ op: 'addblock', before: b }); }
  return out;
}

/**
 * Extract the human's format-excluded review edits between an LLM baseline and a
 * human-edited report.
 * @returns {{formatOnly:boolean, substantive:boolean, edits:Array<{op:'add'|'del',text:string}>, changed?:Array<{op:string,before?:string,after?:string}>}}
 */
export function extractReviewMarks(baselineMarkdown, currentMarkdown) {
  // Whitespace/emphasis-insensitive equality decides format-only. (Re-wrapping a run in
  // **…** often leaves a space that a plain version lacks; ignoring ALL whitespace keeps
  // a purely-formatting edit from being misread as a wording change.)
  const comparable = t => stripMarkdownFormatting(t).replace(/\s+/g, '');
  if (comparable(baselineMarkdown) === comparable(currentMarkdown)) {
    return { formatOnly: true, substantive: false, edits: [] };
  }
  const bLines = stripMarkdownFormatting(baselineMarkdown).split('\n');
  const cLines = stripMarkdownFormatting(currentMarkdown).split('\n');
  const changed = diffLines(bLines, cLines);
  const edits = [];
  for (const d of changed) {
    if (d.op === 'add') edits.push({ op: 'add', text: d.after });
    else if (d.op === 'del') edits.push({ op: 'del', text: d.before });
  }
  // A "same" block interspersed means a true rewrite — still substantive.
  return { formatOnly: false, substantive: true, edits, changed };
}
