import React, { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { MergeView } from '@codemirror/merge';

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
  LLM_SYNTHESIS_CONTEXT_OVERFLOW: '参考材料过多，超出当前模型上下文容量，本次未完成综合推理。请缩短历史参考窗口（如减少“近N周”或改用更具体的日期范围）、精简【分析要求】，或减少联网信源数量后重试。'
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
    <button style={button} disabled={busy} onClick={() => onRead('publicationStatus')}>刷新发布记录</button>{' '}
    <button style={button} disabled={busy} onClick={() => onRead('reconcile')}>只读核对</button>
    {notices.length > 0 && <ul>{notices.map(w => <li key={w.code}>{w.code}：{w.message}</li>)}</ul>}
    {!records.length && <p>暂无发布记录；不会自动创建发布任务。</p>}
    {records.map((r,index) => <article key={`${recordText(r.planId)}-${index}`} style={{padding:8,borderBottom:'1px solid #ddd'}}>
      <strong>{recordText(r.versionId)} · 计划 {recordText(r.planId)}</strong><p>{publicationStateText(r)}</p>
      <dl><dt>上传阶段</dt><dd>{recordText(r.phase || r.status)}</dd><dt>远端资料 ID</dt><dd>{recordText(r.remoteId)}</dd><dt>解析状态</dt><dd>{recordText(r.parseStatus)}{r.parseReady === true ? '（解析就绪）' : ''}</dd><dt>检索核验</dt><dd>未核验；不标记发布完成</dd><dt>最近只读核对时间</dt><dd>{recordText(r.checkedAt)}</dd></dl>
    </article>)}
  </>;
}
const asDraft = v => v?.draft || v?.workingDraft || v;
const rows = (v, key) => Array.isArray(v) ? v : v?.[key] || [];
const darkBg = '#1e2530', darkPanel = '#262e3a', darkInput = '#2a3341', darkBorder = '#3a4454', text = '#eef2f6', muted = '#aeb9c6';
const button = { padding: '6px 10px', border: `1px solid ${darkBorder}`, borderRadius: 5, background: darkInput, color: text, cursor: 'pointer', colorScheme: 'dark' };
const darkEditorTheme = EditorView.theme({
  '&': { height: '100%', color: text, backgroundColor: darkBg },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-content': { caretColor: text },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: text },
  '.cm-gutters': { backgroundColor: '#232b37', color: muted, border: 'none' },
  '.cm-activeLine': { backgroundColor: darkInput },
  '.cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#3a4a63' },
  '.cm-line, .cm-gutterElement': { color: text }
}, { dark: true });
function Editor({ value, onChange, readOnly = false }) {
  const root = useRef(null), view = useRef(null), change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    view.current = new EditorView({ parent: root.current, state: EditorState.create({ doc: value || '', extensions: [lineNumbers(), history(), markdown(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping, darkEditorTheme, EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), EditorView.updateListener.of(u => { if (u.docChanged && !u.transactions.some(t => t.isUserEvent('remote'))) change.current?.(u.state.doc.toString()); })] }) });
    return () => { view.current.destroy(); view.current = null; };
  }, [readOnly]);
  useEffect(() => { const v = view.current; if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value || '' }, userEvent: 'remote' }); }, [value]);
  return <div ref={root} style={{ height: '100%', minHeight: 0 }} />;
}
function Diff({ before, after }) {
  const root = useRef(null);
  useEffect(() => { const merge = new MergeView({ parent: root.current, a: { doc: before, extensions: [markdown(), darkEditorTheme, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping] }, b: { doc: after, extensions: [markdown(), darkEditorTheme, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping] } }); return () => merge.destroy(); }, [before, after]);
  return <div ref={root} style={{ maxHeight: '45vh', overflow: 'auto' }} />;
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
    {items.length===0 && <p>暂无可确认的人类修订块。</p>}{items.map((item,n)=><fieldset key={item.annotationId} disabled={readOnly} style={{marginBottom:8}}><legend>{item.annotationId}</legend><pre style={{whiteSpace:'pre-wrap'}}>{item.content || '当前内容无法可靠定位'}</pre>{item.mappingConfidence==='low' && <p>低置信度：请核对来源，不自动认定为有效情报。</p>}
      <label><input type="checkbox" checked={item.selected===true} onChange={e=>update(n,{selected:e.target.checked})}/>重点条目</label>{' '}
      <label>类别 <select value={item.category} onChange={e=>update(n,{category:e.target.value})}>{[['supplement','补充'],['correction','纠错'],['retraction','撤回'],['judgment','个人判断'],['style','措辞/排版']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>{' '}
      <label>公开范围 <select value={item.visibility} onChange={e=>update(n,{visibility:e.target.value})}><option value="local">仅本地</option><option value="public">可公开</option></select></label>{' '}
      <label>可公开来源 <input maxLength={4000} value={item.publicSource || ''} onChange={e=>update(n,{publicSource:e.target.value})}/></label>
    </fieldset>)}<button style={button} disabled={readOnly} onClick={()=>onSave(humanItemPayload(items),value.saveToken)}>保存人工信息选择（仅本地）</button></section>;
}
function Workspace({ sessionId, close }) {
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
    current.current.busy = true; setBusy(true); setError(''); setStatus('正在生成周报（5100 数据 · ' + (analysisPrompt.trim() ? '按分析要求由 LLM 分析' : '纯 7 天数据') + (webSearchEnabled ? ' · 联网检索' : '') + '），请稍候');
    try { const result = await request('generate',input); if (!alive.current) return;
      const d = asDraft(result); adopt(result); setReports(v => [...v.filter(r => r.reportId !== d.reportId), d]); setPreview(null); setPanel(null); setStatus('初稿已生成并保存，请人工审阅；尚未完成或发布');
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
  const request = (action, data = {}) => api(sessionId, action, data);
  const fail = e => { if (alive.current) { setError(`${e.code || 'ERROR'}: ${e.message}`); setStatus(e.code?.toLowerCase().includes('conflict') ? '冲突：本地草稿已保留，请对照远端后处理' : '操作失败，本地草稿保留'); } };
  function adopt(value) { const d = asDraft(value); if (!d?.reportId || typeof d.markdown !== 'string') throw new Error('Host 未返回有效工作稿'); const sameReport = current.current.draft?.reportId === d.reportId; setReportWarnings(previous => { const received = safeWarnings(value?.warnings, d.warnings); return sameReport ? safeWarnings(previous.map(w => w.code), received.map(w => w.code)) : received; }); revision.current++; current.current = { ...current.current, draft: d, text: d.markdown, dirty: false }; setDraft(d); setText(d.markdown); setDirty(false); setStatus('已保存'); setError(''); }
  async function load(id) { if (current.current.dirty || saving.current) { setError('请先保存或导出当前脏稿；不会覆盖本地输入。'); return; } setBusy(true); try { const d = await request('get', { reportId: id }); if (alive.current) { adopt(d); setPreview(null); setPanel(null); } } catch(e) { fail(e); } finally { if (alive.current) setBusy(false); } }
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
  useEffect(() => { alive.current = true; request('list').then(v => alive.current && setReports(rows(v, 'reports'))).catch(fail); request('identity').then(v => alive.current && setIdentity(v)).catch(fail); request('templateList').then(v => alive.current && setTemplates(v?.templates || [])).catch(() => {}); return () => { alive.current = false; previewSerial.current++; }; }, [sessionId]);
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
    else if (name === 'confirm') { setStatus('已完成：确认版已冻结，尚未发布'); setPanel({ type: 'versions', value: await request('versions', { reportId: draft.reportId }) }); const d = await request('get', { reportId: draft.reportId }); adopt(d); setStatus('已完成，尚未发布'); }
    else if (name === 'saveHumanItems') { const d=await request('get',{reportId:draft.reportId}); if(!alive.current)return; adopt(d); setPanel({type:'humanItems',value:result}); setStatus('人工信息选择已本地保存，尚未独立入库'); }
    else setPanel({ type: name, value: result });
  } catch(e) { fail(e); } finally { if(alive.current) setBusy(false); } }
  async function showPublication(name = 'publicationStatus') {
    const c = current.current;
    if (!c.draft || c.busy || saving.current) return;
    current.current.busy = true; setBusy(true); setError('');
    try { const result = await readPublication(sessionId, c.draft.reportId, name);
      if (!alive.current || current.current.draft?.reportId !== c.draft.reportId) return;
      setPanel({ type:'publicationStatus', value:result });
      setStatus(name === 'reconcile' ? '只读核对已返回；未触发上传，检索仍未核验' : '已读取发布记录；未触发上传');
    } catch(e) { fail(e); } finally { if (alive.current) { current.current.busy = false; setBusy(false); } }
  }
  async function publishAll() {
    const c = current.current;
    if (!c.draft || c.busy || saving.current || dirty) return;
    current.current.busy = true; setBusy(true); setError(''); setConfirmPublish(false);
    setStatus('正在发布到 WeKnora（runzhouwork）…');
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
      const reconciled = await readPublication(sessionId, reportId, 'reconcile');
      const d = asDraft(await request('get', { reportId })); if (alive.current) adopt(d);
      setPanel({ type: 'publicationStatus', value: reconciled });
      setStatus('已提交发布到 WeKnora；上传/解析为异步，请用只读核对确认结果，核验前不标记发布完成。');
    } catch(e) { fail(e); } finally { if (alive.current) { current.current.busy = false; setBusy(false); } }
  }
  async function showDiff() { if (!draft) return; try { const a = await request('audit', { reportId: draft.reportId }); setPanel({ type: 'diff', value: a }); } catch(e) { fail(e); } }
  function exportDraft() { const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `${draft?.title || 'report'}-working.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  const assetKey = previewAssetKey(preview);
  useEffect(() => {
    let cancelled = false, ownedUrl;
    setPdf(null);
    if (!assetKey) return;
    const controller = new AbortController();
    hostFetch(preview.pdfUrl, { credentials:'same-origin', signal:controller.signal }).then(async response => {
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
  const warnings = safeWarnings(reportWarnings.map(w => w.code), draft?.warnings, preview?.warnings);
  const verified = identity?.confirmed === true && !!identity?.displayName;
  const versions = panel?.type === 'versions' ? rows(panel.value, 'versions') : [];
  return <div role="dialog" aria-modal="true" aria-label="周报审阅工作台" style={{ position: 'fixed', inset: '3vh 2vw', zIndex: 10000, background: darkBg, color: text, border: `1px solid ${darkBorder}`, borderRadius: 10, boxShadow: '0 10px 60px #0007', display: 'flex', flexDirection: 'column', padding: 14, gap: 10, colorScheme: 'dark' }}>
    <header style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}><strong>RUN-19 周报审阅</strong>
      <select aria-label="选择报告" value={draft?.reportId || ''} disabled={busy || dirty} onChange={e => load(e.target.value)}><option value="">选择报告</option>{reports.map(r => <option key={r.reportId} value={r.reportId}>{r.title || r.reportId}</option>)}</select>
      <button style={button} disabled={busy || dirty} onClick={async () => { const title = window.prompt('新报告标题'); if (!title) return; setBusy(true); try { const d = asDraft(await request('create', { title, markdown: '# '+title+'\n', assets: [] })); adopt(d); setReports(v => [...v, d]); } catch(e) { fail(e); } finally { setBusy(false); } }}>新建</button>
      <button style={button} disabled={!dirty || readOnly} onClick={() => { setError(''); save(); }}>保存 / 重试</button>
      <button style={button} disabled={!draft} onClick={exportDraft}>导出工作稿 MD</button>
      <button style={button} disabled={!draft} onClick={showDiff}>差异 / 修订</button>
      <button style={button} disabled={!draft || dirty || busy} onClick={() => action('humanItems')}>重点人工信息</button>
      <button style={button} disabled={!draft || dirty || busy} onClick={() => action('versions')}>确认版本</button>
      <button style={button} disabled={!draft || busy} onClick={() => showPublication('publicationStatus')}>发布记录</button>
      {!confirmPublish ? (
        <button style={button} disabled={!draft || dirty || readOnly || !verified} title={!verified ? '知识库身份未确认，不能发布' : ''} onClick={() => setConfirmPublish(true)}>确认发布</button>
      ) : (
        <span style={{display:'inline-flex',gap:6,alignItems:'center'}}>
          <span style={{color:muted}}>将冻结确认版并上传到 WeKnora（runzhouwork）开始分析，确认？</span>
          <button style={{...button, background:'#1f5c2b', color:'#d7ffd7', borderColor:'#3a8a44'}} disabled={busy} onClick={publishAll}>确认发布</button>
          <button style={button} disabled={busy} onClick={() => setConfirmPublish(false)}>取消</button>
        </span>
      )}
      <button style={button} disabled={draft?.status !== 'confirmed' || dirty || busy} onClick={() => action('startRevision')}>开启新一轮修订</button>
      {!confirmClose ? (
        <button style={{...button, marginLeft:'auto'}} onClick={() => { if (!dirty && !saving.current) close(); else setConfirmClose(true); }}>关闭</button>
      ) : (
        <span style={{display:'inline-flex',gap:6,marginLeft:'auto'}}>
          <span style={{color:muted}}>有未保存修改，放弃将丢失未保存的临时文档。</span>
          <button style={{...button, background:'#5c1f28', color:'#ffd7d7', borderColor:'#a33'}} onClick={() => { setConfirmClose(false); close(); }}>放弃并关闭</button>
          <button style={button} onClick={() => setConfirmClose(false)}>取消</button>
        </span>
      )}
    </header>
    <form onSubmit={generate} style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}} aria-label="生成周报参数">
      <label>商品 <input aria-label="商品" value={variety} disabled={busy} onChange={e => setVariety(e.target.value)} style={{width:90}} required /></label>
      <label>截止日期 <input aria-label="截止日期" type="date" value={end} disabled={busy} onChange={e => setEnd(e.target.value)} required /></label>
      <label><input type="checkbox" checked={webSearchEnabled} disabled={busy} onChange={e => setWebSearchEnabled(e.target.checked)} />联网检索（新闻/外部信源）</label>
      <label style={{display:'block'}}>分析要求（可选，可用下方模板，也可直接增删章节）</label>
      <span style={{display:'inline-flex',gap:6,alignItems:'center',width:'100%',flexWrap:'wrap'}}>
        <select aria-label="选择模板" value={tmplId} disabled={busy} onChange={e => loadTemplate(e.target.value)} style={{font:'inherit',padding:'2px 4px'}}>
          <option value="">默认模板</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <input aria-label="模板名称" placeholder="模板名称（可留空）" value={tmplName} onChange={e => setTmplName(e.target.value)} disabled={busy} style={{width:150,font:'inherit',padding:'2px 4px'}} />
        <button type="button" style={button} disabled={busy || !analysisPrompt.trim()} onClick={saveTemplate}>保存为模板</button>
        {tmplId && <button type="button" style={button} disabled={busy} onClick={async () => { try { const r = await request('templateDelete', { id: tmplId }); if (r?.deleted && alive.current) { setTemplates(v => v.filter(t => t.id !== tmplId)); setTmplId(''); setTmplName(''); } } catch(e) { fail(e); } }}>删除模板</button>}
      </span>
      <textarea aria-label="分析要求（可选）" value={analysisPrompt} disabled={busy} onChange={e => setAnalysisPrompt(e.target.value)} rows={3} style={{display:'block',width:'100%',minHeight:56,boxSizing:'border-box',font:'inherit',resize:'vertical'}} placeholder="留空则仅按 7 天数据出周报。需要结合历史周报时写清要求，如“请结合近四周同品类周报做连续性梳理”；也可只写“补充多空逻辑”“分析供需结构”等。" />
      <button style={button} type="submit" disabled={busy || dirty}>生成周报</button>
    </form>
    <div role="status">{status} · {dirty ? '未保存，PDF 为旧预览' : synced && pdf ? 'PDF 已同步' : preview?.status === 'failed' ? 'PDF 生成失败' : 'PDF 旧预览 / 等待生成'} · {verified ? `审核署名：${identity.displayName}` : '知识库身份未确认，禁止完成；不会使用默认 admin'}</div>
    {draft?.status === 'confirmed' && <div role="note">此稿已确认并冻结，正文只读。请点击“开启新一轮修订”后再编辑，不会直接修改确认版。</div>}
    {warnings.length > 0 && <section aria-label="审阅注意事项" role="status"><strong>注意事项</strong><ul>{warnings.map(w => <li key={w.code}><code>{w.code}</code>：{w.message}</li>)}</ul></section>}
    {error && <div role="alert" style={{color:'#ff8f8f',whiteSpace:'pre-wrap'}}>{error}</div>}
    <main style={{flex:1,minHeight:0,display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}><section style={{minHeight:0,border:`1px solid ${darkBorder}`,background:'#232b37'}}>{draft ? <Editor value={text} readOnly={readOnly} onChange={value => { if (isDraftReadOnly(current.current.draft, current.current.busy)) return; revision.current++; current.current.dirty = true; current.current.text = value; setText(value); setDirty(true); setStatus('有未保存修改'); }} /> : <p>选择或新建报告。生成器与 Agent 共用本工作稿。</p>}</section><section style={{display:'flex',flexDirection:'column',minHeight:0}}>{pdf ? <><a href={pdf.url} target="_blank" rel="noreferrer" download>下载 / 打开当前 PDF{!synced ? '（旧预览）' : ''}</a><object aria-label="实际 PDF 预览" data={pdf.url} type="application/pdf" style={{width:'100%',flex:1,minHeight:0}}><a href={pdf.url} target="_blank" rel="noreferrer">浏览器无法内嵌 PDF，请打开实际 PDF</a></object></> : <p>尚无可用实际 PDF。不以 HTML 预览替代 PDF。</p>}</section></main>
    {panel && <section style={{borderTop:`1px solid ${darkBorder}`,maxHeight:'45vh',overflow:'auto',background:darkPanel,padding:8}}><button style={button} onClick={() => setPanel(null)}>关闭详情</button>
      {panel.type === 'humanItems' && <HumanItemsPanel key={`${draft?.reportId}:${panel.value?.saveToken}`} value={panel.value} readOnly={readOnly || dirty || panel.value?.status!=='draft'} onSave={(items,saveToken)=>action('saveHumanItems',{items,saveToken})}/>}
      {panel.type === 'diff' && <><p>左：本轮基线；右：当前稿。无法确定基线时仅展示审计记录，不伪造差异。</p>{typeof (panel.value?.baselineMarkdown ?? draft?.baselineMarkdown) === 'string' ? <Diff before={panel.value?.baselineMarkdown ?? draft.baselineMarkdown} after={text} /> : <p>Host 尚未提供 baselineMarkdown。</p>}<pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(panel.value,null,2)}</pre></>}
      {panel.type === 'versions' && <><h3>确认版本（不可变）</h3>{versions.map(v => <div key={v.versionId} style={{padding:8,borderBottom:'1px solid #ddd'}}><strong>{v.versionId} {v.title}</strong> <button style={button} disabled={busy || dirty} onClick={() => action('publishPlan', {versionId:v.versionId})}>查看此版本发布清单</button>{typeof v.markdown === 'string' && <details><summary>阅读版本正文</summary><pre style={{whiteSpace:'pre-wrap'}}>{v.markdown}</pre></details>}</div>)}</>}
      {panel.type === 'publishPlan' && <><h3>发布清单：{panel.value?.versionId}</h3><p>仅以下按钮会发出 publish 请求。请核对正文、图片、公开信息及知识库身份。</p><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(panel.value,null,2)}</pre><button style={button} disabled={busy || dirty || !verified} onClick={event => { if (!event.nativeEvent.isTrusted) { setError('发布必须由人类实际点击'); return; } action('publish', { versionId:panel.value?.versionId, planId:panel.value?.planId, digest:panel.value?.digest, publishToken:panel.value?.publishToken, userInitiated:true }); }}>发布此确认版至 WeKnora</button></>}
      {panel.type === 'publish' && <><h3>发布回执</h3><p>{publicationStateText(panel.value)}</p><p>已提交并不等于完成。请用只读核对查看状态；此按钮不会再次调用发布。</p><button style={button} disabled={busy} onClick={() => showPublication('reconcile')}>只读核对</button>{' '}<button style={button} disabled={busy} onClick={() => showPublication('publicationStatus')}>查看发布记录</button><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(panel.value,null,2)}</pre></>}
      {panel.type === 'publicationStatus' && <PublicationRecords value={panel.value} busy={busy} onRead={showPublication} />}
    </section>}
  </div>;
}
function HeaderAction({ sessionId }) { const [open,setOpen] = useState(false); return <><button style={button} onClick={() => setOpen(true)}>生成周报</button>{open && <Workspace key={sessionId} sessionId={sessionId} close={() => setOpen(false)} />}</>; }
export const inject = ['slots'];
export function apply(ctx) { ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name:'conversation.session.header.actions', id:'report-review', order:30 }, HeaderAction)); }
