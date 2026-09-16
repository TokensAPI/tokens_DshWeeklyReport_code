import { readFile, realpath, lstat, copyFile, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { preparePublicationManifest, resolvePublicationMarkdown, publishedReportMarkdown } from './publication-manifest.mjs';
import { resolveFolderPath, moveArtifacts, DEFAULT_COMMODITY_GROUPS, SUBDIR } from './folder-move.mjs';
import { computeTimeline } from './timeline.mjs';
import { extractReviewMarks } from './review-marks.mjs';
import { mapChunks } from './chunk-map.mjs';

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
// A human asking to USE uploaded / library materials is a separate intent from "combine historical weekly
// reports". Without this, a prompt like "查找我昨天上传到数据库的材料…" fetches nothing from WeKnora because it
// does not mention 历史/对比. This regex makes the script (a) pull relevant knowledge-base fragments into context
// so the LLM can reason over them, independent of the wantHistory gate.
const KNOWLEDGE_RE = /(知识库|数据库|上传|上载|材料|资料|素材|附件|截屏|截图|文件|检索|搜索|查找|引用|路径|目录|文件夹|sheet|excel|pdf|wind|图表|数据表|剪贴板)/i;
// True when an LLM request failed because the assembled input exceeds the model's context window. We surface
// this as a distinct, user-actionable warning (reduce the reference scope) instead of a generic OR failure.
const isContextOverflow = e => /context\s*length|context[_\\-\s]?(length|size|window)|maximum\s*context|too\s*many\s*tokens|token\s*limit|exceeds?\s*(the\s*)?maximum|reduce\s*(the\s*)?(length|input|message)|input[\s_-]?too[\s_-]?large|maximum\s*(model\s*)?token/i.test(`${e?.message || ''} ${e?.code || ''} ${e?.error?.message || ''} ${e?.error?.code || ''}`);
const safeError = e => {
  const known = new Set(['NOT_FOUND','INVALID_INPUT','CONFLICT','DRAFT_EXISTS','REVISION_REQUIRED','ASSET_CORRUPT','SESSION_FORBIDDEN','IDENTITY_UNVERIFIED','IDENTITY_CHANGED','CONNECTOR_UNAVAILABLE','SOURCE_UNAVAILABLE','SOURCE_ROOT_REQUIRED','SOURCE_MANIFEST_INVALID','SOURCE_FILE_INVALID','SOURCE_HASH_MISMATCH','SOURCE_FAILED','WEB_SEARCH_UNAVAILABLE','KNOWLEDGE_SEARCH_FAILED','KNOWLEDGE_RESPONSE_INVALID','LIST_UNAVAILABLE','PUBLISH_TARGET_REQUIRED','IMAGES_UNSUPPORTED','PUBLICATION_RECONCILIATION_REQUIRED','PUBLISH_TOKEN_INVALID','HUMAN_CLICK_REQUIRED','PUBLICATION_IN_PROGRESS','PUBLISH_REJECTED','PREVIEW_STALE','PREVIEW_NOT_FOUND','PDF_INVALID','DISPOSED','BODY_TOO_LARGE','ACTION_UNSUPPORTED','HUMAN_ITEMS_UNAVAILABLE','HUMAN_ITEMS_PUBLICATION_UNSUPPORTED','UNSUPPORTED_ASSET_REFERENCE','UNREGISTERED_ASSET','AMBIGUOUS_ASSET_CAPTION','UNREFERENCED_ASSET','INVALID_PUBLIC_VERSION','INVALID_IMAGE_CAPTION','INVALID_PUBLIC_SOURCE','INVALID_PUBLIC_SOURCE_TIME','INVALID_PUBLIC_AUTHOR','UNSUPPORTED_PUBLIC_MARKDOWN','INVALID_OR_DUPLICATE_ASSET','INVALID_HUMAN_ITEM','PRIVATE_HUMAN_ITEM','HUMAN_ITEM_ASSET_UNSUPPORTED','HUMAN_CONTENT_NOT_IN_VERSION','HUMAN_ANNOTATION_MISMATCH','UNTRUSTED_MANIFEST','INVALID_RESOURCE_BINDING','RESOURCE_BINDING_MISMATCH','INCOMPLETE_RESOURCE_BINDINGS']);
  const code = known.has(e?.code) ? e.code : 'INTERNAL_ERROR';
  // Known codes pass their own message through so a coded failure can carry a sanitized cause suffix
  // (every producer is our own fail(), which defaults message to the code itself).
  return { ok: false, error: { code, message: code === 'INTERNAL_ERROR' ? 'Host operation failed; private diagnostics are not exposed.' : (e?.message || code) } };
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
    // P1 retrieval view (sanitized): what the plugin understood + the material it used, so the human can catch a
    // scope/intent mismatch on the spot.
    ...(d.markers || []).some(m => m?.kind === 'source_provenance' && m.reviewGeneration?.retrieval) ? { retrieval: (d.markers.find(m => m.kind === 'source_provenance')?.reviewGeneration?.retrieval || null) } : {},
    warnings: [...new Set([
      ...((d.annotations || []).some(a => a.mappingConfidence === 'low') ? ['LOW_CONFIDENCE_ANNOTATION_MAPPING'] : []),
      ...(d.markers || []).filter(m => m?.kind === 'source_provenance').flatMap(m => Array.isArray(m.reviewGeneration?.warnings) ? m.reviewGeneration.warnings : []).filter(w => ['KNOWLEDGE_RETRIEVED','KNOWLEDGE_SEARCH_FAILED','KNOWLEDGE_RESPONSE_INVALID','KNOWLEDGE_UNAVAILABLE','KNOWLEDGE_EXCERPTS_ARE_UNVERIFIED','KNOWLEDGE_VERSION_FILTER_NOT_IMPLEMENTED','KNOWLEDGE_SEARCH_EMPTY','KNOWLEDGE_RANGE_NOT_ENFORCED','KNOWLEDGE_FOLDER_EMPTY','RETRIEVAL_VERIFY_FAILED','RETRIEVAL_OFF_TOPIC','RETRIEVAL_GAPS','WEB_SEARCH_EXECUTED','WEB_SEARCH_FAILED','WEB_SEARCH_UNAVAILABLE','LLM_SYNTHESIS_APPLIED','LLM_SYNTHESIS_UNSUPPORTED','LLM_SYNTHESIS_NO_MODEL','LLM_SYNTHESIS_TIMEOUT','LLM_SYNTHESIS_EMPTY','LLM_SYNTHESIS_EMPTY_RETRY','LLM_SYNTHESIS_FAILED','LLM_SYNTHESIS_CONTEXT_OVERFLOW'].includes(w))
    ])] };
}

/** Trusted Host factory. dispatchHuman is for authenticated connection routes ONLY, never a model tool. */
export function createReviewHost({ core, pdf, sessions, getConnector = () => undefined, getSource = () => undefined, getLlm = () => undefined, getDefaultModel = () => undefined, getWeb = () => undefined, llmSynthesisEnabled = true, llmSynthesisMaxTokens = 32000, llmSynthesisTimeoutMs = 300000 }, config = {}) {
  const previews = new Map(), plans = new Map(), publishing = new Set();
  // ---- P3 seam: retrieval memory (self-evolution) ----
  // When the human corrects a retrieval scope ("不是笔记，是专题夹"), record it so the planner can reuse the lesson
  // and the SAME phrasing converges next time without re-prompting. Currently an in-memory session store; the
  // interface is stable so it can later be backed by a persistent store (report-core). Data shape per entry:
  // { variety, utterance, scope, correction, at }.
  const retrievalMemory = new Map(); // variety -> entries[]
  function lookupRetrievalMemory(sessionId, variety) { const k = JSON.stringify([sessionId, String(variety || '')]); return structuredClone((retrievalMemory.get(k) || []).slice(-6)); }
  function recordRetrievalCorrection(entry) {
    const variety = String(entry?.variety || '').trim();
    if (!variety || !validString(variety, 128)) return { ok: false, error: 'INVALID_VARIETY' };
    const item = {
      variety,
      utterance: validString(entry?.utterance, 2000) ? entry.utterance : '',
      scope: entry?.scope && typeof entry.scope === 'object' ? entry.scope : null,
      correction: validString(entry?.correction, 2000) ? entry.correction : '',
      at: new Date().toISOString(),
    };
    const key = JSON.stringify([entry.sessionId, variety]);
    const arr = retrievalMemory.get(key) || []; arr.push(structuredClone(item)); if (arr.length > 20) arr.shift(); retrievalMemory.set(key, arr);
    return { ok: true, at: item.at };
  }
  let disposed = false;
  if (config.allowedSessionIds !== undefined && (!Array.isArray(config.allowedSessionIds) || config.allowedSessionIds.some(x => !validString(x)))) fail('INVALID_INPUT');
  const allowed = config.allowedSessionIds === undefined ? null : new Set(config.allowedSessionIds);
  const maxBodyBytes = config.maxBodyBytes ?? 1024 * 1024;
  const ttl = config.publishTokenTtlMs ?? 5 * 60 * 1000;
  // Honor an explicit session whitelist. Without a live-registry gate, a report is addressed by its OWN sessionId (report-core enforces the
  // ownership match), so a caller may use any well-formed session to reach reports it stored — including a session
  // that is no longer live in the registry (e.g. after a restart). We only require a routable id.
  const binding = async input => {
    if (disposed) fail('DISPOSED');
    const sessionId = input?.sessionId;
    if (!validString(sessionId) || (allowed && !allowed.has(sessionId))) fail('SESSION_FORBIDDEN');
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
  // Human-readable version timeline: report-core version snapshots + adjacent diff, so the reviewer sees every
  // version and its delta without reconstructing anything (the WeKnora knowledge stays the machine signal layer).
  async function timeline(b) {
    await draft(b);
    const versions = await Promise.all((await core.listVersions(b)).map(async v => core.getVersion({ ...b, versionId: v.versionId })));
    // Which versions reached the knowledge base: any report-item publication record with a valid remote id and a
    // submitted/unknown phase. This is the "是否发布至数据库" signal shown in 版本历史 (replaces the old 发布记录 view).
    let publishedByVersion = {};
    try {
      const records = await core.listPublicationRecords(b);
      const published = new Set(); const latest = new Map();
      for (const r of records) { if (r.details?.type !== 'report') continue; const k = `${r.details?.versionId}\0${r.details?.remote?.id || r.details?.remoteId || ''}`; const prev = latest.get(k); if (!prev || (r.recordedAt || '') > (prev.recordedAt || '')) latest.set(k, r); }
      for (const r of latest.values()) { const vid = r.details?.versionId; const idOk = remoteIdValid(r.details?.remote?.id) || remoteIdValid(r.details?.remoteId); if (vid && idOk && ['submitted','unknown'].includes(r.details?.phase)) published.add(vid); }
      publishedByVersion = Object.fromEntries([...published].map(v => [v, true]));
    } catch { /* publication status is best-effort for the timeline view */ }
    return { ...computeTimeline(versions, publishedByVersion), reportId: b.reportId, title: versions[0]?.title, markdowns: Object.fromEntries(versions.map(v => [v.versionId, v.markdown])) };
  }
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
    if (wek.length) bodyParts.push(`【知识库材料（weknora，第 ${wek.map((_, i) => i + 1).join('/')} 篇分别标 ${wek.map((_, i) => wekLabel(i)).join('、')}，正文引用用对应标号）】\n${wek.map((m, i) => `${wekLabel(i)} ${m.title}\n${m.text}`).join('\n\n---\n\n')}`);
    if (web.length) bodyParts.push(`【联网信源材料（每条标 [id]）】\n${web.map(m => `[${m.id}] ${m.title}\n${m.text}`).join('\n\n---\n\n')}`);
    if (analysisPrompt) bodyParts.push(`【人类分析要求】\n${analysisPrompt}`);
    const body = bodyParts.filter(Boolean).join('\n\n---\n\n');
    const citeInstruction = wek.length
      ? (web.length ? '引用知识库材料处用“〔N〕”（如“〔1〕”），引用联网信源用“（[id]）”；结尾把实际引用的知识库材料各写一行“〔N〕来源：《文件名》”。' : '引用知识库材料处用“〔N〕”（如“〔1〕”）；结尾把实际引用的知识库材料各写一行“〔N〕来源：《文件名》”。')
      : '引用联网信源用“（[id]）”。';
    const defaultSections = wantHistory ? '“本周多空逻辑 → 与近四周周报的连贯性分析 → 风险提示”' : '“本周多空逻辑 → 风险提示”';
    const user = `你是投研分析师，为 ${variety} 周报撰写分析段落。下面给出了可用材料：【本周数据】${wek.length ? '与【知识库材料】' : ''}${web.length ? '与【联网信源材料】' : ''}。请**基于这些已提供的材料做梳理与推理**（不是凭空推测）：材料足以支撑的判断才写；材料不足以支撑的，说明缺少哪部分并给出仍可判断的内容，不要虚构，也不要引用材料之外的数据。${citeInstruction}\n\n请严格按【人类分析要求】列出的章节结构输出（简洁中文 Markdown，不要输出数据表）；【人类分析要求】未指明具体章节时，按${defaultSections}的常规结构综合输出。${wek.length ? `注意：${wantHistory ? '本次已提供知识库材料（含既往周报），请按用户要求综合使用' : '本次已提供知识库材料，请基于这些材料做推理并按“〔N〕”标注来源；不要虚构或引用材料之外的数据'}。` : ''}`;
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
  // Decide what (if anything) to pull from WeKnora from the HUMAN's prompt, not a fixed regex: the LLM reads the
  // analysis request and outputs whether to retrieve, whether it is about past weekly reports vs uploaded/library
  // material, the search queries, and any folder path the user named. The script (dead code) only EXECUTES that
  // intent (fetch the fragments). Falls back to a deterministic heuristic only when no LLM is available (tests /
  // degraded env), so generation still behaves deterministically.
  const WEEKS_RE = /近\s*([0-9一二三四五六七八九十两]+)\s*周|近几周|近四周|过去\s*([0-9一二三四五六七八九十两]+)\s*周|前\s*([0-9一二三四五六七八九十两]+)\s*周/;
  function extractWeeksBack(prompt) {
    const m = String(prompt || '').match(WEEKS_RE);
    if (!m) return 0;
    const cn = m[1] || m[2] || m[3];
    if (!cn) return 4; // 近几周 / 近四周
    const cnMap = { '一':1, '二':2, '两':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9, '十':10 };
    const v = /^\d+$/.test(cn) ? Number(cn) : cnMap[cn];
    return (Number.isInteger(v) && v >= 1 && v <= 52) ? v : 4;
  }
  function heuristicPlan(request, analysisPrompt) {
    const wantHistory = !NO_HISTORY_RE.test(analysisPrompt) && HISTORY_RE.test(analysisPrompt);
    const wantKnowledge = !NO_HISTORY_RE.test(analysisPrompt) && (wantHistory || KNOWLEDGE_RE.test(analysisPrompt));
    const weeksBack = wantHistory ? extractWeeksBack(analysisPrompt) : 0;
    const kind = wantHistory ? 'history_weeks' : (wantKnowledge ? 'uploaded' : 'none');
    // Semantic-essence query = variety (+ 周报/主题 hint). NEVER the time/folder scope words — those are separate
    // structured fields (weeksBack / folderPath / kind) that the fetch layer must enforce.
    return { enabled: wantKnowledge, wantHistory, kind, weeksBack, folderPath: null, queries: [request.variety || ''].filter(Boolean), source: 'heuristic' };
  }
  /** Map a folder reference from the plan (exact path, suffix, or short folder name like "笔记") to a real
   *  WeKnora folder path. Returns the exact path or null. The LLM gets the folder list, so this is only a safety
   *  net when the user names a folder in prose and the planner returns a short/relative path. */
  async function resolveKbFolderPath(connector, kbId, folderPath) {
    const norm = String(folderPath || '').trim().replace(/\/+$/, '');
    if (!norm) return null;
    if (!connector?.listKnowledge || !validString(kbId)) return null;
    try {
      const fl = await connector.listKnowledge(kbId, { page: 1, pageSize: 1000 });
      if (fl?.ok !== true || !Array.isArray(fl.data?.data)) return null;
      const folders = [...new Set(fl.data.data.map(r => r.folder_path).filter(p => typeof p === 'string' && p.trim()))].filter(Boolean);
      if (folders.includes(norm)) return norm;
      const suffix = folders.find(f => f.endsWith('/' + norm));
      if (suffix) return suffix;
      const last = norm.split('/').pop();
      return folders.find(f => f.split('/').pop() === last) || null;
    } catch { return null; }
  }
  async function planKnowledgeRetrieval({ llm, model, request, analysisPrompt, connector, kbId, memory = [] }) {
    if (!analysisPrompt) return { enabled: false, wantHistory: false, kind: 'none', weeksBack: 0, queries: [], folderPath: null, source: 'none' };
    if (!llm?.stream || !validString(model?.provider, 64) || !validString(model?.model, 128)) return heuristicPlan(request, analysisPrompt);
    // Give the LLM the REAL folder tree so a "笔记文件夹里的材料" request resolves to an exact path. The script
    // (dead code) enumerates folders; the LLM (judgment) just picks which one the user meant. Hybrid-search can't
    // filter by folder, so this is the only way a user-named folder becomes an enforceable retrieval scope.
    let folderContext = '';
    if (connector?.listKnowledge && validString(kbId)) {
      try {
        const fl = await connector.listKnowledge(kbId, { page: 1, pageSize: 1000 });
        const folders = (fl?.ok === true && Array.isArray(fl.data?.data))
          ? [...new Set(fl.data.data.map(r => r.folder_path).filter(p => validString(p, 256) && p.trim()))].filter(Boolean)
          : [];
        if (folders.length) folderContext = `\n知识库当前可用的文件夹路径（folderPath 必须从中选 1 个完整路径，不要改成短名/相对名/自己改写）：\n${folders.slice(0, 80).map(p => '- ' + p).join('\n')}\n`;
      } catch { folderContext = ''; }
    }
    // P3 seam: replay prior human corrections so the planner learns the user's vocabulary and converges without re-prompt.
    let memoryContext = '';
    if (Array.isArray(memory) && memory.length) {
      const lines = memory.map(m => `- 原表述：「${m.utterance || ''}」 → 当时理解为：${JSON.stringify(m.scope || {})} → 纠正为：${m.correction || ''}`).join('\n');
      memoryContext = `\n用户对这类请求曾经的纠正记录（据此理解他的习惯表述，别再重复同样的误判；若本次请求与某条纠正情境类似，请直接采用纠正后的范围）：\n${lines}\n`;
    }
    const prompt = `你是数据检索规划器。用户的分析要求：${analysisPrompt}\n${folderContext}${memoryContext}当前报告品种：${request.variety || ''}；周期：${request.start || ''}~${request.end || ''}。\n请判断是否需要从知识库（weknora）检索补充材料，以及检索什么。只输出一个 JSON 对象，不要任何多余文字：\n{"enabled":true,"wantHistory":false,"kind":"history_weeks","weeksBack":4,"folderPath":"","queries":["锡 周报 综合分析"]}\n其中：enabled=是否需要检索；wantHistory=是否要结合历史（影响“连贯性”章节）；kind 只能是 history_weeks|uploaded|mixed；weeksBack=要回溯几周（如近四周=4，无则 0）；folderPath=用户指定要参考的文件夹，若用户提到某个文件夹（如“笔记”），或用户表达要结合既往（如“近几周/近四周/结合以往周报”），请从上方的“可用文件夹路径”中选 1 个完整路径（历史周报通常对应“……/周报”），没有则空字符串，**不要臆造路径**；**queries 必须是语义精华检索词（品种+主题+材料类型），严禁把“近几周/近四周/时间/路径/文件夹”这类范围词写进 queries**（时间用 weeksBack、路径用 folderPath、材料类型用 kind 表达）。`;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), llmSynthesisTimeoutMs);
    try {
      let text = '';
      for await (const c of llm.stream({ provider: model.provider, model: model.model, messages: [{ id: token(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'run19-report-review' } }], system: '你只输出 JSON 对象。', temperature: 0, maxTokens: 512, signal: controller.signal })) {
        if (c.type === 'text-delta') text += c.text; else if (c.type === 'finish') break;
      }
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('planner_no_json');
      const p = JSON.parse(m[0]);
      const weeksBack = Number.isInteger(p?.weeksBack) ? Math.min(Math.max(p.weeksBack, 0), 52) : (p?.wantHistory ? extractWeeksBack(analysisPrompt) : 0);
      return {
        enabled: p?.enabled !== false,
        wantHistory: p?.wantHistory === true,
        kind: ['history_weeks', 'uploaded', 'mixed'].includes(p?.kind) ? p.kind : (p?.wantHistory ? 'history_weeks' : 'uploaded'),
        weeksBack,
        queries: Array.isArray(p?.queries) ? p.queries.filter(q => typeof q === 'string' && q.trim()).map(q => q.trim().slice(0, 512)).slice(0, 3) : [],
        folderPath: (typeof p?.folderPath === 'string' && p.folderPath.trim()) ? p.folderPath.trim().slice(0, 256) : null,
        source: 'llm',
      };
    } catch { return heuristicPlan(request, analysisPrompt); }
    finally { clearTimeout(timer); }
  }
  /** P2 grounded verifier. Takes the human intent + the retrieved materials, judges on-topic/gaps, optionally
   *  re-queries (bounded) to fill gaps, and returns which materials to actually synthesize. Only judges from the
   *  given fragments (never invents); a parse/failure returns `applied:false` so the caller falls back to "use all"
   *  rather than dropping material on a flaky LLM. */
  async function verifyRetrieval({ llm, model, analysisPrompt, plan, materials, requery, maxRounds = 1 }) {
    if (!llm?.stream || !validString(model?.provider, 64) || !validString(model?.model, 128)) return { applied: false, note: 'NO_LLM' };
    if (!Array.isArray(materials) || !materials.length) return { applied: false, note: 'NO_MATERIALS' };
    let current = materials.slice();
    const seen = new Set(current.map(m => m.id));
    let onTopic = true, gaps = [], skipped = [], reQueries = [], rounds = 0, note = '';
    while (rounds <= maxRounds) {
      const summary = current.slice(0, 24).map((m, i) => `${i + 1}. ${m.title || m.knowledgeId || '未命名'}：${String(m.text || '').slice(0, 300).replace(/\n+/g, ' ')}`).join('\n');
      const scopeDesc = JSON.stringify({ kind: plan?.kind, weeksBack: plan?.weeksBack, folderPath: plan?.folderPath, queries: plan?.queries });
      const prompt = `你是检索核验器。用户的分析要求：${analysisPrompt}\n检索范围：${scopeDesc}。\n下面是从知识库检回的材料（每条=一个来源文档，含标题与开头）。请判断这些材料与用户本意是否一致。只输出 JSON，不要多余文字：\n{"on_topic":true,"gaps":["缺少什么（无需补则空数组）"],"re_queries":["需补充检索的词（≤2，无需补则空数组）"],"skip":[1,3],"note":"一句话结论"}\n其中：on_topic=是否整体贴合用户本意；gaps=还缺什么；re_queries=若本意未被满足，可再检索的词（≤2 个，只填语义词，不填文件夹/时间）；skip=与本意明显无关、应剔除的材料序号（从 1 开始，无则空数组）；note=一句话结论。务必只依据给出的材料判断，不臆测材料之外的内容。\n\n【检回材料】\n${summary}`;
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), llmSynthesisTimeoutMs);
      let text = '';
      try {
        for await (const c of llm.stream({ provider: model.provider, model: model.model, messages: [{ id: token(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'run19-report-review' } }], system: '只输出 JSON 对象；只依据给出的材料判断，不臆测不存在的内容。', temperature: 0, maxTokens: 600, signal: controller.signal })) {
          if (c.type === 'text-delta') text += c.text; else if (c.type === 'finish') break;
        }
      } catch { return { applied: false, note: 'VERIFY_FAILED', warnings: ['RETRIEVAL_VERIFY_FAILED'] }; }
      finally { clearTimeout(timer); }
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return { applied: false, note: 'VERIFY_NO_JSON', warnings: ['RETRIEVAL_VERIFY_FAILED'] };
      let v; try { v = JSON.parse(m[0]); } catch { return { applied: false, note: 'VERIFY_NO_JSON', warnings: ['RETRIEVAL_VERIFY_FAILED'] }; }
      onTopic = v?.on_topic !== false;
      gaps = Array.isArray(v?.gaps) ? v.gaps.filter(g => typeof g === 'string' && g.trim()).slice(0, 3) : [];
      skipped = Array.isArray(v?.skip) ? v.skip.filter(n => Number.isInteger(n) && n >= 1).slice(0, 8) : [];
      note = validString(v?.note, 300) ? v.note : '';
      reQueries = Array.isArray(v?.re_queries) ? v.re_queries.filter(q => typeof q === 'string' && q.trim()).slice(0, 2) : [];
      if (reQueries.length === 0 || rounds >= maxRounds || typeof requery !== 'function') break;
      rounds++;
      const added = [];
      for (const q of reQueries) {
        try {
          const rows = await requery(q) || [];
          for (const row of rows) {
            if (!row || !row.id || seen.has(row.id)) continue;
            seen.add(row.id);
            added.push(row);
          }
        } catch { /* ignore a single requery failure */ }
      }
      if (added.length) current = current.concat(added);
    }
    const skipSet = new Set(skipped);
    return {
      applied: true, onTopic, gaps, reQueries, note, requeryRounds: rounds,
      skippedNames: current.filter((m, i) => skipSet.has(i + 1)).map(m => m.title || m.knowledgeId || String(m.id)),
      kept: current.filter((m, i) => !skipSet.has(i + 1)).slice(0, 40),
      warnings: [],
    };
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
    // The decision to pull from WeKnora is prompt-driven (LLM identifies the intent), not a fixed regex. When the
    // LLM is unavailable we fall back to a deterministic heuristic so generation still behaves predictably.
    const plan = analysisRequested
      ? await planKnowledgeRetrieval({ llm: getLlm(), model: getDefaultModel()?.currentSelection?.(), request, analysisPrompt, connector: getConnector(), kbId: config.publishKbId, memory: lookupRetrievalMemory(b.sessionId, request.variety) })
      : { enabled: false, wantHistory: false, queries: [], folderPath: null, source: 'none' };
    const wantHistory = plan.wantHistory;
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
    let retrievalSummary = null; // P1 view: what the plugin understood + the material it actually used.
    // Fetch wherever the LLM-planned intent says to. Each query returns relevance-ranked fragments (all hits);
    // results are grouped per source doc (knowledge_id), deduplicated and bounded, so overlapping queries (past
    // weekly reports + uploaded material) do not duplicate a doc. Image/asset knowledge (charts) is kept.
    if (plan.enabled) {
      const connector = getConnector();
      if (connector?.search && validString(config.publishKbId)) {
        const requested = typeof input.knowledgeQuery === 'string' && input.knowledgeQuery.trim();
        const queries = (Array.isArray(plan.queries) && plan.queries.length ? plan.queries : [request.variety || '']).filter(q => validString(q, 8192));
        if (requested && !queries.includes(input.knowledgeQuery)) queries.unshift(input.knowledgeQuery.trim().slice(0, 8192));
        const matchCount = (typeof config.knowledgeMatchCount === 'number' && Number.isInteger(config.knowledgeMatchCount) && config.knowledgeMatchCount >= 1 && config.knowledgeMatchCount <= 100) ? config.knowledgeMatchCount : 100;
        const MAX_FRAGMENTS_PER_DOC = 6, MAX_FRAGMENT_CHARS = 3072;
        const perDoc = new Map(); // knowledge_id -> { id, title, knowledgeId, fragments:[] }
        // ---- Scope bounding (time window + folder) via WeKnora's list endpoint ----
        // The human asks for a TIME window ("近N周") and/or a FOLDER ("路径下材料"). WeKnora hybrid-search cannot
        // filter by date/folder, so we ENUMERATE the scoped knowledge ids first (list endpoint supports folder_path,
        // folder_recursive and start_time/end_time), then bound the semantic search to that id set (knowledge_ids).
        // This makes in-window / in-folder material load even when its title lacks the exact query words.
        const hasTimeScope = Number.isInteger(plan.weeksBack) && plan.weeksBack > 0;
        const startTime = hasTimeScope ? new Date(Date.now() - plan.weeksBack * 7 * 24 * 3600 * 1000).toISOString() : undefined;
        // Option A: the source folder comes ONLY from the LLM plan (folderPath). No config/commodity-group
        // derivation is applied to retrieval — the human's intent is judged by the LLM, and the script just
        // executes the scope it chose. (Publish placement still uses commodityGroups separately.)
        let scopeFolder = plan.folderPath || null;
        const wantsScope = hasTimeScope || !!scopeFolder;
        let scopedIds = null, scopeStatus = 'none'; // 'none' | 'ok' | 'empty' | 'failed'
        if (wantsScope && typeof connector.listKnowledge === 'function') {
          try {
            let scopePath = scopeFolder || undefined;
            const listRes = await connector.listKnowledge(config.publishKbId, { folderPath: scopePath, recursive: true, startTime, page: 1, pageSize: 200 });
            let rows = (listRes?.ok === true && Array.isArray(listRes.data?.data)) ? listRes.data.data : null;
            // A user-named folder that didn't resolve exactly (e.g. planner returned a short name) -> map it to the
            // real tree once, so "笔记" becomes the true <...>/笔记 path instead of silently yielding nothing.
            if (scopeFolder && (rows === null || rows.length === 0)) {
              const resolved = await resolveKbFolderPath(connector, config.publishKbId, scopeFolder);
              if (resolved && resolved !== scopeFolder) {
                const r2 = await connector.listKnowledge(config.publishKbId, { folderPath: resolved, recursive: true, startTime, page: 1, pageSize: 200 });
                if (r2?.ok === true && Array.isArray(r2.data?.data)) { rows = r2.data.data; scopeFolder = resolved; }
              }
            }
            if (rows) {
              scopedIds = rows.map(r => r.id).filter(id => validString(id, 128)).slice(0, 500);
              scopeStatus = scopedIds.length ? 'ok' : 'empty';
            } else scopeStatus = 'failed';
            // If the user named a folder but it resolved to zero readable items, surface that clearly rather than a bare "empty".
            if (scopeStatus === 'empty' && scopeFolder && !hasTimeScope) generationWarnings.push('KNOWLEDGE_FOLDER_EMPTY');
          } catch { scopeStatus = 'failed'; }
        } else if (wantsScope) scopeStatus = 'failed';
        let searchOpts = null;
        try {
          // Semantic content search. When the scope resolved, return ONLY docs inside the scoped id set
          // (knowledge_ids), so no out-of-window / out-of-folder material leaks in. When the scope resolved empty,
          // there is genuinely nothing in scope — do not fall back to an unbounded search.
          if (scopeStatus === 'empty') {
            generationWarnings.push('KNOWLEDGE_EMPTY');
          } else {
            searchOpts = { matchCount };
            if (scopeStatus === 'ok' && Array.isArray(scopedIds) && scopedIds.length) searchOpts.knowledgeIds = scopedIds;
            for (const query of queries) {
              const found = await connector.search(config.publishKbId, query, searchOpts);
              if (found?.ok !== true || !Array.isArray(found.data?.data)) continue;
              for (const row of (found.data.data || [])) {
                if (!row || !validString(row.content, 32768)) continue;
                const kid = row.knowledge_id;
                const key = validString(row.id, 128) ? row.id : (kid || `w-${perDoc.size + 1}`);
                const docKey = kid || key;
                const title = validString(row.knowledge_title, 512) ? row.knowledge_title : (kid || key);
                const frag = (row.content || '').trim().slice(0, MAX_FRAGMENT_CHARS);
                if (!frag) continue;
                const doc = perDoc.get(docKey) || { id: key, title, knowledgeId: kid || null, fragments: [] };
                if (doc.fragments.length < MAX_FRAGMENTS_PER_DOC && !doc.fragments.includes(frag)) doc.fragments.push(frag);
                perDoc.set(docKey, doc);
              }
            }
            // If the scope resolved but the semantic query surfaced nothing (e.g. pure "give me that folder's
            // material" with no content query), pull each scoped document's chunks directly so nothing is missed.
            if (scopeStatus === 'ok' && Array.isArray(scopedIds) && scopedIds.length && perDoc.size === 0 && typeof connector.chunks === 'function') {
              for (const id of scopedIds.slice(0, 40)) {
                try {
                  const cr = await connector.chunks(config.publishKbId, id, { page: 1, pageSize: 100 });
                  if (cr?.ok === true && Array.isArray(cr.data?.data)) {
                    const frags = cr.data.data.map(c => (c.content || '').trim()).filter(Boolean).slice(0, MAX_FRAGMENTS_PER_DOC);
                    if (frags.length) perDoc.set(id, { id, title: id, knowledgeId: id, fragments: frags });
                  }
                } catch { /* ignore a single doc's chunk failure */ }
              }
            }
            for (const doc of perDoc.values()) weknoraMaterials.push({ kind: 'weknora', id: doc.id, knowledgeId: doc.knowledgeId, title: doc.title, text: doc.fragments.join('\n') });
            if (weknoraMaterials.length) generationWarnings.push('KNOWLEDGE_RETRIEVED');
            else generationWarnings.push('KNOWLEDGE_EMPTY');
          }
        } catch { generationWarnings.push('KNOWLEDGE_SEARCH_FAILED'); }
        // P2 grounded verifier: judge whether what came back matches the human's intent, re-query bounded to fill
        // gaps, and keep only materials it confirmed on-topic. Graceful: a failed/absent verifier keeps all material
        // unchanged (never drops on a flaky LLM).
        let retrievalVerification = null;
        if (config.retrievalVerification !== false && plan.enabled && weknoraMaterials.length && connector?.search && typeof getLlm === 'function' && getLlm()?.stream && validString(getDefaultModel()?.currentSelection?.()?.provider, 64)) {
          const v = await verifyRetrieval({
            llm: getLlm(), model: getDefaultModel()?.currentSelection?.(), analysisPrompt, plan,
            materials: weknoraMaterials,
            requery: async (q) => {
              if (!connector.search) return [];
              const found = await connector.search(config.publishKbId, q, searchOpts);
              if (found?.ok !== true || !Array.isArray(found.data?.data)) return [];
              return found.data.data.filter(row => row && validString(row.content, 32768)).map(row => {
                const kid = row.knowledge_id, key = validString(row.id, 128) ? row.id : (kid || '');
                return { kind: 'weknora', id: key, knowledgeId: kid || null, title: validString(row.knowledge_title, 512) ? row.knowledge_title : (kid || key), text: (row.content || '').trim().slice(0, 3072) };
              });
            },
          });
          retrievalVerification = v;
          if (v.applied && Array.isArray(v.kept)) weknoraMaterials = v.kept;
          if (Array.isArray(v.warnings) && v.warnings.length) generationWarnings.push(...v.warnings);
          if (v.applied && !v.onTopic) generationWarnings.push('RETRIEVAL_OFF_TOPIC');
          else if (v.applied && Array.isArray(v.gaps) && v.gaps.length) generationWarnings.push('RETRIEVAL_GAPS');
        }
        // P1 view: a sanitized record of what the plugin understood (planned scope) and the material it actually
        // used, so the human can see the intent->material bridge and catch a misunderstanding before it compounds.
        retrievalSummary = {
          scope: { kind: plan.kind, weeksBack: plan.weeksBack, folderPath: scopeFolder, queries: plan.queries, source: plan.source, scopeStatus, scopedCount: (scopedIds?.length || 0), hasTimeScope },
          used: weknoraMaterials.map(m => ({ title: validString(m.title, 256) ? m.title : (m.knowledgeId || '未知'), knowledgeId: m.knowledgeId || null })),
          verification: retrievalVerification ? { applied: retrievalVerification.applied, onTopic: retrievalVerification.onTopic, gaps: retrievalVerification.gaps, reQueries: retrievalVerification.reQueries, skipped: retrievalVerification.skippedNames, note: retrievalVerification.note } : null,
        };
        // Scope was requested but could NOT be bounded (listKnowledge unavailable or errored) -> surface it.
        if (wantsScope && scopeStatus === 'failed') generationWarnings.push('KNOWLEDGE_RANGE_NOT_ENFORCED');
      } else generationWarnings.push('KNOWLEDGE_UNAVAILABLE');
    }
    // Surface only the inner machine code (GENERATION_FAILED / GENERATION_TIMEOUT / spawn errno); stderr and
    // failure.json contents stay private, but a bare SOURCE_FAILED made field diagnosis near-impossible.
    let manifest; try { manifest = await source.generate(request); } catch (error) { const cause = /^[A-Z0-9_]{1,40}$/.test(error?.code || '') ? error.code : 'UNKNOWN'; fail('SOURCE_FAILED', `SOURCE_FAILED(cause=${cause})`); }
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
    const d = await core.createDraft({ sessionId: b.sessionId, title: manifest.title, markdown: markdownText, assets, source: 'agent_inference', markers: [{ kind: 'source_provenance', ...pick(manifest, ['runId','sources','config','generator']), reviewGeneration: { analysisRequested, wantHistory, analysisPrompt, weknoraRetrieved: weknoraMaterials.length, webSearchExecuted: webMaterials.length > 0, warnings: generationWarnings, ...(retrievalSummary ? { retrieval: retrievalSummary } : {}) } }] });
    const view = draftView(d); return { ...view, warnings: [...view.warnings, ...generationWarnings] };
  }
  async function publicationGuard(b, { versionId } = {}) {
    const records = await core.listPublicationRecords(b);
    const latest = new Map(); for (const r of records) { if (r.itemKey !== undefined) continue; latest.set(r.planId, r); }
    const pending = [...latest.values()].filter(r => ['submitted','unknown','executing'].includes(r.details?.phase));
    // A genuinely in-flight publish (phase 'executing') must never overlap a new one.
    if (pending.some(r => ['executing', 'unknown'].includes(r.details?.phase) || r.details?.versionId === versionId)) fail('PUBLICATION_RECONCILIATION_REQUIRED');
    // A submitted older version is surfaced as a warning; unknown outcomes and same-version repeats remain blocked. The human is
    // explicitly initiating a fresh publish (userInitiated=true + one-time token) and may proceed; reconcile stays
    // available for read-only verification.
    return pending.map(r => `存在未核验的发布记录（阶段 ${r.details?.phase}，版本 ${r.details?.versionId}）；建议先「只读核对」，本提示不阻止新版本发布。`);
  }
  const remoteIdValid = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x);
  const stateValue = x => typeof x === 'string' && ['pending','queued','processing','running','completed','failed','error','cancelled','canceled','not_started','skipped','none'].includes(x) ? x : undefined;
  // WeKnora folder placement is delegated to the standalone, fail-soft folder-move module. The variety→group
  // map is configurable via `config.commodityGroups` (install-host.patch.yml → report-review); `config.folderRoot`
  // is the configurable root prefix (default `商品策略`). A new commodity needs only a config entry, not code.
  function commodityGroups() {
    const g = config.commodityGroups;
    return (g && typeof g === 'object' && !Array.isArray(g)) ? g : DEFAULT_COMMODITY_GROUPS;
  }
  // ---- Single-knowledge human-review flow ----
  // The report's published knowledge is REUSED across versions so weKnora records a single
  // evolving knowledge with `source_content`=LLM baseline, `content`=current human version and a
  // `chunk_revisions` history (edit_source='user'). On first publish we seed with the LLM baseline
  // and rewrite changed chunks to the human version; on later publishes we patch in place.
  async function findPublishedReportKnowledge(b) {
    const records = await core.listPublicationRecords(b);
    let best = null;
    for (const r of records) {
      if (r?.details?.type !== 'report') continue;
      const id = r.details?.remote?.id || r.details?.remoteId;
      if (!remoteIdValid(id) || !['submitted', 'unknown'].includes(r.details?.phase)) continue;
      if (!best || (r.recordedAt || '') > (best.recordedAt || '')) best = r;
    }
    return best ? (best.details.remote?.id || best.details.remoteId) : null;
  }
  // The LLM baseline is the version at the root of the chain (baseVersionId == null).
  async function llmBaselineVersion(b, versionId) {
    let v = await core.getVersion({ ...b, versionId });
    const seen = new Set([v.versionId]);
    while (v.baseVersionId && !seen.has(v.baseVersionId)) { seen.add(v.baseVersionId); v = await core.getVersion({ ...b, versionId: v.baseVersionId }); }
    return v;
  }
  // Rewrite a published knowledge's chunks from `baseMarkdown` to `targetMarkdown`, so weKnora
  // records each changed chunk as a user edit (content_revision/last_editor_id/chunk_revisions).
  async function rewriteReportChunks(connector, port, kbId, knowledgeId, baseMarkdown, targetMarkdown) {
    const warnings = [];
    const rd = await connector.chunks?.(kbId, knowledgeId);
    const chunks = (rd?.ok === true ? rd.data?.data : null) || null;
    if (!Array.isArray(chunks)) return { patched: 0, unmapped: 0, warnings: ['读取分块失败：无法定位已发布知识的 chunk，已跳过增量回写。'] };
    const mapped = mapChunks(baseMarkdown, targetMarkdown, chunks);
    let patched = 0, unmapped = 0;
    for (const m of mapped) {
      if (m.error === 'unmapped') { unmapped++; continue; }
      if (!m.changed || !m.chunkId) continue;
      const body = { operation: 'updateChunk', kbId, knowledgeId, chunkId: m.chunkId, expectedRevision: m.expectedRevision };
      if (m.content === '') { body.isEnabled = false; } else { body.content = m.content; }
      const cap = port.approve(body);
      if (cap?.ok === false) { warnings.push(`分块回写失败（${m.chunkId}）：${cap.error}`); continue; }
      const r = await port.execute(cap);
      if (r?.ok === true) patched++; else warnings.push(`分块回写失败（${m.chunkId}）：${r?.error || 'failed'}`);
    }
    if (unmapped) warnings.push(`有 ${unmapped} 个分块未映射到人工版本校验区（skipped），请只读核对。`);
    return { patched, unmapped, warnings };
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
    const guardWarnings = await publicationGuard(b, { versionId: version.versionId });
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
      target: config.publishKbId, items: itemMeta, warnings: [...guardWarnings, ...manifest.warnings],
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
      await draft(b);
      const guardWarnings = await publicationGuard(b, { versionId: p.versionId });
      const i = await requireIdentity(), v = await core.exportVersion({ ...b, versionId: p.versionId }); assertAuthor(v, i);
      if (i.authorId !== p.authorId) fail('IDENTITY_CHANGED');
      const connector = getConnector(); if (!connector?.createReviewHost) fail('CONNECTOR_UNAVAILABLE');
      const port = connector.createReviewHost();
      let manifest; try { manifest = preparePublicationManifest(v, { kbId: p.kbId ?? config.publishKbId }); } catch (e) { fail(e.code || 'PUBLISH_REJECTED'); }
      if (manifest.digest !== p.digest) fail('PUBLISH_REJECTED');
      // Durable pessimistic intent BEFORE any remote effect; a crash requires reconcile, not blind retry.
      await core.recordPublication({ ...b, planId: p.planId, status: 'failed', details: { phase: 'executing', versionId: p.versionId, digest: p.digest } });
      const bindings = [], itemResults = [];
      const reportWarnings = [...guardWarnings]; let publishedReportKnowledgeId = null; let reportItemReuse = false;
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
            const kbId = p.kbId ?? config.publishKbId;
            // The published report content carries resolved asset handles, so the LLM baseline / previous version
            // must be resolved into the same space before any comparison (otherwise an `asset:` reference alone
            // looks like a change and triggers pointless chunk rewrites).
            const resourceMap = new Map();
            for (const b of bindings) if (b?.assetId && b?.resourceUri) resourceMap.set(b.assetId, b.resourceUri);
            const resolveText = md => (md || '').replace(/(!\[[^\]\r\n]*\]\()asset:([A-Za-z0-9_-]{1,160})(\))/g, (_m, start, id, end) => resourceMap.has(id) ? start + resourceMap.get(id) + end : _m);
            // Single knowledge + revision history: reuse this report's published knowledge when it exists, so
            // weKnora keeps one evolving report (source_content=LLM baseline, content=human, chunk_revisions=edits).
            const priorKnowledgeId = await findPublishedReportKnowledge({ ...b, reportId: p.reportId });
            if (priorKnowledgeId && remoteIdValid(priorKnowledgeId)) {
              const baseV = v.baseVersionId ? await core.getVersion({ ...b, versionId: v.baseVersionId }) : null;
              // The knowledge holds the previous version's full published markdown (body + attribution footer),
              // so compare against that, not the body-only markdown.
              const baseMarkdown = (baseV?.markdown && typeof baseV.markdown === 'string') ? resolveText(publishedReportMarkdown(baseV) || baseV.markdown) : null;
              if (!baseMarkdown) fail('PUBLISH_REJECTED'); // cannot reconcile without the previous published version
              const rw = await rewriteReportChunks(connector, port, kbId, priorKnowledgeId, baseMarkdown, markdown);
              reportWarnings.push(...(rw.warnings || []));
              remote = { id: priorKnowledgeId, parse_status: undefined };
              resultView.phase = 'submitted';
              reportItemReuse = true;
            } else {
              // First publish of this report: seed with the LLM baseline, then rewrite changed chunks to the human version.
              const baseline = await llmBaselineVersion(b, p.versionId);
              // Seeding the root version publishes exactly the current report (no rewrite); for a human-revised
              // version the seed is the LLM baseline's full published markdown (body + footer) so the diff that
              // rewrites chunks reflects real edits rather than the footer that every published version carries.
              const seedMarkdown = (baseline?.versionId === v.versionId)
                ? markdown
                : ((baseline?.markdown && typeof baseline.markdown === 'string') ? resolveText(publishedReportMarkdown(baseline) || baseline.markdown) : markdown);
              const cap = port.approve({ operation: 'publishReport', kbId, title: item.title, content: seedMarkdown });
              if (cap?.ok === false) fail('PUBLISH_REJECTED');
              const r = await port.execute(cap);
              if (r?.ok === true && remoteIdValid(r.data?.id)) {
                remote = pick(r.data, ['id', 'parse_status']);
                resultView.phase = 'submitted';
                if (seedMarkdown !== markdown) {
                  const rw = await rewriteReportChunks(connector, port, kbId, r.data.id, seedMarkdown, markdown);
                  reportWarnings.push(...(rw.warnings || []));
                }
                reportItemReuse = false;
              } else if (r?.outcome_unknown) { remote = pick(r.data, ['id', 'parse_status']); resultView.phase = 'unknown'; }
              else { remote = pick(r.data, ['id', 'parse_status']); resultView.phase = 'failed'; }
            }
            publishedReportKnowledgeId = reportItemReuse ? priorKnowledgeId : (remote.id || null);
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
        // Record the remote id whenever the upload returned one (even on outcome_unknown), so the artifact is
        // still placed into the report folder instead of being left behind at the root.
        if (remoteIdValid(remote.id || remote.remoteId)) resultView.remoteId = (remote.id || remote.remoteId);
        if (remote.file_path) resultView.resourceUri = remote.file_path;
        if (remote.parse_status) resultView.parseStatus = remote.parse_status;
        await core.recordPublication({ ...b, planId: p.planId, itemKey: item.key, status: 'failed', details: { phase: resultView.phase, versionId: p.versionId, digest: p.digest, itemKey: item.key, type: item.type, remote, ...(resultView.phase === 'submitted' ? { remoteId: remote.id } : {}), ...(remote.file_path ? { resourceUri: remote.file_path } : {}) } });
        itemResults.push(resultView);
      }
      // Archive this report's artifacts into ONE per-report WeKnora folder (`…/周报/{reportId}`), with role
      // sub-folders so the report body, its assets and the human-review entries are isolated and retrievable
      // without piling everything into a flat folder. Delegated to the standalone folder-move module: it is
      // fail-soft (a move failure surfaces as a warning, never rolls back uploads or breaks the publish).
      const folder = resolveFolderPath({ variety: v.variety, title: v.title, groupMap: commodityGroups(), folderRoot: config.folderRoot, reportType: '周报', reportKey: v.reportId });
      const warnings = [];
      // Place EVERY artifact that reached WeKnora (i.e. has a valid remote id) into the report folder — even one
      // whose publish phase was `unknown`, so nothing the plugin produced is left straggling at the root.
      const built = itemResults.filter(r => ['report', 'image', 'pdf', 'human'].includes(r.type) && remoteIdValid(r.remoteId));
      const byType = type => built.filter(r => r.type === type).map(r => r.remoteId);
      const kbId = p.kbId ?? config.publishKbId;
      // Placement receipt: shows the human exactly which artifact went into which folder and which could NOT be
      // placed, so a stray file left in the root (or a moved-count mismatch) is visible rather than silent.
      const targetFor = type => type === 'report' ? folder.folderPath : type === 'human' ? `${folder.folderPath}/${SUBDIR.human}` : `${folder.folderPath}/${SUBDIR.asset}`;
      const placement = {
        folderPath: folder.folderPath,
        reportFolder: folder.folderPath,
        assetFolder: folder.folderPath ? `${folder.folderPath}/${SUBDIR.asset}` : null,
        humanFolder: folder.folderPath ? `${folder.folderPath}/${SUBDIR.human}` : null,
        moves: [],
        items: built.map(r => ({ itemKey: r.itemKey, type: r.type, remoteId: r.remoteId, target: folder.folderPath ? targetFor(r.type) : null })),
        unplaced: itemResults.filter(r => ['report', 'image', 'pdf', 'human'].includes(r.type) && !remoteIdValid(r.remoteId) && r.phase !== 'intent').map(r => ({ itemKey: r.itemKey, type: r.type, phase: r.phase })),
      };
      if (folder.invalidGroup) {
        warnings.push(`商品分组映射值不合法（${folder.variety} → ${commodityGroups()[folder.variety]}），已跳过放置；产物保留在知识库根目录。请检查 report-review 的 commodityGroups 配置。`);
      } else if (built.length > 0) {
        const jobs = [];
        const recordMove = (ids, folderPath) => moveArtifacts({ connector, kbId, ids, folderPath }).then(mv => {
          placement.moves.push({ folderPath, expected: mv.expected, movedCount: mv.movedCount, ok: mv.ok });
          warnings.push(...mv.warnings);
          return mv;
        });
        const reportIds = byType('report');
        if (reportIds.length) jobs.push(recordMove(reportIds, folder.folderPath));
        const assetIds = [...byType('image'), ...byType('pdf')];
        if (assetIds.length) jobs.push(recordMove(assetIds, `${folder.folderPath}/${SUBDIR.asset}`));
        const humanIds = byType('human');
        if (humanIds.length) jobs.push(recordMove(humanIds, `${folder.folderPath}/${SUBDIR.human}`));
        await Promise.all(jobs);
        // ---- Placement verification (post-move) + straggler re-move ----
        // moveToFolder reports moved_count, but the real WeKnora folder state can still diverge (e.g. a retry
        // re-uploaded an asset at the root, or a move was reported but not applied). So after the initial move we
        // list each target folder AND the ROOT, re-move any expected remoteId still sitting in the root, and only
        // then warn about survivors. This is idempotent: it runs every publish and converges toward "everything in
        // the report folder" instead of reporting a blindly-trusted moved_count.
        if (folder.folderPath && built.length && typeof connector.listKnowledge === 'function') {
          const expectByFolder = new Map();
          for (const r of built) {
            const target = targetFor(r.type);
            if (!target) continue;
            if (!expectByFolder.has(target)) expectByFolder.set(target, []);
            expectByFolder.get(target).push(r.remoteId);
          }
          const listIds = async (fp) => { try { const vr = await connector.listKnowledge(config.publishKbId, { folderPath: fp, recursive: true, page: 1, pageSize: 200 }); return new Set((vr?.ok === true && Array.isArray(vr.data?.data)) ? vr.data.data.map(x => x.id) : []); } catch { return new Set(); } };
          // Scan the root once: what is still at root after the initial move.
          let rootIds = await listIds('');
          for (const [fp, ids] of expectByFolder) {
            const fids = await listIds(fp);
            const missing = ids.filter(id => !fids.has(id));
            const inRoot = missing.filter(id => rootIds.has(id));
            if (!inRoot.length) continue;
            // Re-move every root straggler in one call per folder; the low-risk re-run is bounded to this folder.
            const mv = await moveArtifacts({ connector, kbId, ids: inRoot, folderPath: fp });
            warnings.push(...mv.warnings);
          }
          // Final verification: any expected id still not in its target folder, and whether it remains at root.
          rootIds = await listIds('');
          for (const [fp, ids] of expectByFolder) {
            const present = await listIds(fp);
            const missing = ids.filter(id => !present.has(id));
            if (!missing.length) continue;
            const atRoot = missing.filter(id => rootIds.has(id));
            warnings.push(`「${fp}」放置核对：${ids.length} 个期望条目中有 ${missing.length} 个未出现在该文件夹${atRoot.length ? `（其中 ${atRoot.length} 个仍停留在根目录）` : ''}。请只读核对后人工处理：${missing.join(', ')}`);
          }
        }
        if (folder.ungrouped) warnings.push(`商品「${folder.variety || '(未识别)'}」未在 commodityGroups 配置分组映射，本期产物暂入「${folder.folderPath}」。请在配置中补充该商品分组。`);
      } else if (folder.ungrouped) {
        warnings.push(`商品「${folder.variety || '(未识别)'}」未在 commodityGroups 配置分组映射，且本期无可移动产物。请在配置中补充该商品分组。`);
      }
      // If any submitted artifact was not confirmed moved (moved_count < expected), surface exactly which folder.
      for (const m of placement.moves) if (m.ok && m.movedCount !== m.expected) warnings.push(`「${m.folderPath}」移动数量不一致：期望 ${m.expected}，已移动 ${m.movedCount}；请只读核对后人工处理。`);
      if (placement.unplaced.length) warnings.push(`有 ${placement.unplaced.length} 个条目未进入确认放置（${placement.unplaced.map(u => u.type).join('/')}，阶段 ${[...new Set(placement.unplaced.map(u => u.phase))].join('/')}），详见发布清单。`);
      warnings.push(...reportWarnings);
      // ---- Human-review signal (format-excluded) ----
      // When a human-revised version is published, compute what the human changed vs the LLM baseline (ignoring
      // pure Markdown formatting) and store it on the published report so TokensCowork can learn/distill the
      // reviewer's intent. The baseline is the LLM version at the root of the chain, so this is the CUMULATIVE
      // human edit on the LLM basis (not just the latest revision). weKnora already recorded the per-chunk
      // edit trail via updateChunk (source_content=LLM, content=human, chunk_revisions=user); this structured,
      // format-excluded mark is the machine-readable review record.
      const reportItem = itemResults.find(r => r.type === 'report' && r.phase === 'submitted' && remoteIdValid(r.remoteId));
      const reportKnowledgeId = reportItem?.remoteId || publishedReportKnowledgeId;
      if (reportItem && reportKnowledgeId && v.baseVersionId && v.baseVersionId !== v.versionId && connector?.createReviewHost) {
        try {
          const baseline = await llmBaselineVersion(b, v.versionId);
          const baseMarkdown = baseline?.markdown;
          if (baseMarkdown && typeof baseMarkdown === 'string') {
            const review = extractReviewMarks(baseMarkdown, v.markdown);
            const payload = {
              llmBaselineVersionId: baseline.versionId, currentVersionId: v.versionId, previousVersionId: v.baseVersionId,
              formatOnly: review.formatOnly, substantive: review.substantive,
              edits: (review.edits || []).slice(0, 200).map(e => ({ op: e.op, text: (e.text || '').slice(0, 4000) })),
              authoredAt: new Date().toISOString(),
            };
            const port2 = connector.createReviewHost();
            const cap = port2.approve({ operation: 'setKnowledgeMetadata', kbId: p.kbId ?? config.publishKbId, knowledgeId: reportKnowledgeId, customMetadata: { review_marks: JSON.stringify(payload), run19_last_published_version: v.versionId } });
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
      return { status: phase, published: false, indexingVerified: false, outcomeUnknown: phase === 'unknown', planId: p.planId, versionId: p.versionId, automaticRetry: false, items: itemResults, warnings, placement,
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
      case 'timeline': if (!human) fail('HUMAN_CLICK_REQUIRED'); return timeline(b);
      case 'audit': if (!human) fail('HUMAN_CLICK_REQUIRED'); return audit(b);
      case 'publishPlan': if (!human) fail('HUMAN_CLICK_REQUIRED'); await draft(b); return publishPlan(b, input);
      case 'publish': if (!human) fail('HUMAN_CLICK_REQUIRED'); return publish(b, input);
      case 'publicationStatus': if (!human) fail('HUMAN_CLICK_REQUIRED'); return publicationStatus(b, input);
      case 'reconcile': if (!human) fail('HUMAN_CLICK_REQUIRED'); return publicationStatus(b, input, true);
      case 'generate': return generate(b, input);
      case 'templateList': if (!core.listPromptTemplates) fail('TEMPLATE_UNAVAILABLE'); return { templates: await core.listPromptTemplates({ sessionId: b.sessionId }) };
      case 'templateSave': if (!core.savePromptTemplate) fail('TEMPLATE_UNAVAILABLE'); return { template: await core.savePromptTemplate({ sessionId: b.sessionId, id: input.id, name: input.name, content: input.content }) };
      case 'templateDelete': if (!core.deletePromptTemplate) fail('TEMPLATE_UNAVAILABLE'); return { deleted: await core.deletePromptTemplate({ sessionId: b.sessionId, id: input.id }) };
      case 'retrievalRecordCorrection': if (!human) fail('HUMAN_CLICK_REQUIRED'); return recordRetrievalCorrection({ sessionId: b.sessionId, variety: input.variety, utterance: input.utterance, scope: input.scope, correction: input.correction });
      case 'retrievalMemory': return { entries: lookupRetrievalMemory(b.sessionId, input.variety) };
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
    dispose() { disposed = true; plans.clear(); previews.clear(); retrievalMemory.clear(); }
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
