import React, { useEffect, useRef, useState, useMemo, useSyncExternalStore } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { MergeView } from '@codemirror/merge';
import workspaceCss from './workspace.css';
import { MarkdownPreview, TemplateSelect, usePreviewScroll } from './preview.jsx';
import { createDemoApi } from './demo-api.mjs';

export function safePdfUrl(value, origin = window.location.origin) {
  if (!value) return null;
  try { const u = new URL(value, origin); return u.origin === origin && ['http:', 'https:'].includes(u.protocol) ? u.href : null; } catch { return null; }
}
export function matchesPreviewReceipt(result, draft, dirty) {
  return !dirty && !!draft?.saveToken && result?.saveToken === draft.saveToken;
}
export function acceptsPreview(result, draft, dirty) {
  return matchesPreviewReceipt(result, draft, dirty) && result?.status === 'ready' && !!result?.digest;
}
export function isDraftReadOnly(draft, busy) { return !!busy || draft?.status !== 'draft'; }
export function previewAssetKey(preview) {
  return preview?.status === 'ready' && preview.pdfUrl && preview.digest && preview.saveToken
    ? JSON.stringify([preview.pdfUrl, preview.digest, preview.saveToken]) : null;
}
export function isPreviewSynced(preview, draft, dirty, pdf) {
  return acceptsPreview(preview, draft, dirty) && !!pdf?.url && pdf.digest === preview.digest && pdf.saveToken === draft.saveToken;
}
const warningLabels = {
  KNOWLEDGE_VERSION_FILTER_NOT_IMPLEMENTED: '知识库检索尚未过滤最新有效版本，请核对历史或撤回信息。',
  LOW_CONFIDENCE_ANNOTATION_MAPPING: '人工修订定位置信度低，请查看差异；预览不代表准确归因。',
  ANNOTATION_AMBIGUOUS_BLOCK: '存在重复或歧义块，无法可靠定位人工修订。',
  LIMITED_MARKDOWN: '当前 PDF 仅支持部分 Markdown 格式，请对照正文阅读。',
  UNCONFIRMED: '人工注释身份或完成时间尚未确认。',
  LLM_SYNTHESIS_CONTEXT_OVERFLOW: '参考材料过多，超出当前模型上下文容量，本次未完成综合推理。请缩短历史参考窗口（如减少“近N周”或改用更具体的日期范围）、精简【分析要求】，或减少联网信源数量后重试。',
  KNOWLEDGE_RANGE_NOT_ENFORCED: '你要求按“时间范围/文件夹”检索，但本次未能按该范围枚举（列出接口不可用或出错），只按语义相关性检索，未保证只取该时间范围/路径下的材料。请只读核对范围后再确认生成结果。',
  KNOWLEDGE_FOLDER_EMPTY: '你指定要参考某个文件夹，但该文件夹在当前知识库中未枚举到可读条目（可能路径未命中、或条目仍在处理中）。请核对文件夹名/路径后重试，或改回“参考整个知识库相关材料”。',
  RETRIEVAL_VERIFY_FAILED: '材料核验器本次未能判定（模型或解析异常），已按“全部采用”处理；请对照上方“检索理解”人工判断是否贴合。',
  RETRIEVAL_OFF_TOPIC: '核验器认为本次检回的材料与你表达的本意可能不一致（跑题）；已据其尝试补查/剔除，请在“检索理解”中核对。',
  RETRIEVAL_GAPS: '核验器认为本次材料存在缺口（见“检索理解”）。已尝试补充检索，仍缺的部分请在报告中标注或补充后重试。'
};
export function safeWarnings(...groups) {
  const codes = new Set();
  for (const group of groups) for (const value of Array.isArray(group) ? group : []) {
    // Never echo arbitrary warning details: they may contain private paths, prompts or URLs.
    codes.add(typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : 'WARNING_DETAILS_REDACTED');
  }
  return [...codes].map(code => ({ code, message: warningLabels[code] || 'Host 返回注意事项；详细内容已隐藏，请在本地核查。' }));
}
export function hostFetch(path, init) {
  const base = globalThis.location?.origin && globalThis.location.origin !== 'null' ? globalThis.location.origin : 'http://dsh.internal';
  const url = safePdfUrl(path, base);
  if (!url) throw new Error('拒绝非 Host 同源资源');
  const send = globalThis.__DSH_TRANSPORT__?.fetch || globalThis.fetch;
  return send(url, init);
}
export async function api(sessionId, action, data = {}, signal) {
  const response = await hostFetch('/api/run19/review', { method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, action, sessionId }) });
  if (response.status === 404) { const e = new Error('RUN-19 Host 接口尚未载入。请完全退出并重新启动 TokensCowork 后再打开周报审阅；若重启后仍失败，请检查插件安装及 Host 装载日志。'); e.code = 'HOST_NOT_LOADED'; throw e; }
  let body;
  try { body = await response.json(); } catch { const e = new Error('RUN-19 接口未返回有效 JSON，可能尚未载入。请完全退出并重启 TokensCowork；若仍失败，请检查 Host 装载及接口日志。'); e.code = 'HOST_RESPONSE_INVALID'; throw e; }
  if (!response.ok || !body.ok) { const e = new Error(body.error?.message || `HTTP ${response.status}`); e.code = body.error?.code || 'HTTP_ERROR'; throw e; }
  return body.value;
}
// This path cannot initiate publication: no token, version override or retry fallback.
export function readPublication(sessionId, reportId, action) {
  if (!['publicationStatus', 'reconcile'].includes(action)) throw new Error('仅允许读取发布记录或只读核对');
  return api(sessionId, action, { reportId });
}
export function publicationStateText(record = {}) {
  if (record.outcomeUnknown === true || record.phase === 'unknown') return '上传结果未知；请只读核对，不要自动重传。检索未核验，未标记发布完成。';
  if (record.parseReady === true) return '解析就绪；检索未核验，未标记发布完成。';
  if (record.phase === 'submitted' || record.status === 'submitted') return '已提交上传；不代表解析或检索完成，请点击只读核对。';
  if (record.phase === 'executing') return '已有执行记录；结果尚未核对，不要重复上传。检索未核验。';
  if (record.phase === 'failed' || record.status === 'failed') return '本次未确认成功；只读核对不会重新上传。检索未核验。';
  return '当前记录尚未证明发布完成；解析状态与检索核验应分别检查。';
}
const recordText = value => typeof value === 'string' && value.length <= 160 && /^[\w. :+-]+$/.test(value) ? value : '未提供';
export function PublicationRecords({ value, busy, onRead }) {
  const records = Array.isArray(value?.records) ? value.records : [];
  const notices = safeWarnings(value?.warnings);
  return <><h3>发布记录 / 只读核对结果</h3><p>核对只读取远端状态并更新本地核对记录，不上传、不重解析、不删除，也不会重试发布。解析就绪不等于检索已核验。</p>
    <button className="rr-button" disabled={busy} onClick={() => onRead('publicationStatus')}>刷新发布记录</button>{' '}
    <button className="rr-button" disabled={busy} onClick={() => onRead('reconcile')}>只读核对</button>
    {notices.length > 0 && <ul>{notices.map(w => <li key={w.code}>{w.code}：{w.message}</li>)}</ul>}
    {!records.length && <p>暂无发布记录；不会自动创建发布任务。</p>}
    {records.map((r,index) => <article key={`${recordText(r.planId)}-${index}`} className="rr-record">
      <strong>{recordText(r.versionId)} · 计划 {recordText(r.planId)}</strong><p>{publicationStateText(r)}</p>
      <dl><dt>上传阶段</dt><dd>{recordText(r.phase || r.status)}</dd><dt>远端资料 ID</dt><dd>{recordText(r.remoteId)}</dd><dt>解析状态</dt><dd>{recordText(r.parseStatus)}{r.parseReady === true ? '（解析就绪）' : ''}</dd><dt>检索核验</dt><dd>未核验；不标记发布完成</dd><dt>最近只读核对时间</dt><dd>{recordText(r.checkedAt)}</dd></dl>
    </article>)}
  </>;
}
const asDraft = v => v?.draft || v?.workingDraft || v;
const rows = (v, key) => Array.isArray(v) ? v : v?.[key] || [];
const markdownHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.heading, color: 'var(--rr-accent)', fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700', color: 'var(--rr-accent)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--rr-muted)' },
  { tag: [tags.link, tags.url], color: 'var(--rr-info)', textDecoration: 'underline', textUnderlineOffset: '3px' },
  { tag: tags.monospace, color: 'var(--rr-syntax-code)' },
  { tag: tags.quote, color: 'var(--rr-success)' },
  { tag: [tags.processingInstruction, tags.meta], color: 'var(--rr-muted)' },
  { tag: [tags.list, tags.contentSeparator], color: 'var(--rr-info)' },
  { tag: [tags.keyword, tags.operator], color: 'var(--rr-accent)' },
  { tag: [tags.string, tags.number, tags.bool], color: 'var(--rr-syntax-code)' },
  { tag: tags.comment, color: 'var(--rr-muted)', fontStyle: 'italic' }
]));
// CodeMirror inherits the same semantic palette as the workspace, including live theme changes.
const editorTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--rr-text)', backgroundColor: 'var(--rr-paper)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--rr-mono)', lineHeight: '1.85' },
  '.cm-content': { caretColor: 'var(--rr-text)', padding: '24px 0' },
  '.cm-line': { padding: '0 24px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--rr-text)' },
  '.cm-gutters': { backgroundColor: 'var(--rr-paper)', color: 'var(--rr-muted)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--rr-raised)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--rr-selection)' }
});
function Editor({ value, onChange, readOnly = false, editorRef }) {
  const root = useRef(null), view = useRef(null), change = useRef(onChange);
  const access = useRef(new Compartment());
  change.current = onChange;
  useEffect(() => {
    view.current = new EditorView({ parent: root.current, state: EditorState.create({ doc: value || '', extensions: [lineNumbers(), history(), markdown(), markdownHighlight, keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping, editorTheme, access.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]), EditorView.updateListener.of(u => { if (u.docChanged && !u.transactions.some(t => t.isUserEvent('remote'))) change.current?.(u.state.doc.toString()); })] }) });
    if (editorRef) editorRef.current = view.current;
    return () => { if (editorRef) editorRef.current = null; view.current.destroy(); view.current = null; };
  }, []);
  useEffect(() => { view.current?.dispatch({ effects: access.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) }); }, [readOnly]);
  useEffect(() => { const v = view.current; if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value || '' }, userEvent: 'remote' }); }, [value]);
  return <div ref={root} className="rr-editor" />;
}
function Diff({ before, after }) {
  const root = useRef(null);
  useEffect(() => { const merge = new MergeView({ parent: root.current, a: { doc: before, extensions: [markdown(), markdownHighlight, editorTheme, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping] }, b: { doc: after, extensions: [markdown(), markdownHighlight, editorTheme, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping] } }); return () => merge.destroy(); }, [before, after]);
  return <div ref={root} className="rr-diff" />;
}
export const DEFAULT_PROMPT_TEMPLATE = [
  '结合近四周同品类周报，做一次综合分析。',
  '',
  '## 本周多空逻辑',
  '结合数据与材料，给出价格/库存/结构/供需的核心判断，多空两面都要。',
  '',
  '## 与近四周周报的连贯性分析',
  '- **连续性**：贯穿近四周的主线（价格节奏/库存/结构/供应），列要点；',
  '- **冲突性**：多空或数据背离处，逐条说明；',
  '- **综合研判**：趋势 / 运行区间 / 跟踪要点。',
  '',
  '## 风险提示',
  '写 2–4 条短句（政策、资金、产业行为），形如"- …"。',
].join('\n');

export function generationInput({ variety, end, analysisPrompt, webSearchEnabled }) {
  const v = String(variety || '').trim(), date = String(end || '').trim();
  if (!v) throw new Error('请输入商品名称');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new Error('请选择有效截止日期');
  return { variety:v, end:date, analysisPrompt:String(analysisPrompt || '').trim(), webSearchEnabled:webSearchEnabled === true };
}
export function humanItemPayload(items) { return (items || []).map(i=>({annotationId:i.annotationId,category:i.category || 'supplement',selected:i.selected === true,visibility:i.visibility === 'public'?'public':'local',...(typeof i.publicSource==='string'?{publicSource:i.publicSource}:{})})); }
export function HumanItemsPanel({value,readOnly,onSave}) {
  const [items,setItems]=useState(()=>humanItemPayload(value.items).map((i,n)=>({...value.items[n],...i})));
  const update=(n,patch)=>setItems(previous=>previous.map((i,k)=>k===n?{...i,...patch}:i));
  return <section aria-label="重点人工信息"><h3>重点人工信息</h3><p>仅本地审核确认和发布准备，尚未上传独立资料。默认不全选；措辞/排版类不独立入库。本地敏感备注本版不编辑、不发送。删除原文的撤回条目尚不支持，不能将当前段落分类为撤回冒充删除追溯。</p><ul>{safeWarnings(value.warnings).map(w=><li key={w.code}>{w.code}：{w.message}</li>)}</ul>{readOnly && <p>已确认稿只读，请先开启新一轮修订。</p>}
    {items.length===0 && <p>暂无可确认的人类修订块。</p>}{items.map((item,n)=><fieldset key={item.annotationId} disabled={readOnly} className="rr-fieldset"><legend>{item.annotationId}</legend><pre className="rr-pre">{item.content || '当前内容无法可靠定位'}</pre>{item.mappingConfidence==='low' && <p>低置信度：请核对来源，不自动认定为有效情报。</p>}
      <label><input type="checkbox" checked={item.selected===true} onChange={e=>update(n,{selected:e.target.checked})}/>重点条目</label>{' '}
      <label>类别 <select value={item.category} onChange={e=>update(n,{category:e.target.value})}>{[['supplement','补充'],['correction','纠错'],['retraction','撤回'],['judgment','个人判断'],['style','措辞/排版']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>{' '}
      <label>公开范围 <select value={item.visibility} onChange={e=>update(n,{visibility:e.target.value})}><option value="local">仅本地</option><option value="public">可公开</option></select></label>{' '}
      <label>可公开来源 <input maxLength={4000} value={item.publicSource || ''} onChange={e=>update(n,{publicSource:e.target.value})}/></label>
    </fieldset>)}<button className="rr-button" disabled={readOnly} onClick={()=>onSave(humanItemPayload(items),value.saveToken)}>保存人工信息选择（仅本地）</button></section>;
}
function DiffOps({ diff }) {
  if (!diff) return <p className="rr-muted">基线版本，无上一版可比。</p>;
  const ops = Array.isArray(diff.ops) ? diff.ops : [];
  if (!diff.changed) return <p className="rr-muted">相对上一版：无内容变化。</p>;
  return <div className="rr-diff-summary">
    <p className="rr-muted">相对上一版：+{diff.add} 行 · −{diff.del} 行（高亮为本次修改）</p>
    <pre className="rr-diff-body">
      {ops.map((o, i) => (o.op === 'same') ? null
        : <div key={i}><span className={(o.op === 'del' || o.op === 'delblock') ? 'rr-diff-delete' : 'rr-diff-insert'}>{(o.op === 'del' || o.op === 'delblock') ? `- ${o.before ?? ''}` : `+ ${o.after ?? ''}`}</span></div>)}
    </pre>
  </div>;
}
function Timeline({ value }) {
  const versions = Array.isArray(value?.versions) ? value.versions : [];
  const markdowns = value?.markdowns || {};
  return <><h3>版本历史（report-core 切片 · 自动相邻差异）</h3>
    <p className="rr-muted">每份报告在灌入 WeKnora 前，先在本地按版本切片展示 V0(LLM 基线)→V1→V2… 及其差异；正文只读，不影响工作稿。</p>
    {!versions.length && <p>暂无版本。</p>}
    {versions.map(v => <article key={v.versionId} className="rr-record">
      <div className="rr-row">
        <strong>{v.versionId}</strong>
        {v.isBaseline && <span className="rr-muted">(LLM 基线)</span>}
        {v.humanEdited && <span className="rr-info">✎ 人工修订</span>}
        {v.published ? <span className="rr-success">● 已提交上传（解析与检索未核验）</span> : <span className="rr-muted">○ 未确认上传</span>}
        <span className="rr-muted">{v.author?.displayName || ''}{v.completedAt ? ` · ${String(v.completedAt).slice(0, 10)}` : ''}</span>
      </div>
      {v.diffFromPrevious && <DiffOps diff={v.diffFromPrevious} />}
      {typeof markdowns[v.versionId] === 'string' && <details><summary>阅读 {v.versionId} 正文</summary><pre className="rr-pre">{markdowns[v.versionId]}</pre></details>}
    </article>)}
  </>;
}
export function Workspace({ sessionId, close, initialMode = 'real' }) {
  const [mode, setMode] = useState(initialMode);
  return <WorkspaceContent key={mode} sessionId={sessionId} close={close} mode={mode} onModeChange={setMode} />;
}
function WorkspaceContent({ sessionId, close, mode, onModeChange }) {
  const demo = mode === 'demo';
  const demoApi = useMemo(() => demo ? createDemoApi(globalThis.localStorage) : null, [demo]);
  const [stage, setStage] = useState('generation'), [blankTitle, setBlankTitle] = useState('');
  const dialogRef = useRef(null);
  const [search, setSearch] = useState(''), [viewMode, setViewMode] = useState('editor'), [focused, setFocused] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current, previous = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const [reports, setReports] = useState([]), [draft, setDraft] = useState(null), [text, setText] = useState('');
  const [dirty, setDirty] = useState(false), [status, setStatus] = useState('正在加载'), [error, setError] = useState('');
  const [reportWarnings, setReportWarnings] = useState([]);
  const [preview, setPreview] = useState(null), [pdf, setPdf] = useState(null), [identity, setIdentity] = useState(null), [panel, setPanel] = useState(null), [busy, setBusy] = useState(false);
  const [variety,setVariety] = useState('锡'), [end,setEnd] = useState(() => {const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}), [analysisPrompt,setAnalysisPrompt] = useState(DEFAULT_PROMPT_TEMPLATE), [webSearchEnabled,setWebSearchEnabled] = useState(false);
  const [templates,setTemplates] = useState([]), [tmplId,setTmplId] = useState(''), [tmplName,setTmplName] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const current = useRef({}), alive = useRef(true), saving = useRef(false), revision = useRef(0), previewSerial = useRef(0);
  async function generate(event) {
    event.preventDefault();
    if (current.current.dirty || saving.current || current.current.busy) return;
    let input; try { input = generationInput({variety,end,analysisPrompt,webSearchEnabled}); } catch(e) { fail(e); return; }
    current.current.busy = true; setBusy(true); setError(''); setStatus(demo ? '正在生成演示周报…' : '正在生成周报（5100 数据 · ' + (analysisPrompt.trim() ? '按分析要求由 LLM 分析' : '纯 7 天数据') + (webSearchEnabled ? ' · 联网检索' : '') + '），请稍候');
    try { const result = await request('generate',input); if (!alive.current) return;
      const d = asDraft(result); adopt(result); setReports(v => [...v.filter(r => r.reportId !== d.reportId), d]); setPreview(null); setPanel(null); setStage('editor'); setViewMode('editor'); setStatus(demo ? '演示初稿已生成并保存在此浏览器' : '初稿已生成并保存，请人工审阅；尚未完成或发布');
    } catch(e) { fail(e); } finally { if (alive.current) { current.current.busy = false; setBusy(false); } }
  }
  async function saveTemplate() {
    if (busy) return;
    if (!analysisPrompt.trim()) { setError('模板内容为空，未保存'); return; }
    const name = tmplName.trim() || '未命名模板';
    try { const r = await request('templateSave', { id: tmplId || undefined, name, content: analysisPrompt }); if (!alive.current) return;
      setTemplates(v => { const i = v.findIndex(t => t.id === r?.template?.id); return i >= 0 ? v.map((t,j) => j === i ? r.template : t) : [...v, r?.template]; });
      if (r?.template?.id) { setTmplId(r.template.id); setTmplName(r.template.name); } setStatus('模板已保存'); setError('');
    } catch(e) { fail(e); }
  }
  function loadTemplate(id) {
    if (id === '') { setTmplId(''); setAnalysisPrompt(DEFAULT_PROMPT_TEMPLATE); setTmplName(''); return; }
    const t = templates.find(x => x.id === id); if (t) { setTmplId(t.id); setAnalysisPrompt(t.content); setTmplName(t.name || ''); }
  }
  current.current = { draft, text, dirty, busy };
  const request = (action, data = {}) => {
    if (demo) return demoApi(action, data);
    if (!sessionId) return Promise.reject(Object.assign(new Error('请先在客户端选择一个会话，或切换本地演示。'), { code: 'SESSION_REQUIRED' }));
    return api(sessionId, action, data);
  };
  const publicationRead = (reportId, name) => demo ? demoApi(name, { reportId }) : readPublication(sessionId, reportId, name);
  async function createBlank() {
    if (!blankTitle.trim() || current.current.dirty || saving.current || current.current.busy) return;
    setBusy(true); setError('');
    try { const d = asDraft(await request('create', { title: blankTitle.trim(), markdown: '# ' + blankTitle.trim() + '\n', assets: [] })); if (!alive.current) return; adopt(d); setReports(v => [...v, d]); setPanel(null); setStage('editor'); setViewMode('editor'); }
    catch(e) { fail(e); } finally { if (alive.current) setBusy(false); }
  }
  const fail = e => { if (alive.current) { setError(`${e.code || 'ERROR'}: ${e.message}`); setStatus(e.code?.toLowerCase().includes('conflict') ? '冲突：本地草稿已保留，请对照远端后处理' : '操作失败，本地草稿保留'); } };
  function adopt(value) { const d = asDraft(value); if (!d?.reportId || typeof d.markdown !== 'string') throw new Error('Host 未返回有效工作稿'); const sameReport = current.current.draft?.reportId === d.reportId; setReportWarnings(previous => { const received = safeWarnings(value?.warnings, d.warnings); return sameReport ? safeWarnings(previous.map(w => w.code), received.map(w => w.code)) : received; }); revision.current++; current.current = { ...current.current, draft: d, text: d.markdown, dirty: false }; setDraft(d); setReports(previous => previous.map(r => r.reportId === d.reportId ? { ...r, title: d.title, status: d.status } : r)); setText(d.markdown); setDirty(false); setStatus('已保存'); setError(''); }
  async function load(id) { if (current.current.dirty || saving.current) { setError('请先保存或导出当前脏稿；不会覆盖本地输入。'); return; } setBusy(true); try { const d = await request('get', { reportId: id }); if (alive.current) { adopt(d); setPreview(null); setPanel(null); setStage('editor'); setViewMode('editor'); } } catch(e) { fail(e); } finally { if (alive.current) setBusy(false); } }
  async function save() {
    const c = current.current; if (!c.draft || !c.dirty || saving.current || isDraftReadOnly(c.draft, c.busy)) return;
    saving.current = true; const seq = revision.current; setStatus('保存中');
    try { const saved = asDraft(await request('save', { reportId: c.draft.reportId, saveToken: c.draft.saveToken, markdown: c.text }));
      if (!alive.current || current.current.draft?.reportId !== c.draft.reportId) return;
      if (!saved?.saveToken) throw new Error('保存回执缺少 saveToken');
      const next = { ...c.draft, ...saved, markdown: saved.markdown ?? c.text };
      current.current.draft = next; setDraft(next);
      if (revision.current === seq) { current.current.dirty = false; setDirty(false); setStatus('已保存'); setError(''); } else setStatus('有未保存修改');
    } catch(e) { fail(e); } finally { saving.current = false; }
  }
  useEffect(() => { alive.current = true; request('list').then(v => { if (alive.current) { setReports(rows(v, 'reports')); setStatus(demo ? '本地演示已就绪' : '请选择或生成周报'); } }).catch(fail); request('identity').then(v => alive.current && setIdentity(v)).catch(fail); request('templateList').then(v => alive.current && setTemplates(v?.templates || [])).catch(() => {}); return () => { alive.current = false; previewSerial.current++; }; }, [sessionId]);
  useEffect(() => { if (!dirty || error) return; const timer = setTimeout(save, 650); return () => clearTimeout(timer); }, [text, dirty, draft?.saveToken, busy, error]);
  useEffect(() => {
    const timer = setInterval(async () => { const c = current.current; if (!c.draft || c.dirty || saving.current || c.busy) return;
      const seq = revision.current; try { const d = asDraft(await request('get', { reportId: c.draft.reportId })); if (alive.current && !current.current.dirty && !saving.current && seq === revision.current && d.saveToken !== current.current.draft?.saveToken) adopt(d); } catch(e) { fail(e); }
    }, 5000); return () => clearInterval(timer);
  }, [sessionId]);
  useEffect(() => {
    if (!draft || dirty) return;
    const serial = ++previewSerial.current; let cancelled = false, timer;
    async function render() { try { const result = await request('preview', { reportId: draft.reportId, saveToken: draft.saveToken });
      if (cancelled || serial !== previewSerial.current || !alive.current) return;
      // Keep failure/status receipts visible, but only a ready receipt may certify synchronization.
      if (matchesPreviewReceipt(result, current.current.draft, current.current.dirty)) setPreview(result);
      if (['pending', 'queued', 'rendering', 'running'].includes(result?.status)) timer = setTimeout(render, 1600);
    } catch(e) { if (!cancelled) fail(e); } }
    timer = setTimeout(render, 250); return () => { cancelled = true; clearTimeout(timer); };
  }, [draft?.reportId, draft?.saveToken, dirty]);
  useEffect(() => { const warn = e => { if (current.current.dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, []);
  async function action(name, extra = {}) { if (!draft || dirty || saving.current || busy) return; setBusy(true); setError(''); try { const result = await request(name, { reportId: draft.reportId, saveToken: draft.saveToken, ...extra }); if (!alive.current) return;
    if (name === 'startRevision') { adopt(result); setPanel(null); }
    else if (name === 'confirm') { setStatus('确认版已冻结，尚未发布'); setPanel({ type: 'versions', value: await request('versions', { reportId: draft.reportId }) }); const d = await request('get', { reportId: draft.reportId }); adopt(d); setStatus('确认版已冻结，尚未发布'); }
    else if (name === 'saveHumanItems') { const d=await request('get',{reportId:draft.reportId}); if(!alive.current)return; adopt(d); setPanel({type:'humanItems',value:result}); setStatus('人工信息选择已本地保存，尚未独立入库'); }
    else setPanel({ type: name, value: result });
  } catch(e) { fail(e); } finally { if(alive.current) setBusy(false); } }
  async function showPublication(name = 'publicationStatus') {
    const c = current.current;
    if (!c.draft || c.busy || saving.current) return;
    current.current.busy = true; setBusy(true); setError('');
    try { const result = await publicationRead(c.draft.reportId, name);
      if (!alive.current || current.current.draft?.reportId !== c.draft.reportId) return;
      setPanel({ type:'publicationStatus', value:result });
      setStatus(name === 'reconcile' ? '只读核对已返回；未触发上传，检索仍未核验' : '已读取发布记录；未触发上传');
    } catch(e) { fail(e); } finally { if (alive.current) { current.current.busy = false; setBusy(false); } }
  }
  async function publishAll(event) {
    if (!event.nativeEvent.isTrusted) { setError('发布必须由人类实际点击'); return; }
    const c = current.current;
    if (!c.draft || c.busy || saving.current || dirty || c.draft.status !== 'draft' || !identity?.confirmed) return;
    current.current.busy = true; setBusy(true); setError(''); setConfirmPublish(false);
    setStatus(demo ? '正在模拟发布（不上传）…' : '正在发布到 WeKnora（runzhouwork）…');
    try {
      const reportId = c.draft.reportId, saveToken = c.draft.saveToken;
      // 1) 冻结当前草稿为不可变确认版
      const confirmed = asDraft(await request('confirm', { reportId, saveToken }));
      if (!alive.current) return;
      // 2) 取最新确认版本
      const versions = rows(await request('versions', { reportId }), 'versions');
      const versionId = versions.at(-1)?.versionId;
      if (!versionId) throw new Error('未找到可发布的确认版本');
      // 3) 生成发布清单（含 publishToken）
      const plan = await request('publishPlan', { reportId, versionId });
      if (!alive.current) return;
      // 4) 真正上传到 WeKnora
      await request('publish', { reportId, saveToken, versionId, planId: plan?.planId, digest: plan?.digest, publishToken: plan?.publishToken, userInitiated: true });
      // 5) 只读核对 + 加载确认版正文
      const reconciled = await publicationRead(reportId, 'reconcile');
      const d = asDraft(await request('get', { reportId })); if (alive.current) adopt(d);
      setPanel({ type: 'publicationStatus', value: reconciled });
      setStatus(demo ? '模拟发布完成，未上传任何内容。' : '已提交发布到 WeKnora；上传/解析为异步，请用只读核对确认结果，核验前不标记发布完成。');
    } catch(e) { fail(e); } finally { if (alive.current) { current.current.busy = false; setBusy(false); } }
  }
  const assetKey = previewAssetKey(preview);
  useEffect(() => {
    let cancelled = false, ownedUrl;
    setPdf(null);
    if (!assetKey) return;
    const controller = new AbortController();
    (demo ? request('demoPdf', {reportId: draft.reportId, saveToken: preview.saveToken}).then(bytes => new Response(bytes)) : hostFetch(preview.pdfUrl, { credentials:'same-origin', signal:controller.signal })).then(async response => {
      if (!response.ok) throw new Error(`PDF HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (new TextDecoder().decode(bytes.slice(0,5)) !== '%PDF-') throw new Error('预览响应不是实际 PDF');
      if (cancelled) return;
      ownedUrl = URL.createObjectURL(new Blob([bytes], {type:'application/pdf'})); setPdf({url:ownedUrl, digest:preview.digest, saveToken:preview.saveToken});
    }).catch(e => { if (!cancelled) { setPdf(null); fail(e); } });
    return () => { cancelled = true; controller.abort(); if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
  }, [assetKey]);
  const synced = isPreviewSynced(preview, draft, dirty, pdf);
  const readOnly = isDraftReadOnly(draft, busy);
  const editorRef = useRef(null), markdownScrollRef = useRef(null);
  usePreviewScroll(editorRef, markdownScrollRef, viewMode === 'markdown' && stage === 'editor', text, readOnly);
  const warnings = safeWarnings(reportWarnings.map(w => w.code), draft?.warnings, preview?.warnings);
  const verified = identity?.confirmed === true && !!identity?.displayName;
  const versions = panel?.type === 'versions' ? rows(panel.value, 'versions') : [];
  const visibleReports = reports.filter(r => (r.title || r.reportId).toLowerCase().includes(search.trim().toLowerCase()));
  const requestClose = () => { if (busy || saving.current) return; if (dirty) setConfirmClose(true); else close(); };
  return <dialog ref={dialogRef} aria-label="周报审阅工作台" className="rr-workspace" data-focus={focused && stage === 'editor'} data-stage={stage} data-mode={mode} onCancel={event => { event.preventDefault(); requestClose(); }}>
    <style>{workspaceCss}</style>
    <header className="rr-header">
      <strong className="rr-app-title">周报工作台</strong>
      <div className="rr-steps" role="group" aria-label="工作流程"><button className="rr-button" aria-pressed={stage === 'generation'} onClick={() => { setStage('generation'); setFocused(false); }}>1 生成与分析</button><button className="rr-button" disabled={!draft} aria-pressed={stage === 'editor'} onClick={() => setStage('editor')}>2 正文编辑</button></div>
      <button className="rr-button rr-mode-switch" disabled={busy || dirty} onClick={() => { if (!saving.current) onModeChange(demo ? 'real' : 'demo'); }}>{demo ? '切换真实模式' : '体验演示数据'}</button>
      <button className="rr-button" hidden={stage !== 'editor'} aria-pressed={focused} onClick={() => setFocused(v => !v)}>{focused ? '退出专注' : '专注正文'}</button>
      <button className="rr-button" disabled={busy} onClick={requestClose}>关闭</button>
    </header>
    {demo && <div className="rr-demo-banner" role="note">本地演示 · 数据与分析均为模拟样例，保存在此浏览器；不连接数据库，不调用 AI，不上传知识库。</div>}
    <div className="rr-layout">
      <nav className="rr-sidebar" aria-label="周报档案">
        <div className="rr-section-heading"><h2>研究档案</h2><span className="rr-badge">{reports.length}</span></div>
        <button className="rr-button rr-button--primary" disabled={busy || dirty} onClick={() => { setStage('generation'); setFocused(false); }}>＋ 新建周报</button>
        <input aria-label="搜索报告" placeholder="搜索报告…" type="search" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="rr-report-list">{visibleReports.map(r => <button className="rr-report-item" key={r.reportId} aria-current={draft?.reportId === r.reportId ? 'page' : undefined} disabled={busy || dirty} onClick={() => load(r.reportId)}><strong>{r.title || r.reportId}</strong><span>{r.status === 'confirmed' ? '已确认版本' : '研究草稿'}</span></button>)}
          {!visibleReports.length && <p className="rr-empty">{search ? '没有匹配的报告' : '暂无报告，新建一份开始研究。'}</p>}</div>
        <p className="rr-sidebar-note">从本周数据出发，留下判断与依据。<br/>保存后可切换报告。</p>
      </nav>
      <main className="rr-main">

        <section className="rr-generation-stage" aria-label="生成与分析" hidden={stage !== 'generation'}><header><h1>生成周报</h1><p className="rr-muted">先确定品种、截止日期和分析要求。生成后进入正文编辑，已有报告不会被覆盖。</p></header>
    <form onSubmit={generate} className="rr-generation-form" aria-label="生成周报参数">
      <div className="rr-generation-basics"><label>商品 <input aria-label="商品" value={variety} disabled={busy} onChange={e => setVariety(e.target.value)} className="rr-commodity-input" required /></label>
      <label>截止日期 <input aria-label="截止日期" type="date" value={end} disabled={busy} onChange={e => setEnd(e.target.value)} required /></label>
      <label><input type="checkbox" checked={webSearchEnabled} disabled={busy} onChange={e => setWebSearchEnabled(e.target.checked)} />联网检索（新闻/外部信源）</label></div>
      <div className="rr-form-heading"><h2>分析要求</h2><p className="rr-muted">选用模板开始，也可以直接调整章节和研究重点。留空则仅整理 7 天数据。</p></div>
      <div className="rr-template-tools">
        <TemplateSelect value={tmplId} templates={templates} disabled={busy} onChange={loadTemplate} />
        <input aria-label="模板名称" placeholder="模板名称（可留空）" value={tmplName} onChange={e => setTmplName(e.target.value)} disabled={busy} className="rr-template-name" />
        <button type="button" className="rr-button" disabled={busy || !analysisPrompt.trim()} onClick={saveTemplate}>保存为模板</button>
        {tmplId && <button type="button" className="rr-button" disabled={busy} onClick={async () => { try { const r = await request('templateDelete', { id: tmplId }); if (r?.deleted && alive.current) { setTemplates(v => v.filter(t => t.id !== tmplId)); setTmplId(''); setTmplName(''); } } catch(e) { fail(e); } }}>删除模板</button>}
      </div>
      <textarea aria-label="分析要求（可选）" value={analysisPrompt} disabled={busy} onChange={e => setAnalysisPrompt(e.target.value)} rows={12} className="rr-prompt" placeholder="留空则仅按 7 天数据出周报。需要结合历史周报时写清要求，如“请结合近四周同品类周报做连续性梳理”；也可只写“补充多空逻辑”“分析供需结构”等。" />
      <button className="rr-button rr-button--primary" type="submit" disabled={busy || dirty || (!demo && !sessionId)}>{demo ? '生成演示周报' : '生成周报'}</button>
    </form>
        <section className="rr-blank-create"><h2>或从空白正文开始</h2><div className="rr-row"><input aria-label="空白报告标题" placeholder="输入报告标题" value={blankTitle} onChange={e => setBlankTitle(e.target.value)} /><button type="button" className="rr-button" disabled={busy || dirty || !blankTitle.trim() || (!demo && !sessionId)} onClick={createBlank}>创建空白报告</button></div></section>
        </section>
        <section className="rr-editor-stage" hidden={stage !== 'editor'}>
        <header className="rr-report-header"><span className="rr-eyebrow">WEEKLY RESEARCH</span><h1>{draft?.title || '开始本周研究'}</h1><div className="rr-row"><span className="rr-badge">{draft?.status === 'confirmed' ? '已确认 · 只读' : dirty ? '待保存' : draft ? '研究草稿' : '未选择报告'}</span><span className="rr-muted">先看结论，再核对证据</span></div></header>
        <div className="rr-toolbar" role="group" aria-label="文档视图"><button className="rr-button" aria-pressed={viewMode === 'editor'} onClick={() => setViewMode('editor')}>正文编辑</button><button className="rr-button" disabled={!draft} aria-pressed={viewMode === 'markdown'} onClick={() => { setViewMode('markdown'); setFocused(true); }}>Markdown 实时浏览</button><button className="rr-button" disabled={!draft} aria-pressed={viewMode === 'pdf'} onClick={() => { setViewMode('pdf'); setFocused(true); }}>PDF 实时浏览</button><button className="rr-button" disabled={!synced || busy} title={synced ? '导出当前已保存版本' : '等待当前内容保存并完成 PDF 生成后可导出'} onClick={() => { if (!synced) return; const link = document.createElement('a'); link.href = pdf.url; link.download = demo ? 'demo-weekly-report.pdf' : (draft.title || 'weekly-report').replace(/[<>:"/\\|?*]/g, '_') + '.pdf'; link.click(); }}>导出 PDF</button><button className="rr-button rr-button--primary rr-push" disabled={!dirty || readOnly} onClick={() => { setError(''); save(); }}>保存 / 重试</button></div>
        <div className="rr-document-panes" data-view={viewMode}><div className="rr-source-pane"><div className="rr-pane-heading"><strong>Markdown 源码</strong><span>{dirty ? '未保存' : '自动保存'}</span></div><section className="rr-canvas" aria-label="报告正文">{draft ? <Editor key={draft.reportId} editorRef={editorRef} value={text} readOnly={readOnly} onChange={value => { if (isDraftReadOnly(current.current.draft, current.current.busy)) return; revision.current++; current.current.dirty = true; current.current.text = value; setText(value); setDirty(true); setStatus('有未保存修改'); }} /> : <div className="rr-welcome"><span className="rr-eyebrow">本周的判断，从这里开始</span><h2>把数据整理成有依据的观点</h2><p>从左侧打开已有报告，或新建周报后使用上方设置生成初稿。</p><p className="rr-muted">生成初稿 → 人工审阅 → 确认版本 → 发布与核对</p></div>}</section>
        </div><section className="rr-markdown-preview" aria-label="Markdown 实时预览" hidden={viewMode !== 'markdown'}><div className="rr-pane-heading"><strong>阅读预览</strong><span>随输入实时更新</span></div><MarkdownPreview text={text} scrollRef={markdownScrollRef} /></section>
        <section className="rr-pdf" aria-label="报告版式" hidden={viewMode !== 'pdf'}><div className="rr-pane-heading"><strong>PDF 版式</strong><span>{synced ? '已同步' : '等待生成 / 旧预览'}</span></div>{pdf ? <><a href={pdf.url} target="_blank" rel="noreferrer" download={demo ? "demo-weekly-report.pdf" : undefined}>{demo ? "下载演示 PDF（模拟数据）" : "下载 / 打开当前 PDF"}{!synced ? '（旧预览）' : ''}</a><object aria-label="实际 PDF 预览" data={pdf.url} type="application/pdf" className="rr-pdf-object"><a href={pdf.url} target="_blank" rel="noreferrer">浏览器无法内嵌 PDF，请打开实际 PDF</a></object></> : <p className="rr-empty">尚无可用实际 PDF，保存后等待预览生成。</p>}</section></div>
        </section>
      </main>
      <aside className="rr-inspector" aria-label="审阅与交付" hidden={stage !== 'editor'}>
        <div className="rr-section-heading"><h2>审阅与交付</h2><span className="rr-badge">{warnings.length} 项提示</span></div>
        <section className="rr-review-card"><span className="rr-eyebrow">当前版本</span><h3>{draft?.status === 'confirmed' ? '内容已冻结' : '保留你的专业判断'}</h3><p>{draft?.status === 'confirmed' ? '确认稿只读。后续修改请开启新修订。' : '核对数据口径、引用材料与推理，再确认本期版本。'}</p><div className="rr-action-stack">
          <button className="rr-button" disabled={!draft || dirty || busy} onClick={() => action('timeline')}>版本历史与差异</button>
          {(draft?.annotations || []).length > 0 && <button className="rr-button" disabled={dirty || busy} onClick={() => action('humanItems')}>重点人工信息</button>}
          <button className="rr-button rr-button--primary" disabled={!draft || dirty || readOnly || !verified} onClick={() => setConfirmPublish(true)}>{demo ? '模拟确认发布' : '确认发布'}</button>
          <button className="rr-button" disabled={!draft || dirty || readOnly || !verified} onClick={() => action('confirm')}>仅确认版本</button>
          {confirmPublish && <div className="rr-notice"><p>{demo ? '将冻结演示版本并模拟发布，全程不上传。' : '将冻结当前正文并上传到 WeKnora，是否继续？'}</p><button className="rr-button rr-button--primary" disabled={busy || dirty || readOnly || !verified} onClick={publishAll}>{demo ? '确认模拟发布' : '确认发布并上传'}</button> <button className="rr-button" disabled={busy} onClick={() => setConfirmPublish(false)}>取消</button></div>}
          <button className="rr-button" disabled={draft?.status !== 'confirmed' || dirty || busy} onClick={() => action('versions')}>查看确认版 / 准备发布</button>
          <button className="rr-button" disabled={draft?.status !== 'confirmed' || dirty || busy} onClick={() => action('startRevision')}>开启新一轮修订</button>
          <button className="rr-button" disabled={!draft || busy} onClick={() => showPublication()}>发布记录 / 只读核对</button>
        </div><p className="rr-muted">{verified ? '审核署名：' + identity.displayName : '知识库身份未确认，暂不能确认版本。'}</p></section>
    {warnings.length > 0 && <section aria-label="审阅注意事项" role="status"><strong>注意事项</strong><ul>{warnings.map(w => <li key={w.code}><code>{w.code}</code>：{w.message}</li>)}</ul></section>}
    {draft?.retrieval && <section aria-label="检索理解" role="note"><strong>检索理解（我理解为——用以核对有没有理解错）</strong><ul>
      <li>范围：类型 {draft.retrieval.scope?.kind || '-'}；近 {draft.retrieval.scope?.weeksBack || 0} 周；路径 {draft.retrieval.scope?.folderPath || '（未限定）'}；检索词 [{(draft.retrieval.scope?.queries || []).join('、')}]</li>
      <li>实际引用 {draft.retrieval.used?.length || 0} 份知识库材料：{(draft.retrieval.used || []).map(u => u.title).join('、')}</li>
      {draft.retrieval.verification?.applied ? <li>核验：{draft.retrieval.verification.onTopic ? '贴合本意' : '可能不贴合本意'} {draft.retrieval.verification.gaps?.length ? `；缺：${draft.retrieval.verification.gaps.join('；')}` : ''} {draft.retrieval.verification.skipped?.length ? `；已剔除：${draft.retrieval.verification.skipped.join('、')}` : ''}{draft.retrieval.verification.note ? `；${draft.retrieval.verification.note}` : ''}</li> : null}
    </ul></section>}

    {panel && <section className="rr-detail"><button className="rr-button" onClick={() => setPanel(null)}>关闭详情</button>
      {panel.type === 'humanItems' && <HumanItemsPanel key={`${draft?.reportId}:${panel.value?.saveToken}`} value={panel.value} readOnly={readOnly || dirty || panel.value?.status!=='draft'} onSave={(items,saveToken)=>action('saveHumanItems',{items,saveToken})}/>}
      {panel.type === 'diff' && <><p>左：本轮基线；右：当前稿。无法确定基线时仅展示审计记录，不伪造差异。</p>{typeof (panel.value?.baselineMarkdown ?? draft?.baselineMarkdown) === 'string' ? <Diff before={panel.value?.baselineMarkdown ?? draft.baselineMarkdown} after={text} /> : <p>Host 尚未提供 baselineMarkdown。</p>}<pre className="rr-pre">{JSON.stringify(panel.value,null,2)}</pre></>}
      {panel.type === 'versions' && <><h3>确认版本（不可变）</h3>{versions.map(v => <div key={v.versionId} className="rr-record"><strong>{v.versionId} {v.title}</strong> <button className="rr-button" disabled={busy || dirty} onClick={() => action('publishPlan', {versionId:v.versionId})}>查看此版本发布清单</button>{typeof v.markdown === 'string' && <details><summary>阅读版本正文</summary><pre className="rr-pre">{v.markdown}</pre></details>}</div>)}</>}
      {panel.type === 'timeline' && <button className="rr-button" disabled={busy} onClick={() => showPublication('publicationStatus')}>发布记录</button>}
      {panel.type === 'timeline' && <Timeline value={panel.value} />}
      {panel.type === 'publishPlan' && <><h3>发布清单：{panel.value?.versionId}</h3><p>仅以下按钮会发出 publish 请求。请核对正文、图片、公开信息及知识库身份。</p><pre className="rr-pre">{JSON.stringify(panel.value,null,2)}</pre><button className="rr-button" disabled={busy || dirty || !verified} onClick={event => { if (!event.nativeEvent.isTrusted) { setError('发布必须由人类实际点击'); return; } action('publish', { versionId:panel.value?.versionId, planId:panel.value?.planId, digest:panel.value?.digest, publishToken:panel.value?.publishToken, userInitiated:true }); }}>{demo ? '模拟发布此确认版' : '发布此确认版至 WeKnora'}</button></>}
      {panel.type === 'publish' && <><h3>{demo ? '模拟发布回执（未上传）' : '发布回执'}</h3><p>{publicationStateText(panel.value)}</p><p>已提交并不等于完成。请用只读核对查看状态；此按钮不会再次调用发布。</p><button className="rr-button" disabled={busy} onClick={() => showPublication('reconcile')}>只读核对</button>{' '}<button className="rr-button" disabled={busy} onClick={() => showPublication('publicationStatus')}>查看发布记录</button><pre className="rr-pre">{JSON.stringify(panel.value,null,2)}</pre></>}
      {panel.type === 'publicationStatus' && <PublicationRecords value={panel.value} busy={busy} onRead={showPublication} />}
    </section>}
      </aside>
    </div>
    <footer className="rr-status" role="status">{demo ? '演示模式 · ' : ''}{status} · {dirty ? '未保存，PDF 为旧预览' : synced && pdf ? 'PDF 已同步' : preview?.status === 'failed' ? 'PDF 生成失败' : 'PDF 等待生成 / 旧预览'}</footer>
    {error && <div className="rr-error" role="alert">{error}</div>}
    {confirmClose && <section className="rr-close-confirm" role="alert"><p>有未保存修改，放弃后将丢失这些内容。</p><button className="rr-button rr-button--danger" onClick={close}>放弃并关闭</button> <button className="rr-button" onClick={() => setConfirmClose(false)}>返回编辑</button></section>}
  </dialog>;
}

// The footer owns only a trigger. The root shell owns the single workspace overlay.
export function createWorkspaceController() {
  let value = null;
  const listeners = new Set();
  return {
    snapshot: () => value,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    open: sessionId => { if (value) return; value = { sessionId }; for (const listener of listeners) listener(); },
    close: () => { value = null; for (const listener of listeners) listener(); }
  };
}
export function WorkspaceOverlay({ controller }) {
  const opened = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  return <><style>{workspaceCss}</style>{opened && <Workspace sessionId={opened.sessionId} close={controller.close} />}</>;
}
export function RegisteredTrigger({ controller, sessionId, getSessionId, renderTrigger, footer = false, wide = true }) {
  const opened = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const onClick = () => controller.open(sessionId || getSessionId?.() || null);
  return renderTrigger({ footer, wide, opened: !!opened, onClick });
}
export const inject = ['slots'];
export function apply(ctx, renderTrigger) {
  const controller = createWorkspaceController();
  const triggerProps = () => ({ controller, renderTrigger, getSessionId: () => ctx.get('sessions')?.list.getSnapshot().current ?? null });
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name:'conversation.session.header.actions', id:'report-review', order:30, inject:triggerProps }, RegisteredTrigger));
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name:'sidebar.footer.action', id:'report-review', label:'周报工作台', order:15, inject: () => ({ ...triggerProps(), footer:true }) }, RegisteredTrigger));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name:'shell.overlay', id:'report-review', order:30, inject: () => ({ controller }) }, WorkspaceOverlay));
}
