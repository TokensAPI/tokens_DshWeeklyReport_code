import { readFile, realpath, lstat, copyFile, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { preparePublicationManifest, resolvePublicationMarkdown, deriveVariety } from './publication-manifest.mjs';
import { extractReviewMarks } from './review-marks.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const fail = (code, message = code) => { const e = new Error(message); e.code = code; throw e; };
const token = () => randomBytes(32).toString('hex');
const hex = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const validString = (x, max = 512) => typeof x === 'string' && x.length > 0 && x.length <= max && !x.includes('\0');
// Whether the human EXPLICITLY asked to combine historical weeks / compare with past periods, so the script
// fetches past WeKnora weekly reports. Bare "周报"/"周度" do NOT imply historical comparison; an explicit
// "不/无需/仅本周" override wins, so a user who edits the requirement (or says not to compare) is honored.
const HISTORY_RE = /(近\s*[0-9一二三四五六七八九十两]+\s*周|近几周|近四周|历史|既往|回顾|连续|连贯|以往|过去[0-9一二三四五六七八九十两]+周|前[0-9一二三四五六七八九十两]+周|同期|对比|比较|环比|连续性)/i;
const NO_HISTORY_RE = /(不参考|不要参考|不引用|不对比|不比较|不结合历史|不纳入历史|不采用历史|不回顾|无需历史|不需要历史|不用历史|排除历史|排除周报|只看本周|仅看本周|只基于本周|仅基于本周|只做本周|仅本周|不[^。！？\n但然而不过却]{0,14}(连续|对比|同期|历史|周报))/i;
// True when an LLM request failed because the assembled input exceeds the model's context window. We surface
// this as a distinct, user-actionable warning (reduce the reference scope) instead of a generic OR failure.
const isContextOverflow = e => /context\s*length|context[_\\-\s]?(length|size|window)|maximum\s*context|too\s*many\s*tokens|token\s*limit|exceeds?\s*(the\s*)?maximum|reduce\s*(the\s*)?(length|input|message)|input[\s_-]?too[\s_-]?large|maximum\s*(model\s*)?token/i.test(`${e?.message || ''} ${e?.code || ''} ${e?.error?.message || ''} ${e?.error?.code || ''}`);
const safeError = e => {
  const known = new Set(['NOT_FOUND','INVALID_INPUT','CONFLICT','DRAFT_EXISTS','REVISION_REQUIRED','ASSET_CORRUPT','SESSION_FORBIDDEN','IDENTITY_UNVERIFIED','IDENTITY_CHANGED','CONNECTOR_UNAVAILABLE','SOURCE_UNAVAILABLE','SOURCE_ROOT_REQUIRED','SOURCE_MANIFEST_INVALID','SOURCE_FILE_INVALID','SOURCE_HASH_MISMATCH','SOURCE_FAILED','WEB_SEARCH_UNAVAILABLE','KNOWLEDGE_SEARCH_FAILED','KNOWLEDGE_RESPONSE_INVALID','LIST_UNAVAILABLE','PUBLISH_TARGET_REQUIRED','IMAGES_UNSUPPORTED','PUBLICATION_RECONCILIATION_REQUIRED','PUBLISH_TOKEN_INVALID','HUMAN_CLICK_REQUIRED','PUBLICATION_IN_PROGRESS','PUBLISH_REJECTED','PREVIEW_STALE','PREVIEW_NOT_FOUND','PDF_INVALID','DISPOSED','BODY_TOO_LARGE','ACTION_UNSUPPORTED','HUMAN_ITEMS_UNAVAILABLE','HUMAN_ITEMS_PUBLICATION_UNSUPPORTED','UNSUPPORTED_ASSET_REFERENCE','UNREGISTERED_ASSET','AMBIGUOUS_ASSET_CAPTION','UNREFERENCED_ASSET','INVALID_PUBLIC_VERSION','INVALID_IMAGE_CAPTION','INVALID_PUBLIC_SOURCE','INVALID_PUBLIC_SOURCE_TIME','INVALID_PUBLIC_AUTHOR','UNSUPPORTED_PUBLIC_MARKDOWN','INVALID_OR_DUPLICATE_ASSET','INVALID_HUMAN_ITEM','PRIVATE_HUMAN_ITEM','HUMAN_ITEM_ASSET_UNSUPPORTED','HUMAN_CONTENT_NOT_IN_VERSION','HUMAN_ANNOTATION_MISMATCH','UNTRUSTED_MANIFEST','INVALID_RESOURCE_BINDING','RESOURCE_BINDING_MISMATCH','INCOMPLETE_RESOURCE_BINDINGS']);
  const code = known.has(e?.code) ? e.code : 'INTERNAL_ERROR';
  return { ok: false, error: { code, message: code === 'INTERNAL_ERROR' ? 'Host operation failed; private diagnostics are not exposed.' : code } };
};
function annotationView(a) {
  return { ...pick(a, ['id','source','public','pending','mappingConfidence','displayName','completedAt']), ...(a.target ? { target: pick(a.target, ['startLine','endLine']) } : {}) };
}
const humanCategories = ['supplement','correction','retraction','judgment','style'];
export function validateHumanItems(input) {
  if (!Array.isArray(input) || input.length > 1000) fail('INVALID_INPUT');
  const seen = new Set();
  return input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['annotationId','category','selected','visibility','publicSource','localNote'].includes(k))) fail('INVALID_INPUT');
    if (!validString(item.annotationId,128) || seen.has(item.annotationId) || !humanCategories.includes(item.category) || typeof item.selected !== 'boolean' || !['public','local'].includes(item.visibility)) fail('INVALID_INPUT');
    seen.add(item.annotationId);
    for (const key of ['publicSource','localNote']) if (item[key] !== undefined && (typeof item[key] !== 'string' || item[key].length > 4000 || item[key].includes('\0'))) fail('INVALID_INPUT');
    return pick(item,['annotationId','category','selected','visibility','publicSource','localNote']);
  });
}
export function draftView(d) {
  return { ...pick(d, ['reportId','sessionId','title','markdown','saveToken','status','baseVersionId','updatedAt','versionId','contentHash','completedAt']),
    assets: (d.assets || []).map(a => pick(a, ['id','sha256','name','size'])),
    annotations: (d.annotations || []).map(annotationView),
    ...(d.author ? { author: pick(d.author, ['authorId','displayName']) } : {}),
    warnings: [...new Set([
      ...((d.annotations || []).some(a => a.mappingConfidence === 'low') ? ['LOW_CONFIDENCE_ANNOTATION_MAPPING'] : []),
      ...(d.markers || []).filter(m => m?.kind === 'source_provenance').flatMap(m => Array.isArray(m.reviewGeneration?.warnings) ? m.reviewGeneration.warnings : []).filter(w => ['KNOWLEDGE_RETRIEVED','KNOWLEDGE_SEARCH_FAILED','KNOWLEDGE_RESPONSE_INVALID','KNOWLEDGE_UNAVAILABLE','KNOWLEDGE_EXCERPTS_ARE_UNVERIFIED','KNOWLEDGE_VERSION_FILTER_NOT_IMPLEMENTED','KNOWLEDGE_SEARCH_EMPTY','WEB_SEARCH_EXECUTED','WEB_SEARCH_FAILED','WEB_SEARCH_UNAVAILABLE','LLM_SYNTHESIS_APPLIED','LLM_SYNTHESIS_UNSUPPORTED','LLM_SYNTHESIS_NO_MODEL','LLM_SYNTHESIS_TIMEOUT','LLM_SYNTHESIS_EMPTY','LLM_SYNTHESIS_EMPTY_RETRY','LLM_SYNTHESIS_FAILED','LLM_SYNTHESIS_CONTEXT_OVERFLOW'].includes(w))
    ])] };
}

/** Trusted Host factory. dispatchHuman is for authenticated connection routes ONLY, never a model tool. */
export function createReviewHost({ core, pdf, sessions, getConnector = () => undefined, getSource = () => undefined, getLlm = () => undefined, getDefaultModel = () => undefined, getWeb = () => undefined, llmSynthesisEnabled = true, llmSynthesisMaxTokens = 32000, llmSynthesisTimeoutMs = 300000 }, config = {}) {
  const previews = new Map(), plans = new Map(), publishing = new Set();
  let disposed = false;
  const allowed = config.allowedSessionIds === undefined ? null : new Set(config.allowedSessionIds);
  const maxBodyBytes = config.maxBodyBytes ?? 1024 * 1024;
  const ttl = config.publishTokenTtlMs ?? 5 * 60 * 1000;
  if (allowed && (!Array.isArray(config.allowedSessionIds) || [...allowed].some(x => !validString(x)))) fail('INVALID_INPUT');
  const binding = async input => {
    if (disposed) fail('DISPOSED');
    const sessionId = input?.sessionId;
    if (!validString(sessionId) || (allowed && !allowed.has(sessionId)) || !await sessions.get(sessionId)) fail('SESSION_FORBIDDEN');
    if (input.reportId !== undefined && !validString(input.reportId)) fail('INVALID_INPUT');
    return { sessionId, reportId: input.reportId };
  };
  const draft = async b => { if (!validString(b.reportId)) fail('INVALID_INPUT'); return core.getDraft(b); };
  async function identity() {
    const connector = getConnector();
    if (!connector?.identity) return { confirmed: false, verified: false, blocked: 'CONNECTOR_UNAVAILABLE' };
    const value = await connector.identity({ forPublication: true });
    if (value?.verified !== true || value.credentialPurpose !== 'publish' || !validString(value.principal?.userId) || !validString(value.principal?.username, 256)) return { confirmed: false, verified: false, blocked: 'IDENTITY_UNVERIFIED' };
    return { confirmed: true, verified: true, authorId: value.principal.userId, displayName: value.principal.username, humanIdentityVerified: false };
  }
  async function requireIdentity() { const i = await identity(); if (!i.confirmed) fail('IDENTITY_UNVERIFIED'); return i; }
  function assertAuthor(version, i) { if (version.author?.authorId !== i.authorId || version.author?.displayName !== i.displayName) fail('IDENTITY_CHANGED'); }
  async function audit(b) {
    const current = await draft(b), entries = await core.getAudit(b);
    let baselineMarkdown = null;
    if (current.baseVersionId) baselineMarkdown = (await core.getVersion({ ...b, versionId: current.baseVersionId })).markdown;
    else baselineMarkdown = entries.find(e => e.action === 'create' && typeof e.after === 'string')?.after ?? null;
    // Only authenticated local review gets before/after text. Instructions, asset paths and arbitrary metadata never cross.
    return { baselineMarkdown, currentMarkdown: current.markdown, entries: entries.map(e => ({ ...pick(e, ['auditId','at','action','source','versionId']), ...(typeof e.before === 'string' ? { before: e.before } : {}), ...(typeof e.after === 'string' ? { after: e.after } : {}) })) };
  }
  async function preview(b, input) {
    const d = await draft(b);
    if (input.saveToken !== undefined && input.saveToken !== d.saveToken) fail('CONFLICT');
    const result = await pdf.render({ reportId: d.reportId, saveToken: d.saveToken, markdown: d.markdown, assets: d.assets,
      annotations: (d.annotations || []).filter(a => a.public === true && ['user_direct','user_prompt'].includes(a.source) && a.mappingConfidence !== 'low' && a.target && !['image','rule'].includes(a.kind)).map(a => ({ ...pick(a, ['id','source','public','displayName','completedAt']), target: pick(a.target, ['startLine','endLine','quote']) })) });
    const latest = await draft(b);
    const warnings = [...(Array.isArray(result.warnings) ? result.warnings.filter(w => typeof w === 'string' && /^[A-Z0-9_: -]{1,160}$/.test(w)) : []), ...draftView(d).warnings];
    if (result.status !== 'ready' || result.saveToken !== latest.saveToken || d.saveToken !== latest.saveToken || !hex(result.digest)) return { status: result.status === 'failed' ? 'failed' : 'stale', saveToken: d.saveToken, digest: hex(result.digest) ? result.digest : null, warnings, ...(result.status === 'failed' ? { error: 'PDF_RENDER_FAILED' } : {}) };
    if (!validString(result.pdfPath, 8192)) fail('PDF_INVALID');
    previews.set(`${b.sessionId}\0${b.reportId}\0${result.digest}`, { path: result.pdfPath, saveToken: d.saveToken });
    return { ...pick(result, ['digest','cached','pages','imageCount','markedBlocks']), status: 'ready', saveToken: d.saveToken, warnings,
      pdfUrl: `/api/run19/pdf?${new URLSearchParams({ sessionId: b.sessionId, reportId: b.reportId, digest: result.digest })}` };
  }
  async function checkedSourceFile(root, runDir, descriptor) {
    if (!descriptor || !hex(descriptor.sha256) || !validString(descriptor.path, 8192) || isAbsolute(descriptor.path)) fail('SOURCE_MANIFEST_INVALID');
    const file = resolve(runDir, descriptor.path), rel = relative(runDir, file);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) fail('SOURCE_FILE_INVALID');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 30 * 1024 * 1024) fail('SOURCE_FILE_INVALID');
    const actual = await realpath(file), fromRoot = relative(root, actual), fromRun = relative(runDir, actual);
    if ([fromRoot, fromRun].some(p => p === '..' || p.startsWith(`..${sep}`) || isAbsolute(p))) fail('SOURCE_FILE_INVALID');
    if (descriptor.absolutePath !== undefined && (!isAbsolute(descriptor.absolutePath) || await realpath(descriptor.absolutePath) !== actual)) fail('SOURCE_FILE_INVALID');
    const bytes = await readFile(actual);
    if (sha256(bytes) !== descriptor.sha256 || (descriptor.bytes !== undefined && descriptor.bytes !== bytes.length)) fail('SOURCE_HASH_MISMATCH');
    return { path: actual, bytes };
  }
  async function synthesizeAnalysis({ variety, dataSummary, analysisPrompt = '', materials, wantHistory = false }, warnings) {
    // Optional enhancement: write reference-style 五/六 analysis over current data (+ web news when the human asked).
    // Invoked only when the human supplied an analysis requirement; any failure returns null so generation
    // falls back to a pure data report and never blocks.
    if (llmSynthesisEnabled === false) return null;
    const llm = getLlm(); if (!llm?.stream) { warnings?.push('LLM_SYNTHESIS_UNSUPPORTED'); return null; }
    const selection = getDefaultModel()?.currentSelection?.();
    const provider = selection?.provider, model = selection?.model;
    if (!validString(provider, 64) || !validString(model, 128)) { warnings?.push('LLM_SYNTHESIS_NO_MODEL'); return null; }
    const hasData = typeof dataSummary === 'string' && dataSummary.trim().length > 0;
    const mats = Array.isArray(materials) ? materials : [];
    if (!hasData && !mats.length) return null; // nothing to reason over
    const wek = mats.filter(m => m?.kind === 'weknora');
    const web = mats.filter(m => m?.kind !== 'weknora');
    const wekLabel = i => `〔${i + 1}〕`;
    const bodyParts = [];
    if (hasData) bodyParts.push(`【本周数据（本地 API，当前报告）】\n${dataSummary}`);
    if (wek.length) bodyParts.push(`【既往周报材料（weknora，第 ${wek.map((_, i) => i + 1).join('/')} 篇分别标 ${wek.map((_, i) => wekLabel(i)).join('、')}，正文引用用对应标号）】\n${wek.map((m, i) => `${wekLabel(i)} ${m.title}\n${m.text}`).join('\n\n---\n\n')}`);
    if (web.length) bodyParts.push(`【联网信源材料（每条标 [id]）】\n${web.map(m => `[${m.id}] ${m.title}\n${m.text}`).join('\n\n---\n\n')}`);
    if (analysisPrompt) bodyParts.push(`【人类分析要求】\n${analysisPrompt}`);
    const body = bodyParts.filter(Boolean).join('\n\n---\n\n');
    const citeInstruction = wek.length
      ? (web.length ? '引用既往 weknora 周报处用“〔N〕”（如“〔1〕”），引用联网信源用“（[id]）”；结尾把实际引用的既往周报各写一行“〔N〕来源：《文件名》”。' : '引用既往 weknora 周报处用“〔N〕”（如“〔1〕”）；结尾把实际引用的既往周报各写一行“〔N〕来源：《文件名》”。')
      : '引用联网信源用“（[id]）”。';
    const defaultSections = wantHistory ? '“本周多空逻辑 → 与近四周周报的连贯性分析 → 风险提示”' : '“本周多空逻辑 → 风险提示”';
    const user = `你是投研分析师，为 ${variety} 周报撰写分析段落。下面给出了可用材料：【本周数据】${wek.length ? '与【既往周报材料】' : ''}${web.length ? '与【联网信源材料】' : ''}。请**基于这些已提供的材料做梳理与推理**（不是凭空推测）：材料足以支撑的判断才写；材料不足以支撑的，说明缺少哪部分并给出仍可判断的内容，不要虚构，也不要引用材料之外的数据。${citeInstruction}\n\n请严格按【人类分析要求】列出的章节结构输出（简洁中文 Markdown，不要输出数据表）；【人类分析要求】未指明具体章节时，按${defaultSections}的常规结构综合输出。${wek.length ? `注意：${wantHistory ? '本次已提供既往周报片段，请按用户要求使用' : '用户明确不要求历史对比，请勿引用或展开既往周报，只基于本周数据与要求输出'}。` : ''}`;
    const runStream = async (streamOpts) => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), llmSynthesisTimeoutMs);
      let text = '';
      try {
        for await (const chunk of llm.stream({ ...streamOpts, signal: controller.signal })) {
          if (chunk.type === 'text-delta') text += chunk.text;
          else if (chunk.type === 'finish') { const k = chunk.reason?.kind; if (k && !['stop', 'max-tokens'].includes(k)) throw new Error('LLM_FINISH_' + k); }
        }
      } catch (e) {
        const code = isContextOverflow(e) ? 'LLM_SYNTHESIS_CONTEXT_OVERFLOW' : (e?.code === 'ABORT_ERR' ? 'LLM_SYNTHESIS_TIMEOUT' : 'LLM_SYNTHESIS_FAILED');
        warnings?.push(code); return null;
      } finally { clearTimeout(timer); }
      return text.trim() || null;
    };
    const messages = [{ id: token(), role: 'user', content: [{ type: 'text', text: user + '\n\n\n【已提供材料正文】\n' + body }], source: { kind: 'plugin', plugin: 'run19-report-review' } }];
    const baseOpts = { provider, model, messages, system: '你是投研分析师，只依据给定数据与历史周报材料做综合推理；不臆造，不引入材料之外的数据或判断。材料来源的使用范围须遵循用户明确要求（用户指定忽略/排除的来源不应被引用）。', temperature: 0.2, maxTokens: llmSynthesisMaxTokens };
    const reasoningEffort = selection?.reasoningEffort;
    if (validString(reasoningEffort, 64)) baseOpts.reasoningEffort = reasoningEffort;
    let out = await runStream(baseOpts);
    // Deep-reasoning models can consume the entire token budget plotting the chain before ever emitting text.
    // On an empty first pass, retry with a much larger budget, keeping the reasoning effort, so the long
    // chain finishes and the answer still comes through.
    if (out === null) {
      warnings?.push('LLM_SYNTHESIS_EMPTY_RETRY');
      const retryOpts = { ...baseOpts, maxTokens: Math.max(llmSynthesisMaxTokens, 50000) };
      out = await runStream(retryOpts);
    }
    if (!out) { warnings?.push('LLM_SYNTHESIS_EMPTY'); return null; }
    const riskMatch = out.match(/^\s*#{2,3}\s*风险提示\s*$/m);
    const idx = riskMatch ? riskMatch.index : -1;
    let bodyTxt, riskTxt;
    if (idx >= 0) { bodyTxt = out.slice(0, idx).trim(); riskTxt = out.slice(idx).replace(/^\s*#{2,3}\s*风险提示\s*$/, '').replace(/^\s*[-*]\s*/gm, '- ').trim(); }
    else { bodyTxt = out.trim(); riskTxt = ''; }
    // Footnote the WeKnora files actually cited, by FILENAME (not the file id), rendered gray/small by the PDF renderer.
    if (wek.length) {
      const used = new Set(); for (const m of out.matchAll(/〔(\d+)〕/g)) used.add(Number(m[1]));
      const lines = [];
      wek.forEach((m, i) => {
        const n = i + 1;
        if (!used.has(n)) return;
        const fn = validString(m.title, 512) ? m.title : (m.knowledgeId || `文件${n}`);
        lines.push(`${wekLabel(i)}来源：《${fn}》`);
      });
      if (lines.length) bodyTxt = bodyTxt.trimEnd() + '\n\n' + lines.join('\n');
    }
    return { body: bodyTxt.slice(0, 24000), risk: riskTxt.slice(0, 12000) };
  }
  async function generate(b, input) {
    const source = getSource(); if (!source?.generate) fail('SOURCE_UNAVAILABLE');
    if (!config.sourceOutputRoot || !isAbsolute(config.sourceOutputRoot)) fail('SOURCE_ROOT_REQUIRED');
    // No browser path, command, source excerpt, identity, or connector config can enter source invocation.
    const request = pick(input, ['variety','start','end','period','charts','webSearchEnabled']);
    const generationWarnings = [];
    // Human-stated analysis intent drives any post-hoc LLM synthesis; empty => pure 7-day data report.
    const analysisPrompt = (typeof input.analysisPrompt === 'string' ? input.analysisPrompt : '').trim();
    if (analysisPrompt.length > 16000) fail('INVALID_INPUT');
    // LLM analysis runs when the human stated a requirement OR asked for web retrieval; otherwise pure 7-day data.
    const analysisRequested = analysisPrompt.length > 0 || input.webSearchEnabled === true;
    // Combining historical weeks of the same category is a HUMAN requirement, not the default. It only fetches
    // past WeKnora weekly reports (and asks for the continuity section) when the prompt explicitly asks for it.
    const wantHistory = analysisRequested && !NO_HISTORY_RE.test(analysisPrompt) && HISTORY_RE.test(analysisPrompt);
    // Web material is an input to the LLM analysis only; it never becomes an excerpt block in the report.
    let webMaterials = [];
    if (analysisRequested && input.webSearchEnabled === true) {
      const wsvc = getWeb();
      if (wsvc?.search) {
        try {
          const wq = (typeof input.webQuery === 'string' && input.webQuery.trim()) || (`${request.variety} 周报 新闻 分析`);
          const wr = await wsvc.search({ query: wq, maxResults: 8 });
          webMaterials = (Array.isArray(wr?.sources) ? wr.sources : []).slice(0, 8).map((s, i) => ({ kind: 'web', id: `web-${i}`, url: s?.url || '', title: validString(s?.title, 512) ? s.title : (s?.url || `web-${i}`), text: ((s?.snippet || s?.title || '') + (s?.url ? `\n来源：${s.url}` : '')) })).filter(m => validString(m.url));
          if (webMaterials.length) generationWarnings.push('WEB_SEARCH_EXECUTED');
        } catch { generationWarnings.push('WEB_SEARCH_FAILED'); }
      } else generationWarnings.push('WEB_SEARCH_UNAVAILABLE');
    }
    // Retrieve past weekly reports from WeKnora only when the human explicitly asked to combine historical weeks
    // (wantHistory). The script's job here is to FETCH ALL relevant RAG fragments the search returns (no artificial
    // top-N cap), so no weekly report is missed; the LLM reasons over them and applies the human's material-scope
    // requirement (e.g. excluding a file). Image/asset knowledge (charts) is kept — its content may be relevant.
    let weknoraMaterials = [];
    if (wantHistory) {
      const connector = getConnector();
      if (connector?.search && validString(config.publishKbId)) {
        try {
          const kw = (typeof input.knowledgeQuery === 'string' && input.knowledgeQuery.trim()) || request.variety;
          if (validString(kw, 8192)) {
            const matchCount = (typeof config.knowledgeMatchCount === 'number' && Number.isInteger(config.knowledgeMatchCount) && config.knowledgeMatchCount >= 1 && config.knowledgeMatchCount <= 100) ? config.knowledgeMatchCount : 100;
            const found = await connector.search(config.publishKbId, kw, { matchCount });
            if (found?.ok && Array.isArray(found.data?.data)) {
              // Relevance-ranked fragments (all hits). Group them per source doc (knowledge_id), keep only the top
              // relevant fragments per doc (bounded), and attribute each doc by its title so the LLM can honor an
              // exclusion. Keep image/asset knowledge (charts) — its content may be relevant to the analysis.
              const MAX_FRAGMENTS_PER_DOC = 6, MAX_FRAGMENT_CHARS = 3072;
              const rows = (found.data.data || []).filter(row => row && validString(row.content, 32768));
              const perDoc = new Map(); // knowledge_id -> { id, title, knowledgeId, fragments:[] }
              for (const row of rows) {
                const kid = row.knowledge_id;
                const key = validString(row.id, 128) ? row.id : (kid || `w-${perDoc.size + 1}`);
                const docKey = kid || key;
                const title = validString(row.knowledge_title, 512) ? row.knowledge_title : (kid || key);
                const frag = (row.content || '').trim().slice(0, MAX_FRAGMENT_CHARS);
                if (!frag) continue;
                const doc = perDoc.get(docKey) || { id: key, title, knowledgeId: kid || null, fragments: [] };
                if (doc.fragments.length < MAX_FRAGMENTS_PER_DOC) doc.fragments.push(frag);
                perDoc.set(docKey, doc);
              }
              for (const doc of perDoc.values()) {
                weknoraMaterials.push({ kind: 'weknora', id: doc.id, knowledgeId: doc.knowledgeId, title: doc.title, text: doc.fragments.join('\n') });
              }
              if (weknoraMaterials.length) generationWarnings.push('KNOWLEDGE_RETRIEVED');
            } else generationWarnings.push('KNOWLEDGE_RESPONSE_INVALID');
          }
        } catch { generationWarnings.push('KNOWLEDGE_SEARCH_FAILED'); }
      } else generationWarnings.push('KNOWLEDGE_UNAVAILABLE');
    }
    let manifest; try { manifest = await source.generate(request); } catch { fail('SOURCE_FAILED'); }
    if (!manifest || !Array.isArray(manifest.assets) || !validString(manifest.runDir,8192)) fail('SOURCE_MANIFEST_INVALID');
    const root = await realpath(config.sourceOutputRoot), runDir = await realpath(manifest.runDir), rel = relative(root, runDir);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('SOURCE_FILE_INVALID');
    const md = await checkedSourceFile(root, runDir, manifest.markdown);
    if (md.bytes.length > maxBodyBytes) fail('BODY_TOO_LARGE');
    // Post-generation LLM synthesis: only when the human stated an analysis requirement (default = pure 7-day data report).
    let markdownText = md.bytes.toString('utf8');
    if (analysisRequested) {
      const analysis = await synthesizeAnalysis({ variety: request.variety, dataSummary: manifest.sourceMeta?.dataSummary || '', analysisPrompt, wantHistory, materials: [...weknoraMaterials, ...webMaterials] }, generationWarnings);
      if (analysis) {
        if (analysis.body) markdownText = markdownText.replace('__RUN19_ANALYSIS__', analysis.body);
        if (analysis.risk) markdownText = markdownText.replace('__RUN19_RISK__', analysis.risk);
        markdownText = markdownText.replace(/（待填充）\s*/g, '').replace(/- 待填充：[^\n]*\n?/g, '').replace(/- 待分析师补充：[^\n]*\n?/g, '');
        generationWarnings.push('LLM_SYNTHESIS_APPLIED');
      }
    }
    markdownText = markdownText.replace(/[\t ]*\n?\s*__RUN19_ANALYSIS__\s*\n?/g, '\n');
    markdownText = markdownText.replace(/[\t ]*\n?\s*__RUN19_RISK__\s*\n?/g, '\n');
    const assets = [];
    for (const descriptor of manifest.assets) { const checked = await checkedSourceFile(root, runDir, descriptor); assets.push({ path: checked.path, markdownPath: descriptor.path }); }
    const d = await core.createDraft({ sessionId: b.sessionId, title: manifest.title, markdown: markdownText, assets, source: 'agent_inference', markers: [{ kind: 'source_provenance', ...pick(manifest, ['runId','sources','config','generator']), reviewGeneration: { analysisRequested, wantHistory, analysisPrompt, weknoraRetrieved: weknoraMaterials.length, webSearchExecuted: webMaterials.length > 0, warnings: generationWarnings } }] });
    const view = draftView(d); return { ...view, warnings: [...view.warnings, ...generationWarnings] };
  }
  async function publicationGuard(b) {
    const records = await core.listPublicationRecords(b);
    const latest = new Map(); for (const r of records) { if (r.itemKey !== undefined) continue; latest.set(r.planId, r); }
    if ([...latest.values()].some(r => ['submitted','unknown','executing'].includes(r.details?.phase))) fail('PUBLICATION_RECONCILIATION_REQUIRED');
  }
  const remoteIdValid = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x);
  const stateValue = x => typeof x === 'string' && ['pending','queued','processing','running','completed','failed','error','cancelled','canceled','not_started','skipped','none'].includes(x) ? x : undefined;
  // WeKnora folder mapping: derive `商品策略/<组>/周报` from the report title's variety. The variety→group map is
  // configurable via plugin config `commodityGroups` (install-host.patch.yml → report-review), so a new commodity
  // needs only a config entry, not a code change. Falls back to these built-in defaults when not configured.
  const DEFAULT_COMMODITY_GROUPS = { '锡': '有色/锡铝氧化铝锌', '铝': '有色/锡铝氧化铝锌', '氧化铝': '有色/锡铝氧化铝锌', '锌': '有色/锡铝氧化铝锌', '碳酸锂': '有色/碳酸锂' };
  function commodityGroups() {
    const g = config.commodityGroups;
    return (g && typeof g === 'object' && !Array.isArray(g)) ? g : DEFAULT_COMMODITY_GROUPS;
  }
  // A group is a folder-path fragment inside `商品策略/…/周报`; it must be a safe relative path (no traversal, no controls).
  const safeGroup = group => typeof group === 'string' && group.length > 0 && group.length <= 128
    && /^[A-Za-z0-9\u4e00-\u9fa5\-\/]+$/.test(group) && !/(^|\/)\.\.?($|\/)/.test(group) && !/[\x00-\x1f]/.test(group);
  function weeklyFolder(title) {
    const variety = deriveVariety(title);
    const group = commodityGroups()[variety];
    return { variety, folderPath: safeGroup(group) ? `商品策略/${group}/周报` : null, invalidGroup: group !== undefined && !safeGroup(group) };
  }
  function publicationView(plan, record) {
    const d = record?.details || {}, observation = d.reconciliation || {};
    const phase = ['submitted','unknown','executing','failed'].includes(d.phase) ? d.phase : record ? 'unknown' : 'planned';
    return { planId: plan.planId, versionId: plan.versionId, status: phase, phase,
      ...(remoteIdValid(d.remote?.id) ? { remoteId: d.remote.id } : {}),
      ...(stateValue(observation.parseStatus) ? { parseStatus: observation.parseStatus } : {}),
      parseReady: observation.parseReady === true, indexingVerified: false, published: false,
      outcomeUnknown: ['unknown','executing'].includes(phase), automaticRetry: false,
      ...(typeof observation.checkedAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(observation.checkedAt) ? { checkedAt: observation.checkedAt } : {}),
      message: observation.result === 'REMOTE_READ_FAILED' ? 'Read-only verification failed; do not retry upload.' : observation.result === 'NO_REMOTE_ID' ? 'No recorded remote ID; manual reconciliation required. No title search or upload retry was performed.' : observation.parseReady === true ? 'Parsing completed only; publication and retrieval acceptance remain unverified.' : phase === 'planned' ? 'Plan exists; no recorded upload attempt.' : 'Publication remains unverified; no automatic upload retry.',
      warnings: [...(observation.summaryPending === true ? ['SUMMARY_OR_SUBTASKS_PENDING'] : []), 'REMOTE_INDEXING_NOT_VERIFIED'] };
  }
  async function publicationStatus(b, input, reconcile = false) {
    if (Object.keys(input).some(k => !['action','sessionId','reportId','planId','saveToken'].includes(k))) fail('INVALID_INPUT');
    await draft(b);
    const lock = `${b.sessionId}\0${b.reportId}`;
    if (publishing.has(lock)) fail('PUBLICATION_IN_PROGRESS');
    if (reconcile) publishing.add(lock);
    try {
      let storedPlans = await core.listPublicationPlans(b);
      if (input.planId !== undefined) {
        if (!validString(input.planId)) fail('INVALID_INPUT');
        storedPlans = storedPlans.filter(p => p.planId === input.planId);
        if (!storedPlans.length) fail('NOT_FOUND');
      }
      const entries = await core.listPublicationRecords(b), latest = new Map();
      for (const r of entries) { if (r.itemKey !== undefined) continue; latest.set(r.planId, r); }
      const records = [];
      for (const plan of storedPlans) {
        let record = latest.get(plan.planId);
        if (reconcile && record) {
          const old = record.details || {}, remote = old.remote || {}, checkedAt = new Date().toISOString();
          let phase = ['submitted','unknown','executing','failed'].includes(old.phase) ? old.phase : 'unknown';
          let observation = { checkedAt, result: 'NO_REMOTE_ID', parseReady: false };
          let safeRemote = remoteIdValid(remote.id) ? { id: remote.id, knowledge_base_id: remoteIdValid(remote.knowledge_base_id) ? remote.knowledge_base_id : plan.target } : {};
          if (!remoteIdValid(remote.id)) { if (phase !== 'failed') phase = 'unknown'; }
          else {
            const connector = getConnector(), read = connector?.status || connector?.detail;
            let result;
            try { if (remoteIdValid(plan.target) && read && (!remote.knowledge_base_id || remote.knowledge_base_id === plan.target)) result = await read.call(connector, plan.target, remote.id); } catch { /* no remote retry, no raw diagnostics */ }
            const raw = result?.data?.data && !Array.isArray(result.data.data) ? result.data.data : result?.data;
            if (result?.ok === true && raw?.id === remote.id && raw.knowledge_base_id === plan.target) {
              const parseStatus = stateValue(raw.parse_status), summaryStatus = stateValue(raw.summary_status);
              observation = { checkedAt, result: 'REMOTE_READ_OK', parseReady: parseStatus === 'completed', ...(parseStatus ? {parseStatus} : {}),
                summaryPending: (summaryStatus !== undefined && !['completed','skipped','none'].includes(summaryStatus)) || (Number.isSafeInteger(raw.pending_subtasks_count) && raw.pending_subtasks_count > 0) };
              safeRemote = { ...safeRemote, ...(parseStatus ? {parse_status:parseStatus} : {}), ...(summaryStatus ? {summary_status:summaryStatus} : {}) };
              phase = 'submitted'; // parsing is not full publication acceptance; guard remains closed
            } else { observation.result = 'REMOTE_READ_FAILED'; if (phase === 'executing') phase = 'unknown'; }
          }
          record = await core.recordPublication({ ...b, planId: plan.planId, status: 'failed', details: { phase, versionId: plan.versionId, ...(hex(old.digest) ? {digest:old.digest} : {}), remote: safeRemote, reconciliation: observation } });
        }
        const view = publicationView(plan, record);
        // Surface per-item publication state and reconcile each verified item read-only (no re-upload).
        const itemRecords = await core.listPublicationItemRecords({ ...b, planId: plan.planId });
        const items = [];
        for (const ir of itemRecords) {
          const d = ir.details || {};
          let itemRemote = { ...(d.remote || {}) };
          if (reconcile && remoteIdValid(itemRemote.remoteId || itemRemote.id) && remoteIdValid(plan.target)) {
            const connector = getConnector();
            const read = (d.type === 'image' ? connector?.imageDetail : (connector?.status || connector?.detail));
            let result;
            try { if (read) result = await read.call(connector, plan.target, itemRemote.remoteId || itemRemote.id); } catch { /* no retry, no raw diagnostics */ }
            const raw = result?.data?.data && !Array.isArray(result.data.data) ? result.data.data : result?.data;
            if (result?.ok === true && raw?.id === (itemRemote.remoteId || itemRemote.id)) {
              const parseStatus = stateValue(raw.parse_status);
              itemRemote = { ...itemRemote, parse_status: parseStatus };
              await core.recordPublication({ ...b, planId: plan.planId, itemKey: ir.itemKey, status: 'failed', details: { ...d, remote: itemRemote, reconciledAt: new Date().toISOString() } });
            }
          }
          items.push({ itemKey: ir.itemKey, type: d.type, phase: d.phase, ...(itemRemote.remoteId || itemRemote.id ? { remoteId: itemRemote.remoteId || itemRemote.id } : {}), ...(d.resourceUri || itemRemote.file_path ? { resourceUri: d.resourceUri || itemRemote.file_path } : {}), parseStatus: itemRemote.parse_status, parseReady: itemRemote.parse_status === 'completed' });
        }
        view.items = items;
        records.push(view);
      }
      return { records, published: false, indexingVerified: false, warnings: ['READ_ONLY_REMOTE_RECONCILIATION','REMOTE_INDEXING_NOT_VERIFIED'] };
    } finally { if (reconcile) publishing.delete(lock); }
  }
  async function humanItems(b,input,save=false) {
    if (Object.keys(input).some(k=>!['action','sessionId','reportId','saveToken',...(save?['items']:[])].includes(k))) fail('INVALID_INPUT');
    if (!core.getHumanItems || (save && !core.saveHumanItems)) fail('HUMAN_ITEMS_UNAVAILABLE');
    const d = await draft(b);
    if (input.saveToken !== undefined && input.saveToken !== d.saveToken) fail('CONFLICT');
    if (save && (!validString(input.saveToken) || d.status !== 'draft')) fail(d.status === 'confirmed' ? 'REVISION_REQUIRED' : 'INVALID_INPUT');
    const value = save ? await core.saveHumanItems({...b,saveToken:input.saveToken,items:validateHumanItems(input.items)}) : await core.getHumanItems(b);
    return { ...pick(value,['reportId','saveToken','status']), items:(value.items || []).map(item=>pick(item,['id','annotationId','category','selected','visibility','publicSource','content','source','mappingConfidence','stale','unsupported','displayName','completedAt'])),
      warnings:['LOCAL_REVIEW_PREPARATION_ONLY','INDEPENDENT_HUMAN_ITEMS_NOT_PUBLISHED',...(value.warnings || []).filter(w=>['DELETED_RETRACTIONS_UNSUPPORTED','HUMAN_ITEM_TARGET_UNVERIFIED'].includes(w)),...((value.items||[]).some(i=>i.mappingConfidence==='low')?['LOW_CONFIDENCE_ANNOTATION_MAPPING']:[])] };
  }
  async function publishPlan(b, input) {
    const connector = getConnector(); if (!connector?.createReviewHost) fail('CONNECTOR_UNAVAILABLE');
    const i = await requireIdentity();
    if (!validString(config.publishKbId)) fail('PUBLISH_TARGET_REQUIRED');
    const version = await core.exportVersion({ ...b, versionId: input.versionId }); assertAuthor(version, i);
    await publicationGuard(b);
    let manifest;
    try { manifest = preparePublicationManifest(version, { kbId: config.publishKbId }); }
    catch (e) { if (e.code === 'UNSUPPORTED_ASSET_REFERENCE') fail('IMAGES_UNSUPPORTED'); throw e; }
    const itemMeta = manifest.items.map(it => ({ itemKey: it.key, type: it.type, title: it.title, hash: it.hash, ...(it.type === 'image' ? { assetId: it.assetId, sha256: it.sha256, caption: it.caption } : {}) }));
    // Persist frozen plan digest + per-item intents (resume-safe before any remote effect).
    const record = await core.savePublicationPlan({ ...b, versionId: version.versionId, target: config.publishKbId, payload: { digest: manifest.digest, title: manifest.title, items: itemMeta } });
    const publishToken = token();
    for (const [key, p] of plans) if (p.expiresAt < Date.now()) plans.delete(key);
    plans.set(publishToken, { ...b, versionId: version.versionId, planId: record.planId, digest: manifest.digest, authorId: i.authorId, kbId: config.publishKbId, expiresAt: Date.now() + ttl });
    return { planId: record.planId, versionId: version.versionId, digest: manifest.digest, publishToken, title: manifest.title,
      target: config.publishKbId, items: itemMeta, warnings: manifest.warnings,
      expiresAt: new Date(Date.now() + ttl).toISOString() };
  }
  async function publish(b, input) {
    if (input.userInitiated !== true) fail('HUMAN_CLICK_REQUIRED');
    const p = plans.get(input.publishToken);
    if (!p || p.sessionId !== b.sessionId || p.reportId !== b.reportId || p.versionId !== input.versionId || p.planId !== input.planId || p.digest !== input.digest || p.expiresAt < Date.now()) fail('PUBLISH_TOKEN_INVALID');
    plans.delete(input.publishToken); // one attempt, including validation failure; never reusable
    const lock = `${b.sessionId}\0${b.reportId}`;
    if (publishing.has(lock)) fail('PUBLICATION_IN_PROGRESS');
    publishing.add(lock);
    try {
      await draft(b); await publicationGuard(b);
      const i = await requireIdentity(), v = await core.exportVersion({ ...b, versionId: p.versionId }); assertAuthor(v, i);
      if (i.authorId !== p.authorId) fail('IDENTITY_CHANGED');
      const connector = getConnector(); if (!connector?.createReviewHost) fail('CONNECTOR_UNAVAILABLE');
      const port = connector.createReviewHost();
      let manifest; try { manifest = preparePublicationManifest(v, { kbId: p.kbId ?? config.publishKbId }); } catch (e) { fail(e.code || 'PUBLISH_REJECTED'); }
      if (manifest.digest !== p.digest) fail('PUBLISH_REJECTED');
      // Durable pessimistic intent BEFORE any remote effect; a crash requires reconcile, not blind retry.
      await core.recordPublication({ ...b, planId: p.planId, status: 'failed', details: { phase: 'executing', versionId: p.versionId, digest: p.digest } });
      const bindings = [], itemResults = [];
      for (const item of manifest.items) {
        const resultView = { itemKey: item.key, type: item.type, title: item.title, hash: item.hash, phase: 'intent' };
        await core.recordPublication({ ...b, planId: p.planId, itemKey: item.key, status: 'failed', details: { phase: 'intent', versionId: p.versionId, digest: p.digest, itemKey: item.key, type: item.type } });
        let remote = {};
        try {
          if (item.type === 'image') {
            const asset = v.assets.find(a => a.id === item.assetId);
            if (!asset || asset.sha256 !== item.sha256) fail('PUBLISH_REJECTED');
            const cap = port.approve({ operation: 'publishImage', kbId: p.kbId, title: item.title, path: asset.path, sha256: asset.sha256 });
            if (cap?.ok === false) fail('PUBLISH_REJECTED');
            const r = await port.execute(cap);
            if (r?.ok === true && r.data?.file_path) {
              bindings.push({ assetId: item.assetId, sha256: item.sha256, kbId: p.kbId, resourceUri: r.data.file_path, knowledgeId: r.data.id });
              remote = pick(r.data, ['id', 'file_path', 'parse_status']);
              resultView.phase = 'submitted';
            } else if (r?.outcome_unknown) resultView.phase = 'unknown'; else resultView.phase = 'failed';
          } else if (item.type === 'report') {
            const markdown = resolvePublicationMarkdown(manifest, bindings);
            const cap = port.approve({ operation: 'publishReport', kbId: p.kbId, title: item.title, content: markdown });
            if (cap?.ok === false) fail('PUBLISH_REJECTED');
            const r = await port.execute(cap);
            if (r?.ok === true) { remote = pick(r.data, ['id', 'parse_status']); resultView.phase = 'submitted'; }
            else if (r?.outcome_unknown) resultView.phase = 'unknown'; else resultView.phase = 'failed';
          } else if (item.type === 'human') {
            const cap = port.approve({ operation: 'publishManual', kbId: p.kbId, title: item.title, content: item.markdown });
            if (cap?.ok === false) fail('PUBLISH_REJECTED');
            const r = await port.execute(cap);
            if (r?.ok === true) { remote = pick(r.data, ['id', 'parse_status']); resultView.phase = 'submitted'; }
            else if (r?.outcome_unknown) resultView.phase = 'unknown'; else resultView.phase = 'failed';
          } else if (item.type === 'pdf') {
            // Re-render the PDF from the confirmed version (same annotation filter as the preview) and upload it
            // alongside the markdown so report + images + PDF land in the same folder, with the same title/tags.
            const pdfAnnotations = (v.annotations || []).filter(a => a.public === true && ['user_direct', 'user_prompt'].includes(a.source) && a.mappingConfidence !== 'low' && a.target && !['image', 'rule'].includes(a.kind)).map(a => ({ ...pick(a, ['id', 'source', 'public', 'displayName', 'completedAt']), target: pick(a.target, ['startLine', 'endLine', 'quote']) }));
            const pr = await pdf.render({ reportId: v.reportId, markdown: v.markdown, saveToken: v.versionId, assets: v.assets, annotations: pdfAnnotations });
            if (!validString(pr?.pdfPath, 8192)) fail('PDF_INVALID');
            // The report-pdf render lands in the pdf-cache dir, which may not be inside the connector's asset roots.
            // Stage a copy under the report asset tree (always inside the connector's data root) so the upload is trusted.
            let pdfPath = pr.pdfPath;
            const assetDir = v.assets.find(a => typeof a.path === 'string' && a.path)?.path;
            if (assetDir) {
              const dir = dirname(assetDir);
              const dest = join(dir, `publish-${v.versionId}-${sha256(v.markdown).slice(0, 12)}.pdf`);
              try { await mkdir(dir, { recursive: true }); await copyFile(pr.pdfPath, dest); pdfPath = dest; } catch { /* fall back to cache path */ }
            }
            const cap = port.approve({ operation: 'publishPdf', kbId: p.kbId, title: item.title, path: pdfPath });
            if (cap?.ok === false) fail('PUBLISH_REJECTED');
            const r = await port.execute(cap);
            if (r?.ok === true) { remote = pick(r.data, ['id', 'file_path', 'parse_status']); resultView.phase = 'submitted'; }
            else if (r?.outcome_unknown) resultView.phase = 'unknown'; else resultView.phase = 'failed';
          }
        } catch (e) {
          resultView.phase = 'failed';
          remote = { error: e.code || 'PUBLISH_REJECTED' };
        }
        if (resultView.phase === 'submitted') resultView.remoteId = (remote.id || remote.remoteId);
        if (remote.file_path) resultView.resourceUri = remote.file_path;
        if (remote.parse_status) resultView.parseStatus = remote.parse_status;
        await core.recordPublication({ ...b, planId: p.planId, itemKey: item.key, status: 'failed', details: { phase: resultView.phase, versionId: p.versionId, digest: p.digest, itemKey: item.key, type: item.type, remote, ...(resultView.phase === 'submitted' ? { remoteId: remote.id } : {}), ...(remote.file_path ? { resourceUri: remote.file_path } : {}) } });
        itemResults.push(resultView);
      }
      // Archive every successfully submitted item (markdown + images + PDF) into the variety's WeKnora folder so the
      // report and its files land in the same directory. Best-effort: a folder-move failure does not roll back uploads,
      // but unlike before it is now surfaced as a visible warning (not silently swallowed).
      const folder = weeklyFolder(v.title);
      const folderPath = folder.folderPath;
      const warnings = [];
      const submittedIds = itemResults.filter(r => ['report', 'image', 'pdf'].includes(r.type) && r.phase === 'submitted' && remoteIdValid(r.remoteId)).map(r => r.remoteId);
      if (folder.invalidGroup) {
        warnings.push(`商品分组映射值不合法（${folder.variety} → ${commodityGroups()[folder.variety]}），已跳过放置；产物保留在知识库根目录。请检查 report-review 的 commodityGroups 配置。`);
      } else if (folderPath && submittedIds.length && connector.moveToFolder) {
        let mv;
        try { mv = await connector.moveToFolder(p.kbId ?? config.publishKbId, submittedIds, folderPath); }
        catch (e) { mv = { ok: false, error: (e && e.code) || 'folder_move_failed' }; }
        if (mv?.ok === true) warnings.push(`已将 ${submittedIds.length} 条已提交条目（md/图/pdf）放入「${folderPath}」。`);
        else warnings.push(`放入文件夹失败：${mv?.error || 'folder_move_failed'}；已上传条目暂留知识库根目录，请只读核对后处理。`);
      } else if (submittedIds.length > 0) {
        warnings.push(`商品「${folder.variety || '(未识别)'}」未在 report-review 的 commodityGroups 配置分组映射，本期产物未放入周报文件夹（保留在知识库根目录）。请在配置中补充该商品分组。`);
      }
      // ---- Human-review signal (format-excluded) ----
      // When a human-revised version (v.baseVersionId → the LLM baseline) is published, compute what the human
      // changed vs the LLM baseline (ignoring pure Markdown formatting) and store it on the published report so
      // TokensCowork can learn/distill the reviewer's intent. weKnora keeps the corrected content as the
      // authoritative body; this structured, format-excluded mark is the machine-readable review record.
      const reportItem = itemResults.find(r => r.type === 'report' && r.phase === 'submitted' && remoteIdValid(r.remoteId));
      if (reportItem && v.baseVersionId && v.baseVersionId !== v.versionId && connector?.createReviewHost) {
        try {
          const base = await core.getVersion({ ...b, versionId: v.baseVersionId });
          if (base?.markdown && typeof base.markdown === 'string') {
            const review = extractReviewMarks(base.markdown, v.markdown);
            const payload = {
              baselineVersionId: v.baseVersionId, currentVersionId: v.versionId,
              formatOnly: review.formatOnly, substantive: review.substantive,
              edits: (review.edits || []).slice(0, 200).map(e => ({ op: e.op, text: (e.text || '').slice(0, 4000) })),
              authoredAt: new Date().toISOString(),
            };
            const port2 = connector.createReviewHost();
            const cap = port2.approve({ operation: 'setKnowledgeMetadata', kbId: p.kbId ?? config.publishKbId, knowledgeId: reportItem.remoteId, customMetadata: { review_marks: payload } });
            if (cap?.ok === false) { reportItem.reviewMarks = { error: cap.error }; warnings.push(`人工审阅标记写入失败：${cap.error}`); }
            else {
              const mr = await port2.execute(cap);
              reportItem.reviewMarks = { substantive: review.substantive, formatOnly: review.formatOnly };
              if (mr?.ok !== true) { reportItem.reviewMarks.error = mr?.error || 'failed'; warnings.push(`人工审阅标记写入失败：${mr?.error || 'failed'}`); }
              else warnings.push(`已记录人工审阅标记（${review.substantive ? `${review.edits.length} 处实质修改` : '仅格式变更，无实质改动'}）。`);
            }
          }
        } catch (e) { warnings.push(`人工审阅标记写入异常：${(e && e.code) || 'failed'}`); }
      }
      const anyUnknown = itemResults.some(r => r.phase === 'unknown');
      const anyFailed = itemResults.some(r => r.phase === 'failed');
      const phase = anyUnknown ? 'unknown' : (itemResults.length > 0 && itemResults.every(r => r.phase === 'submitted') ? 'submitted' : 'failed');
      await core.recordPublication({ ...b, planId: p.planId, status: 'failed', details: { phase, versionId: p.versionId, digest: p.digest, ...(warnings.length ? { warnings } : {}), items: itemResults.map(r => ({ itemKey: r.itemKey, type: r.type, phase: r.phase })) } });
      return { status: phase, published: false, indexingVerified: false, outcomeUnknown: phase === 'unknown', planId: p.planId, versionId: p.versionId, automaticRetry: false, items: itemResults, warnings,
        message: phase === 'submitted' ? '所有条目已提交上传；解析与检索未核验。请只读核对。' : phase === 'unknown' ? '部分条目上传结果未知；未自动重试，请只读核对后决定。' : '发布存在失败条目；未自动重传，请核对每条记录。' };
    } finally { publishing.delete(lock); }
  }
  async function dispatch(input, human = false) {
    const b = await binding(input);
    switch (input.action) {
      case 'identity': return identity();
      case 'list': if (!core.listDrafts) fail('LIST_UNAVAILABLE'); return { reports: (await core.listDrafts({ sessionId: b.sessionId })).map(draftView) };
      case 'get': return draftView(await draft(b));
      case 'create': if (input.assets?.length) fail('INVALID_INPUT'); return draftView(await core.createDraft({ sessionId: b.sessionId, title: input.title, markdown: input.markdown ?? '', source: human ? 'user_direct' : 'agent_inference' }));
      case 'save': await draft(b); return draftView(await core.saveDraft({ ...b, saveToken: input.saveToken, markdown: input.markdown, source: human ? 'user_direct' : (input.source === 'user_prompt' ? 'user_prompt' : 'agent_inference'), ...(!human && typeof input.instruction === 'string' ? { instruction: input.instruction } : {}) }));
      case 'preview': return preview(b, input);
      case 'versions': { await draft(b); const versions = await core.listVersions(b); return { versions: await Promise.all(versions.map(async v => draftView(await core.getVersion({ ...b, versionId: v.versionId })))) }; }
      case 'confirm': { if (!human) fail('HUMAN_CLICK_REQUIRED'); await draft(b); const i = await requireIdentity(); return draftView(await core.confirm({ ...b, saveToken: input.saveToken, author: { authorId: i.authorId, displayName: i.displayName } })); }
      case 'startRevision': { const d = await draft(b); const vs = input.versionId ? null : await core.listVersions(b); const versionId = input.versionId || vs?.at(-1)?.versionId; if (!versionId) fail('INVALID_INPUT'); return draftView(await core.startRevision({ ...b, versionId, saveToken: input.saveToken ?? d.saveToken })); }
      case 'humanItems': if (!human) fail('HUMAN_CLICK_REQUIRED'); return humanItems(b,input);
      case 'saveHumanItems': if (!human) fail('HUMAN_CLICK_REQUIRED'); return humanItems(b,input,true);
      case 'audit': if (!human) fail('HUMAN_CLICK_REQUIRED'); return audit(b);
      case 'publishPlan': if (!human) fail('HUMAN_CLICK_REQUIRED'); await draft(b); return publishPlan(b, input);
      case 'publish': if (!human) fail('HUMAN_CLICK_REQUIRED'); return publish(b, input);
      case 'publicationStatus': if (!human) fail('HUMAN_CLICK_REQUIRED'); return publicationStatus(b, input);
      case 'reconcile': if (!human) fail('HUMAN_CLICK_REQUIRED'); return publicationStatus(b, input, true);
      case 'generate': return generate(b, input);
      case 'templateList': if (!core.listPromptTemplates) fail('TEMPLATE_UNAVAILABLE'); return { templates: await core.listPromptTemplates({ sessionId: b.sessionId }) };
      case 'templateSave': if (!core.savePromptTemplate) fail('TEMPLATE_UNAVAILABLE'); return { template: await core.savePromptTemplate({ sessionId: b.sessionId, id: input.id, name: input.name, content: input.content }) };
      case 'templateDelete': if (!core.deletePromptTemplate) fail('TEMPLATE_UNAVAILABLE'); return { deleted: await core.deletePromptTemplate({ sessionId: b.sessionId, id: input.id }) };
      default: fail('ACTION_UNSUPPORTED');
    }
  }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  return Object.freeze({
    // Trusted Host only. Neither dispatchHuman nor publication tokens are exported as tools.
    dispatchHuman: input => dispatch(input, true),
    list: input => dispatch({ ...input, action: 'list' }, false),
    read: input => dispatch({ ...input, action: 'get' }, false),
    save: input => dispatch({ ...input, action: 'save' }, false),
    async fetchReview(request) {
      try {
        if (request.method !== 'POST') return json({ ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'POST required'} },405);
        const text = await request.text(); if (Buffer.byteLength(text) > maxBodyBytes) fail('BODY_TOO_LARGE');
        let input; try { input = JSON.parse(text); } catch { fail('INVALID_INPUT'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT');
        return json({ ok: true, value: await dispatch(input, true) });
      } catch (e) { return json(safeError(e), e.code === 'SESSION_FORBIDDEN' ? 403 : 400); }
    },
    async fetchPdf(request) {
      try {
        if (request.method !== 'GET') return json({ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'GET required'}},405);
        const u = new URL(request.url), input = Object.fromEntries(u.searchParams);
        if ([...u.searchParams.keys()].some(k => !['sessionId','reportId','digest'].includes(k)) || !hex(input.digest)) fail('INVALID_INPUT');
        const b = await binding(input), d = await draft(b), stored = previews.get(`${b.sessionId}\0${b.reportId}\0${input.digest}`);
        if (!stored) fail('PREVIEW_NOT_FOUND'); if (stored.saveToken !== d.saveToken) fail('PREVIEW_STALE');
        const bytes = await readFile(stored.path); if (bytes.subarray(0,5).toString() !== '%PDF-') fail('PDF_INVALID');
        if ((await draft(b)).saveToken !== stored.saveToken) fail('PREVIEW_STALE');
        return new Response(bytes, { headers: { 'content-type':'application/pdf', 'cache-control':'private, no-store', 'x-content-type-options':'nosniff', 'content-disposition':'inline; filename="report-preview.pdf"' } });
      } catch(e) { return json(safeError(e), e.code === 'SESSION_FORBIDDEN' ? 403 : e.code === 'PREVIEW_STALE' ? 409 : 404); }
    },
    dispose() { disposed = true; plans.clear(); previews.clear(); }
  });
}

export const inject = ['connection', 'reportCore', 'reportPdf', 'sessions'];
export function apply(ctx, config = {}) {
  const api = createReviewHost({ core: ctx.reportCore, pdf: ctx.reportPdf, sessions: ctx.sessions,
    getConnector: () => ctx.get('weknoraConnector'), getSource: () => ctx.get('weeklyReportSource'),
    getLlm: () => ctx.get('llm'), getDefaultModel: () => ctx.get('agentDefaultModel'), getWeb: () => ctx.get('web'),
    llmSynthesisEnabled: config.llmSynthesisEnabled !== false,
    llmSynthesisMaxTokens: config.llmSynthesisMaxTokens ?? 32000,
    llmSynthesisTimeoutMs: config.llmSynthesisTimeoutMs ?? 300000 }, config);
  ctx.provide('reportReview', api);
  ctx.connection.fetch.register({ path:'/api/run19/review', methods:['POST'], requestBody:'buffered', fetch: request => api.fetchReview(request) });
  ctx.connection.fetch.register({ path:'/api/run19/pdf', methods:['GET'], requestBody:'buffered', fetch: request => api.fetchPdf(request) });
  ctx.effect(() => () => api.dispose());
}
export default { name:'run19-report-review', inject, apply };

/** Explicit integration opt-in; register under an Agent scope. No publish/confirm/generic-dispatch tool. */
export function registerReviewTools(ctx, api = ctx.get('reportReview')) {
  const tools = ctx.get('tools'); if (!tools || !api) throw new Error('reportReview and tools required');
  const output = { schema: { type:'object', additionalProperties:true }, render: (_args,value) => [{type:'text',text:JSON.stringify(value)}] };
  const disposers = [];
  for (const mode of ['list','read','save']) {
    const properties = mode === 'list' ? {} : { reportId:{type:'string'} };
    if (mode === 'save') Object.assign(properties,{saveToken:{type:'string'},markdown:{type:'string'},source:{type:'string',enum:['user_prompt','agent_inference']},instruction:{type:'string'}});
    disposers.push(tools.register({ name:`run19_report_${mode}`,description: mode === 'list' ? 'List reports belonging to the current Agent session; never publishes.' : mode === 'read' ? 'Read the current Agent session report draft; never publishes.' : 'Save a report draft with optimistic concurrency and audited provenance; never confirms or publishes.',
      parameters:{type:'object',properties,required:mode === 'list' ? [] : mode === 'read' ? ['reportId'] : ['reportId','saveToken','markdown','source'],additionalProperties:false},output,
      async execute(args,exec) { if (!exec?.agent?.id) fail('SESSION_FORBIDDEN'); if (exec.signal?.aborted) fail('DISPOSED'); return api[mode]({...pick(args,Object.keys(properties)),sessionId:exec.agent.id}); }
    }));
  }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
