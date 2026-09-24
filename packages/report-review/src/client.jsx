import React, { useEffect, useRef, useState, useMemo, useSyncExternalStore } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { MergeView } from '@codemirror/merge';
import workspaceCss from './workspace.css';
import { BlockEditor } from './block-editor.jsx';
import { useVoicePrefs } from './editor-ai/hooks/useVoicePrefs.js';
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
// Readable review views: field cards replace raw JSON dumps; raw JSON stays in a collapsed fallback.
const FIELD_MONO = ['digest','publishToken','saveToken','versionId','planId','id','remoteId','remote_id','reportId','version_id','knowledge_id','knowledge_base_id','resourceUri','resource_uri','file_path','sha256','itemKey','item_key'];
function FieldRow({ label, value, mono }) {
  if (value === undefined || value === null || value === '') return null;
  return <div className="rr-field-row"><dt>{label}</dt><dd className={mono || FIELD_MONO.includes(label) ? 'rr-mono' : ''}>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>;
}
function FieldCard({ title, obj, order, children }) {
  const entries = obj && typeof obj === 'object' ? Object.entries(obj) : [];
  const rows = order ? order.map(k => [k, obj?.[k]]).filter(([,v]) => v !== undefined && v !== null && v !== '') : entries.filter(([,v]) => v !== undefined && v !== null && v !== '');
  return <div className="rr-field-card"><h4>{title}</h4><dl className="rr-fields">{rows.map(([k,v],i) => <FieldRow key={`${k}-${i}`} label={k} value={v} />)}{children}</dl></div>;
}
function RawJSON({ value }) {
  return <details className="rr-raw"><summary>查看原始 JSON（调试用）</summary><pre className="rr-pre">{JSON.stringify(value, null, 2)}</pre></details>;
}
const phaseBadge = r => {
  if (r.parseReady === true) return ['is-ready', '解析就绪'];
  if (r.phase === 'submitted' || r.status === 'submitted') return ['is-submitted', '已提交'];
  if (r.phase === 'failed' || r.status === 'failed') return ['is-failed', '失败'];
  if (r.outcomeUnknown === true || r.phase === 'unknown') return ['is-unknown', '结果未知'];
  return ['is-pending', '进行中'];
};
export function PublicationRecords({ value, busy, onRead }) {
  const records = Array.isArray(value?.records) ? value.records : [];
  const notices = safeWarnings(value?.warnings);
  return <><h3>发布记录 / 只读核对结果</h3><p>核对只读取远端状态并更新本地核对记录，不上传、不重解析、不删除，也不会重试发布。解析就绪不等于检索已核验。</p>
    <button className="rr-button" disabled={busy} onClick={() => onRead('publicationStatus')}>刷新发布记录</button>{' '}
    <button className="rr-button" disabled={busy} onClick={() => onRead('reconcile')}>只读核对</button>
    {notices.length > 0 && <ul>{notices.map(w => <li key={w.code}>{w.code}：{w.message}</li>)}</ul>}
    {!records.length && <p>暂无发布记录；不会自动创建发布任务。</p>}
    {records.map((r,index) => { const [cls,label] = phaseBadge(r); return <article key={`${recordText(r.planId)}-${index}`} className="rr-record">
      <div className="rr-row"><strong>{recordText(r.versionId)} · 计划 {recordText(r.planId)}</strong><span className={`rr-phase ${cls}`}>{label}</span></div><p>{publicationStateText(r)}</p>
      <dl><dt>上传阶段</dt><dd>{recordText(r.phase || r.status)}</dd><dt>远端资料 ID</dt><dd>{recordText(r.remoteId)}</dd><dt>解析状态</dt><dd>{recordText(r.parseStatus)}{r.parseReady === true ? '（解析就绪）' : ''}</dd><dt>检索核验</dt><dd>未核验；不标记发布完成</dd><dt>最近只读核对时间</dt><dd>{recordText(r.checkedAt)}</dd></dl>
    </article>; })}
  </>;
}
// ---- Generation progress (controllable loading animation) ----
const GEN_STEP_ORDER = ['init','plan','retrieve','data','charts','analyse','assemble','save','pdf'];
const GEN_STEP_NAMES = { init:'初始化', plan:'检索规划', retrieve:'检索资料', data:'获取数据', charts:'生成图表', analyse:'AI 分析', assemble:'组装正文', save:'保存草稿', pdf:'生成 PDF' };
const GEN_ICON = { done:'✓', running:'◌', failed:'✕', cancelled:'–', skipped:'–', pending:'' };
const GEN_STXT = { done:'已完成', running:'进行中', failed:'失败', cancelled:'已取消', skipped:'跳过', pending:'待处理' };
const genStepsInit = () => GEN_STEP_ORDER.map(k => ({ key:k, name:GEN_STEP_NAMES[k], state:'pending', label:'', detail:'' }));
const genErrorFix = code => ({ 'LLM_SYNTHESIS_CONTEXT_OVERFLOW':'参考材料过多，超出模型上下文。建议缩短「近N周」或精简【分析要求】后重试',
  'KNOWLEDGE_SEARCH_FAILED':'知识库检索不可用，请检查连接后重试', 'WEB_SEARCH_FAILED':'联网检索失败，请稍后重试',
  'GENERATION_TIMEOUT':'数据/图表生成超时，请稍后重试', 'GENERATION_FAILED':'数据/图表生成失败，请检查数据源',
  'SOURCE_FAILED':'数据/图表生成失败，请检查数据源与连接配置', 'SOURCE_UNAVAILABLE':'数据源未就绪',
  'CONNECTION_REQUIRED':'需要先配置 WeKnora 连接', 'SOURCE_ROOT_REQUIRED':'数据输出目录缺失', 'PDF_RENDER_FAILED':'PDF 渲染失败，请重试预览' }[code] || '未知错误，请重试');
// Finalize step states on a generation failure: mark the failing step failed, steps
// after it skipped, and steps before it done — so nothing is left "进行中".
const finalizeFailureSteps = (steps, failKey) => {
  const at = steps.findIndex(s => s.key === failKey);
  const idx = at === -1 ? steps.length - 1 : at;
  return steps.map((s, i) => {
    if (i < idx) return s.state === 'done' ? s : { ...s, state: 'done', label: '', detail: s.detail || '' };
    if (i === idx) return { ...s, state: 'failed' };
    return { ...s, state: 'skipped', label: '', detail: '' };
  });
};
// Turn a bare error code into a friendly, actionable Chinese message for the footer bar.
const friendlyError = (code, message) => {
  const head = ({ SOURCE_FAILED:'数据/图表生成失败', GENERATION_FAILED:'数据/图表生成失败', GENERATION_TIMEOUT:'生成超时', SOURCE_UNAVAILABLE:'数据源未就绪', CONNECTION_REQUIRED:'连接未配置', KNONLEDGE_SEARCH_FAILED:'知识库检索失败', WEB_SEARCH_FAILED:'联网检索失败' })[code];
  if (!head) return message || code || '操作失败';
  const cause = /cause=([A-Z0-9_]+)/.exec(message || '')?.[1];
  const causeFix = cause && ({ GENERATION_FAILED:'请检查数据源/连接，或先在「⚙ 设置」配置 WeKnora 后重试', GENERATION_TIMEOUT:'生成超时，请稍后重试', CONNECTION_REQUIRED:'请先在「⚙ 设置」配置连接' })[cause];
  return `${head}${cause ? `（${cause}）` : ''}；${causeFix || genErrorFix(code) || '请重试，或检查连接与配置。'}`;
};
const GEN_DEMO_LABEL = { init:'正在初始化…', plan:'LLM 正在判断检索范围…', retrieve:'正在检索知识库 / 联网…', data:'正在读取数据库（5100）…', charts:'正在渲染图表…', analyse:'LLM 正在写「本周多空逻辑」…', assemble:'正在组装正文…', save:'正在保存草稿…', pdf:'正在生成 PDF…' };
const GEN_DEMO_DETAIL = { init:'初始化完成', plan:'判定：结合近4周知识库材料', retrieve:'知识库命中 12 条 · 联网命中 8 条 · 核验剔除 3 条', data:'26 条序列拉取完成', charts:'6 张图表渲染完成', analyse:'多空逻辑 · 近四周连贯性 · 风险提示', assemble:'锚点替换 · 资产校验通过', save:'已写入报告库，带审计', pdf:'4 页 · 6 图' };
// ---- Full-width review detail views (evidence opens in the main canvas) ----
const REVIEW_TITLES = { humanItems:'重点人工信息', diff:'版本差异', versions:'确认版本（不可变）', timeline:'版本时间线', publishPlan:'发布清单', publish:'发布回执', publicationStatus:'发布记录 / 只读核对' };
const reviewTitle = t => REVIEW_TITLES[t] || '审阅详情';
const reviewSub = (t, v) => t === 'diff' ? '本轮基线 vs 当前稿' : t === 'versions' ? '审查确认版本（不可变）' : t === 'timeline' ? '每次版本切片与相邻差异' : t === 'publishPlan' ? `核对正文 / 图片 / 公开信息 / 知识库身份` : t === 'publish' ? '发布提交回执' : t === 'publicationStatus' ? '上传 / 解析为异步；核验前不标记发布完成' : '';
export function GenerateProgress({ progress, onCancel, onRetry, onRegenerate, onClose }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(() => new Set());
  // Auto-collapse to a compact header after a successful generation so the card
  // never stays expanded over content (it would intercept clicks on nearby buttons).
  useEffect(() => {
    if (progress?.status === 'ok') { const t = setTimeout(() => setOpen(false), 1600); return () => clearTimeout(t); }
  }, [progress?.status]);
  if (!progress) return null;
  const steps = progress.steps || [];
  const done = steps.filter(s => s.state === 'done').length;
  const total = steps.length || 1;
  const running = steps.find(s => s.state === 'running');
  const failed = steps.find(s => s.state === 'failed');
  const cur = running || failed;
  const headIcon = progress.status === 'running' ? '◌' : progress.status === 'ok' ? '✓' : progress.status === 'failed' ? '✕' : '–';
  const headState = progress.status === 'running' ? 'running' : progress.status === 'ok' ? 'ok' : progress.status === 'failed' ? 'fail' : 'cancel';
  const headLbl = progress.status === 'running' ? (cur?.label || '正在生成…') : progress.status === 'ok' ? '生成成功' : progress.status === 'failed' ? (failed ? `第 ${steps.findIndex(s=>s.state==='failed')+1} 步（${failed.name}）失败` : `生成失败：${progress.error?.code || '未知错误'}`) : '已取消';
  const headSub = progress.status === 'running' ? (cur ? `第 ${steps.findIndex(s=>s.key===cur.key)+1} 步 · ${cur.name}` : '') : progress.status === 'ok' ? `${done}/${total} 步完成` : progress.status === 'failed' ? (progress.error?.code || '') : `已完成 ${done}/${total} 步`;
  const bar = Math.round(done / total * 100);
  const toggle = key => setExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  return (
    <div className={`rr-gen-progress${open ? ' open' : ''}`} role="status" aria-live="polite">
      <div className="rr-gen-head" role="button" tabIndex={0} onClick={() => setOpen(v => !v)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(v => !v); } }}>
        <span className={`rr-gen-icon ${headState}`}>{headIcon}</span>
        <span className="rr-gen-meta"><span className="rr-gen-lbl">{headLbl}</span><span className="rr-gen-sub">{headSub}</span></span>
        <span className="rr-gen-chev">{open ? '▾' : '▸'}</span>
      </div>
      {open && <div className="rr-gen-body">
        <div className="rr-gen-bar-wrap"><span className="rr-gen-num">{done}/{total} 步完成</span><span className="rr-gen-bar"><i style={{ width: `${bar}%` }} /></span></div>
        {steps.map((s, i) => {
          const showDetails = expanded.has(s.key) || s.state === 'failed';
          return (
          <div key={s.key} className={`rr-gen-step ${s.state}${showDetails ? ' expand' : ''}`}>
            <span className="rr-gen-dot">{GEN_ICON[s.state] || ''}</span>
            <div className="rr-gen-body2">
              <div className="rr-gen-row" role="button" tabIndex={0} onClick={() => toggle(s.key)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(s.key); } }}>
                <span className="rr-gen-name">{s.name}</span>
                <span className="rr-gen-status">{GEN_STXT[s.state]}{s.state === 'running' ? '…' : ''}</span>
              </div>
              <div className="rr-gen-detail">{s.state === 'failed'
                ? <><div className="rr-gen-err">第 {i + 1} 步（{s.name}）失败：{progress.error?.code || ''}</div><div className="rr-gen-fix">{genErrorFix(progress.error?.code)}</div></>
                : <div>{s.detail || s.label || ''}</div>}</div>
            </div>
          </div>);
        })}
      </div>}
      {open && <div className="rr-gen-foot">
        {progress.status === 'running' ? <>
          <span className="rr-gen-hint">正在生成 · 当前第 {steps.findIndex(s => s.state === 'running') + 1} 步</span>
          <button className="rr-button rr-button--danger" onClick={onCancel}>✕ 取消</button></>
          : progress.status === 'failed' ? <>
          <span className="rr-gen-hint">已在第 {steps.findIndex(s => s.state === 'failed') + 1} 步中止</span>
          <button className="rr-button rr-button--primary" onClick={onRetry}>↻ 重试</button>
          <button className="rr-button" onClick={onClose}>关闭</button></>
          : progress.status === 'ok' ? <>
          <span className="rr-gen-hint">生成成功</span>
          <button className="rr-button rr-button--primary" onClick={onRegenerate}>↻ 重新生成</button>
          <button className="rr-button" onClick={onClose}>关闭</button></>
          : <><span className="rr-gen-hint">已中止，未落盘</span>
          <button className="rr-button rr-button--primary" onClick={onRegenerate}>↻ 重新生成</button>
          <button className="rr-button" onClick={onClose}>关闭</button></>}
      </div>}
    </div>
  );
}
const testErrorText = code => ({
  identity_credential_unavailable: '未配置发布密钥（当前为只读模式）',
  IDENTITY_UNVERIFIED: '服务端未确认该密钥的发布身份，请检查发布密钥及其权限',
  scope_rejected: '知识库 ID 不在允许范围',
  INCOMPLETE: '配置不完整：需要地址、知识库 ID 和读取密钥',
  plaintext_non_loopback: '明文 http 只允许本机回环地址，远端请使用 https',
}[code] || code);
export function SettingsPanel({ request, onClose, onIdentity }) {
  const dialogRef = useRef(null);
  const [view, setView] = useState(null);
  const [form, setForm] = useState({ baseUrl: '', kbId: '', tenantId: '', readKey: '', writeKey: '', commodityKbIds: {} });
  const [state, setState] = useState({ busy: true, note: '', error: '' });
  const [test, setTest] = useState(null);
  const [commodityProfiles, setCommodityProfiles] = useState(null);
  const voicePrefs = useVoicePrefs();
  const adopt = v => { setView(v); setForm(f => ({ ...f, baseUrl: v?.baseUrl || '', kbId: v?.kbId || '', tenantId: v?.tenantId || '', readKey: '', writeKey: '', commodityKbIds: v?.commodityKbIds || {} })); };
  useEffect(() => {
    let cancelled = false;
    request('settingsGet').then(v => { if (!cancelled) { adopt(v); setState({ busy: false, note: '', error: '' }); } })
      .catch(e => { if (!cancelled) setState({ busy: false, note: '', error: e.code === 'SETTINGS_UNAVAILABLE' ? '当前 Host 版本不支持可视化设置，请升级插件后完全重启。' : (e.message || '读取设置失败') }); });
    request('commodityOptions').then(v => { if (!cancelled) setCommodityProfiles(v); }).catch(() => { if (!cancelled) setCommodityProfiles({ list: ['锡'], folders: {}, kbIds: {} }); });
    return () => { cancelled = true; };
  }, []);
  // A real modal <dialog> lives in the top layer, so it reliably floats above
  // the workspace dialog (which is itself a modal). Call showModal once mounted.
  useEffect(() => { const d = dialogRef.current; if (d && !d.open) d.showModal(); }, []);
  const save = async () => {
    setState({ busy: true, note: '', error: '' });
    try {
      const settings = { baseUrl: form.baseUrl.trim(), kbId: form.kbId.trim(), tenantId: form.tenantId.trim(), commodityKbIds: form.commodityKbIds || {} };
      if (form.readKey.trim()) settings.readKey = form.readKey.trim();
      if (form.writeKey.trim()) settings.writeKey = form.writeKey.trim();
      const v = await request('settingsSave', { settings });
      adopt(v);
      setState({ busy: false, error: '', note: v?.connectorActive ? '已保存并生效。「配置完整」只校验本地配置，不代表服务可达——点「测试连接」实测服务与密钥；发布需要第 3 项（发布身份）为 ✓。' : `已保存，但配置不完整：${v?.connectorError === 'INCOMPLETE' ? '还需补全地址、知识库 ID 或读取密钥。' : v?.connectorError || '请检查各字段。'}` });
    } catch (e) { setState({ busy: false, note: '', error: e.code === 'SETTINGS_INVALID' ? '有字段不合法：地址须为 http(s) URL（http 仅限本机回环），知识库 ID / 租户 ID 只能包含字母数字、下划线和横线，密钥不能含换行。' : (e.message || '保存失败') }); }
  };
  const runTest = async () => {
    setState(s => ({ ...s, busy: true, note: '', error: '' })); setTest(null);
    try {
      const r = await request('settingsTest');
      setTest(r);
      setState(s => ({ ...s, busy: false }));
      if (r?.publish?.ok) request('identity').then(v => onIdentity?.(v)).catch(() => {});
    } catch (e) { setState(s => ({ ...s, busy: false, error: e.message || '测试失败' })); }
  };
  const field = (key, value) => setForm(f => ({ ...f, [key]: value }));
  return <dialog ref={dialogRef} className="rr-settings" aria-label="连接设置" onCancel={event => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className="rr-settings-card">
      <div className="rr-section-heading"><h2>连接设置</h2><span className="rr-badge">{view?.connectorActive ? '配置完整（未实测）' : '配置不完整'}</span></div>
      {view?.managedByHost && <p className="rr-muted">部分配置由环境变量 / Profile 管理，此处修改仅补充未被其覆盖的项。</p>}
      <label>WeKnora 地址<input aria-label="WeKnora 地址" placeholder="https://weknora.example.internal 或 http://127.0.0.1:8080" value={form.baseUrl} disabled={state.busy} onChange={e => field('baseUrl', e.target.value)} /></label>
      <label>知识库 ID<input aria-label="知识库 ID" placeholder="检索与发布使用的知识库 ID" value={form.kbId} disabled={state.busy} onChange={e => field('kbId', e.target.value)} /></label>
      <label>租户 ID<span className="rr-muted">（可选）</span><input aria-label="租户 ID" placeholder="WeKnora 多租户 ID，单租户可留空" value={form.tenantId} disabled={state.busy} onChange={e => field('tenantId', e.target.value)} /></label>
      {commodityProfiles?.list?.length ? <div className="rr-settings-section"><div className="rr-section-heading"><h3>按商品知识库 ID</h3><span className="rr-muted">留空则使用上方「知识库 ID」</span></div>{commodityProfiles.list.map(c => <label key={c}>{c}<input aria-label={`${c} 知识库 ID`} placeholder="留空使用默认" value={form.commodityKbIds?.[c] || ''} disabled={state.busy} onChange={e => setForm(f => ({ ...f, commodityKbIds: { ...(f.commodityKbIds || {}), [c]: e.target.value } }))} /></label>)}</div> : null}
      <label>读取密钥{view?.readKeySet && <span className="rr-muted">（已保存，留空保持不变）</span>}<input aria-label="读取密钥" type="password" autoComplete="off" placeholder={view?.readKeySet ? '••••••（留空不修改）' : '用于检索的 API Key'} value={form.readKey} disabled={state.busy} onChange={e => field('readKey', e.target.value)} /></label>
      <label>发布密钥{view?.writeKeySet && <span className="rr-muted">（已保存，留空保持不变）</span>}<input aria-label="发布密钥" type="password" autoComplete="off" placeholder={view?.writeKeySet ? '••••••（留空不修改）' : '用于发布的 API Key，可留空（只读）'} value={form.writeKey} disabled={state.busy} onChange={e => field('writeKey', e.target.value)} /></label>
      <div className="rr-settings-section"><div className="rr-section-heading"><h3>语音输入</h3></div>
        <label className="rr-settings-toggle"><input type="checkbox" checked={voicePrefs.enabled} onChange={e => voicePrefs.setEnabled(e.target.checked)} /> 语音转写后自动理解意图并补全提示词<span className="rr-muted">（不自动提交，识别文本先填入输入框，由你确认；关闭则仅返回原始转写）</span></label>
        <p className="rr-muted">目标语言自动跟随系统（当前：{voicePrefs.lang === 'zh-TW' || voicePrefs.lang === 'zh-HK' ? '繁体中文' : (voicePrefs.lang || 'zh-CN').startsWith('en') ? '英文' : '简体中文'}），识别结果若为繁体/简体混用会自动统一。</p>
      </div>
      <p className="rr-muted">密钥保存为本机受限文件，不写入任何配置或补丁；界面不回显密钥内容。发布密钥须与读取密钥不同。</p>
      {state.note && <p className="rr-settings-note" role="status">{state.note}</p>}
      {state.error && <p className="rr-settings-error" role="alert">{state.error}</p>}
      {test && <ul className="rr-settings-test" role="status">
        <li>{test.connectorActive ? '✓ 连接配置已激活' : `✗ 连接未激活：${testErrorText(test.connectorError)}`}</li>
        {test.read && <li>{test.read.ok ? `✓ 读取检索可用（知识库 ${test.kbId}${Number.isFinite(test.read.total) ? `，共 ${test.read.total} 条资料` : ''}）` : `✗ 读取检索失败：${testErrorText(test.read.error)}`}</li>}
        {test.publish && <li>{test.publish.ok ? `✓ 发布身份已确认：${test.publish.username}（「确认发布」将解锁）` : `✗ 发布身份未通过：${testErrorText(test.publish.error)}`}</li>}
      </ul>}
      <div className="rr-row"><button className="rr-button rr-button--primary" disabled={state.busy} onClick={save}>保存并生效</button><button className="rr-button" disabled={state.busy} onClick={runTest}>测试连接</button><button className="rr-button" disabled={state.busy} onClick={onClose}>关闭</button></div>
    </div>
  </dialog>;
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
      {typeof markdowns[v.versionId] === 'string' && <details><summary>阅读 {v.versionId} 正文</summary><MarkdownPreview text={markdowns[v.versionId]} /></details>}
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
  const editorApiRef = useRef(null);
  const [search, setSearch] = useState(''), [viewMode, setViewMode] = useState('editor'), [focused, setFocused] = useState(false);
  const sourceMode = viewMode !== 'editor';
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiModel, setAiModel] = useState(null); // current AI provider/model for the status bar
  const [aiBusy, setAiBusy] = useState(false); // an AI document edit is in flight -> block report switching
  const current = useRef({}), alive = useRef(true), saving = useRef(false), revision = useRef(0), previewSerial = useRef(0), genAbort = useRef(null);
  const [progress, setProgress] = useState(null);
  useEffect(() => {
    if (demo || !sessionId) return;
    let live = true;
    hostFetch('/api/run19/review', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'aiDefaultModel' }) }).then(async r => { if (live && r.ok) { const d = await r.json(); const m = d?.value; if (m?.model) setAiModel({ provider: m.provider, model: m.model }); } else { console.error('[run19] ai-default-model failed:', r.status); } }).catch(e => { console.error('[run19] ai-default-model error:', e); });
    return () => { live = false; };
  }, []);
  const [commodityProfiles, setCommodityProfiles] = useState(null);
  useEffect(() => {
    let live = true;
    if (demo) { setCommodityProfiles({ list: ['锡', '铝', '氧化铝', '锌', '碳酸锂'], folders: { '锡': '根目录/周报' }, kbIds: {} }); return () => { live = false; }; }
    request('commodityOptions').then(v => { if (live) setCommodityProfiles(v); }).catch(() => { if (live) setCommodityProfiles({ list: ['锡'], folders: {}, kbIds: {} }); });
    return () => { live = false; };
  }, [sessionId]);
  const applyGenEv = ev => setProgress(p => { if (!p) return p; const steps = p.steps.map(s => s.key === ev.step ? { ...s, state: ev.state, label: ev.label || s.label, detail: ev.detail || s.detail } : s); return { ...p, steps }; });
  async function runGenerate(input) {
    const controller = new AbortController();
    genAbort.current = controller;
    setProgress({ status: 'running', steps: genStepsInit() });
    try {
      const res = await hostFetch('/api/run19/generate', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, action: 'generate', sessionId }) });
      if (!res.ok) { let body = null; try { body = await res.json(); } catch { /* ignore */ } const e = new Error(body?.error?.message || `HTTP ${res.status}`); e.code = body?.error?.code || 'HTTP_ERROR'; throw e; }
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.t === 'progress') applyGenEv(ev);
          else if (ev.t === 'result') { setProgress(p => ({ ...p, status: 'ok' })); return ev.value; }
          else if (ev.t === 'error') { setProgress(p => ({ ...p, status: 'failed', error: { step: ev.step, code: ev.code, message: ev.message }, steps: finalizeFailureSteps(p.steps, ev.step) })); const e = new Error(ev.message || ev.code); e.code = ev.code; e.step = ev.step; throw e; }
        }
      }
      throw new Error('生成流意外结束');
    } catch (e) {
      if (e?.name === 'AbortError' || controller.signal.aborted) { setProgress(p => ({ ...p, status: 'cancelled' })); throw Object.assign(new Error('生成已取消'), { code: 'GENERATION_CANCELLED' }); }
      throw e;
    }
  }
  const cancelGen = () => { genAbort.current?.abort(); };
  async function runDemoGenerate(input) {
    const controller = new AbortController(); genAbort.current = controller;
    setProgress({ status:'running', steps: genStepsInit() });
    const delay = ms => new Promise(r => setTimeout(r, ms));
    try {
      for (const k of GEN_STEP_ORDER) {
        if (controller.signal.aborted) throw Object.assign(new Error('生成已取消'), { code:'GENERATION_CANCELLED' });
        applyGenEv({ step:k, state:'running', label: GEN_DEMO_LABEL[k] });
        await delay(360 + Math.floor(Math.random() * 260));
        applyGenEv({ step:k, state:'done', detail: GEN_DEMO_DETAIL[k] });
      }
      if (controller.signal.aborted) throw Object.assign(new Error('生成已取消'), { code:'GENERATION_CANCELLED' });
      const result = await request('generate', input);   // demo API
      setProgress(p => ({ ...p, status:'ok' }));
      return result;
    } catch (e) {
      if (controller.signal.aborted) { setProgress(p => ({ ...p, status:'cancelled' })); throw Object.assign(new Error('生成已取消'), { code:'GENERATION_CANCELLED' }); }
      throw e;
    }
  }
  async function generate(event) {
    event.preventDefault();
    if (current.current.dirty || saving.current || current.current.busy) return;
    let input; try { input = generationInput({variety,end,analysisPrompt,webSearchEnabled}); } catch(e) { fail(e); return; }
    current.current.busy = true; setBusy(true); setError('');
    try {
      let result;
      if (demo) { setStatus('正在生成演示周报…'); result = await runDemoGenerate(input); }
      else { setStatus('正在生成周报…'); result = await runGenerate(input); }
      if (!alive.current) return;
      const d = asDraft(result); adopt(result);
      setReports(v => [...v.filter(r => r.reportId !== d.reportId), d]);
      setPreview(null); setPanel(null); setStage('editor'); setViewMode('editor');
      setStatus(demo ? '演示初稿已生成并保存在此浏览器' : '初稿已生成并保存，请人工审阅；尚未完成或发布');
    } catch(e) { if (alive.current) { if (e?.code === 'GENERATION_CANCELLED') setStatus('已取消，未落盘'); else fail(e); } }
    finally { if (alive.current) { current.current.busy = false; setBusy(false); } }
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
  current.current = { draft, text, dirty, busy, aiBusy };
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
  const isConflict = e => (e?.code || '').toLowerCase().includes('conflict');
  const fail = e => { if (alive.current) { setError(friendlyError(e?.code, e?.message)); setStatus(isConflict(e) ? '冲突：本地草稿已保留，请对照远端后处理' : '操作失败，本地草稿保留'); } };
  function adopt(value) { const d = asDraft(value); if (!d?.reportId || typeof d.markdown !== 'string') throw new Error('Host 未返回有效工作稿'); const sameReport = current.current.draft?.reportId === d.reportId; setReportWarnings(previous => { const received = safeWarnings(value?.warnings, d.warnings); return sameReport ? safeWarnings(previous.map(w => w.code), received.map(w => w.code)) : received; }); revision.current++; current.current = { ...current.current, draft: d, text: d.markdown, dirty: false }; setDraft(d); setReports(previous => previous.map(r => r.reportId === d.reportId ? { ...r, title: d.title, status: d.status } : r)); setText(d.markdown); setDirty(false); setStatus('已保存'); setError(''); }
  async function load(id) { if (current.current.dirty || saving.current || aiBusy) { setError(aiBusy ? 'AI 修改进行中，暂时不能切换报告。' : '请先保存或导出当前脏稿；不会覆盖本地输入。'); return; } setBusy(true); try { const d = await request('get', { reportId: id }); if (alive.current) { adopt(d); setPreview(null); setPanel(null); setStage('editor'); setViewMode('editor'); } } catch(e) { fail(e); } finally { if (alive.current) setBusy(false); } }
  async function save() {
    // `aiBusy` is defence in depth: the editor already holds serialization while an AI edit is
    // in flight (ai-hold.mjs), so a half-written document should never reach `text` in the
    // first place. It is not sufficient on its own — chat status flips to 'ready' while the
    // executor is still applying operations — which is why the editor-side hold is the real fix.
    const c = current.current; if (!c.draft || !c.dirty || saving.current || c.aiBusy || isDraftReadOnly(c.draft, c.busy)) return;
    saving.current = true; const seq = revision.current; setStatus('保存中');
    try {
      let saved;
      try { saved = asDraft(await request('save', { reportId: c.draft.reportId, saveToken: c.draft.saveToken, markdown: c.text })); }
      catch (e) {
        // 单用户 pilot：本地正文即权威。令牌过期（草稿在别处/后台被刷新过）时，取最新令牌用本地正文直接覆盖一次，
        // 不打断用户，也不丢失本地输入；服务端的令牌校验仍保留，仅客户端在自己的保存里自动跟进。
        if (!isConflict(e) || current.current.draft?.reportId !== c.draft.reportId) throw e;
        const latest = asDraft(await request('get', { reportId: c.draft.reportId }));
        if (current.current.draft?.reportId !== c.draft.reportId) return;
        setStatus('保存中（覆盖远端较旧令牌）');
        saved = asDraft(await request('save', { reportId: c.draft.reportId, saveToken: latest.saveToken, markdown: c.text }));
      }
      if (!alive.current || current.current.draft?.reportId !== c.draft.reportId) return;
      if (!saved?.saveToken) throw new Error('保存回执缺少 saveToken');
      const next = { ...c.draft, ...saved, markdown: saved.markdown ?? c.text };
      current.current.draft = next; setDraft(next);
      if (revision.current === seq) { current.current.dirty = false; setDirty(false); setStatus('已保存'); setError(''); } else setStatus('有未保存修改');
    } catch(e) { fail(e); } finally { saving.current = false; }
  }
  useEffect(() => { alive.current = true; request('list').then(v => { if (alive.current) { setReports(rows(v, 'reports')); setStatus(demo ? '本地演示已就绪' : '请选择或生成周报'); } }).catch(fail); request('identity').then(v => alive.current && setIdentity(v)).catch(fail); request('templateList').then(v => alive.current && setTemplates(v?.templates || [])).catch(() => {}); return () => { alive.current = false; previewSerial.current++; }; }, [sessionId]);
  // `aiBusy` is a dependency so a save skipped mid-AI is retried once the run ends, rather than
  // waiting for the next keystroke.
  useEffect(() => { if (!dirty || error) return; const timer = setTimeout(save, 650); return () => clearTimeout(timer); }, [text, dirty, draft?.saveToken, busy, error, aiBusy]);
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
      const reportId = c.draft.reportId; let saveToken = c.draft.saveToken;
      // 1) 冻结当前草稿为不可变确认版；令牌过期时取最新令牌直接覆盖确认一次（单用户 pilot，见 save()）。
      let confirmed;
      try { confirmed = asDraft(await request('confirm', { reportId, saveToken })); }
      catch (e) {
        if (!isConflict(e)) throw e;
        const latest = asDraft(await request('get', { reportId })); saveToken = latest.saveToken;
        confirmed = asDraft(await request('confirm', { reportId, saveToken })); }
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
  const changeText = value => { if (isDraftReadOnly(current.current.draft, current.current.busy)) return; revision.current++; current.current.dirty = true; current.current.text = value; setText(value); setDirty(true); setStatus('有未保存修改'); };
  const editorRef = useRef(null), markdownScrollRef = useRef(null);
  usePreviewScroll(editorRef, markdownScrollRef, viewMode === 'markdown' && stage === 'editor', text, readOnly);
  const warnings = safeWarnings(reportWarnings.map(w => w.code), draft?.warnings, preview?.warnings);
  const verified = identity?.confirmed === true && !!identity?.displayName;
  const versions = panel?.type === 'versions' ? rows(panel.value, 'versions') : [];
  const renderPanel = () => {
    if (!panel) return null;
    switch (panel.type) {
      case 'humanItems': return <HumanItemsPanel key={`${draft?.reportId}:${panel.value?.saveToken}`} value={panel.value} readOnly={readOnly || dirty} onSave={(items,saveToken)=>action('saveHumanItems',{items,saveToken})}/>;
      case 'diff': return <><div className="rr-diff-helper"><p>左：本轮基线；右：当前稿。无法确定基线时仅展示审计记录，不伪造差异。</p><span className="rr-diff-legend"><span className="rr-diff-insert">＋ 新增内容</span><span className="rr-diff-delete">－ 删除内容</span></span></div>{typeof (panel.value?.baselineMarkdown ?? draft?.baselineMarkdown) === 'string' ? <Diff before={panel.value?.baselineMarkdown ?? draft.baselineMarkdown} after={text} /> : <p>Host 尚未提供 baselineMarkdown。</p>}<FieldCard title="差异信息" obj={panel.value} order={['reportId','versionId','baseVersionId','changed','add','del']} /><RawJSON value={panel.value} /></>;
      case 'versions': return <>{versions.map(v => <div key={v.versionId} className="rr-record"><div className="rr-row"><strong>{v.versionId} {v.title}</strong>{v.author?.displayName ? <span className="rr-muted">· {v.author.displayName}</span> : ''}{v.completedAt ? <span className="rr-muted">· {String(v.completedAt).slice(0,10)}</span> : ''}</div><button className="rr-button" disabled={busy || dirty} onClick={() => action('publishPlan', {versionId:v.versionId})}>查看此版本发布清单</button>{typeof v.markdown === 'string' && <details open={versions.length <= 1}><summary>阅读版本正文</summary><MarkdownPreview text={v.markdown} /></details>}</div>)}</>;
      case 'timeline': return <><button className="rr-button" disabled={busy} onClick={() => showPublication('publicationStatus')}>发布记录</button><Timeline value={panel.value} /></>;
      case 'publishPlan': return <><div className="rr-publish-plan"><div className="rr-row rr-muted"><span>计划 {recordText(panel.value?.planId)}</span><span>版本 {recordText(panel.value?.versionId)}</span></div><p>仅以下按钮会发出 publish 请求。请核对正文、图片、公开信息及知识库身份。</p><FieldCard title="发布清单" obj={panel.value} order={['planId','versionId','digest','items','assets','knowledgeBaseId','knowledge_base_id','placement']} /><RawJSON value={panel.value} /><button className="rr-button rr-button--primary" disabled={busy || dirty || !verified} onClick={event => { if (!event.nativeEvent.isTrusted) { setError('发布必须由人类实际点击'); return; } action('publish', { versionId:panel.value?.versionId, planId:panel.value?.planId, digest:panel.value?.digest, publishToken:panel.value?.publishToken, userInitiated:true }); }}>{demo ? '模拟发布此确认版' : '发布此确认版至 WeKnora'}</button></div></>;
      case 'publish': return <><p>{publicationStateText(panel.value)}</p><p>已提交并不等于完成。请用只读核对查看状态；此按钮不会再次调用发布。</p><FieldCard title="回执" obj={panel.value} order={['planId','versionId','status','phase','remoteId','remote_id','parseStatus','parse_status']} /><RawJSON value={panel.value} /><div className="rr-row"><button className="rr-button" disabled={busy} onClick={() => showPublication('reconcile')}>只读核对</button><button className="rr-button" disabled={busy} onClick={() => showPublication('publicationStatus')}>查看发布记录</button></div></>;
      case 'publicationStatus': return <PublicationRecords value={panel.value} busy={busy} onRead={showPublication} />;
      default: return null;
    }
  };
  const visibleReports = reports.filter(r => (r.title || r.reportId).toLowerCase().includes(search.trim().toLowerCase()));
  const requestClose = () => { if (busy || saving.current) return; if (dirty) setConfirmClose(true); else close(); };
  return <dialog ref={dialogRef} aria-label="周报审阅工作台" className="rr-workspace" data-focus={focused && stage === 'editor'} data-stage={stage} data-mode={mode} onCancel={event => { event.preventDefault(); }}>
    <style>{workspaceCss}</style>
    <header className="rr-header">
      <strong className="rr-app-title">周报工作台</strong>
      <div className="rr-steps" role="group" aria-label="工作流程"><button className="rr-button" aria-pressed={stage === 'generation'} onClick={() => { setStage('generation'); setFocused(false); }}>1 生成与分析</button><button className="rr-button" disabled={!draft} aria-pressed={stage === 'editor'} onClick={() => setStage('editor')}>2 可视化编辑</button></div>
      <button className="rr-button" disabled={busy || demo} title={demo ? '演示模式不含连接设置' : 'WeKnora 连接与密钥'} aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>⚙ 设置</button>
      <button className="rr-button rr-mode-switch" disabled={busy || dirty} onClick={() => { if (!saving.current) onModeChange(demo ? 'real' : 'demo'); }}>{demo ? '切换真实模式' : '体验演示数据'}</button>
      <button className="rr-button" hidden={stage !== 'editor'} aria-pressed={focused} onClick={() => setFocused(v => !v)}>{focused ? '退出专注' : '专注正文'}</button>
      <button className="rr-button" disabled={busy} onClick={requestClose}>关闭</button>
    </header>
    {demo && <div className="rr-demo-banner" role="note">本地演示 · 数据与分析均为模拟样例，保存在此浏览器；不连接数据库，不调用 AI，不上传知识库。<button className="rr-button" disabled={busy || dirty} title={dirty ? '请先保存当前稿' : '新建完整样例，不覆盖已有演示稿'} onClick={generate}>新建完整演示周报</button></div>}
    <div className="rr-layout">
      <nav className="rr-sidebar" aria-label="周报档案">
        <div className="rr-section-heading"><h2>研究档案</h2><span className="rr-badge">{reports.length}</span></div>
        <button className="rr-button rr-button--primary" disabled={busy || dirty} onClick={() => { setStage('generation'); setFocused(false); }}>＋ 新建周报</button>
        <input aria-label="搜索报告" placeholder="搜索报告…" type="search" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="rr-report-list">{visibleReports.map(r => <button className="rr-report-item" key={r.reportId} aria-current={draft?.reportId === r.reportId ? 'page' : undefined} disabled={busy || dirty || aiBusy} onClick={() => load(r.reportId)}><span className="rr-item-top"><span className={`rr-status-dot ${r.status === 'confirmed' ? 'is-confirmed' : ''}`} aria-hidden="true"/><strong className="rr-report-title">{r.title || r.reportId}</strong></span><span className="rr-report-sub">{r.status === 'confirmed' ? '已确认 · 只读' : '研究草稿'}</span></button>)}
          {!visibleReports.length && <p className="rr-empty">{search ? '没有匹配的报告' : '暂无报告，新建一份开始研究。'}</p>}</div>
        <p className="rr-sidebar-note">从本周数据出发，留下判断与依据。<br/>保存后可切换报告。</p>
      </nav>
      <main className="rr-main" data-review={panel ? panel.type : undefined}>

        <section className="rr-generation-stage" aria-label="生成与分析" hidden={stage !== 'generation'}><header><h1>生成周报</h1><p className="rr-muted">先确定品种、截止日期和分析要求。生成后进入可视化编辑，已有报告不会被覆盖。</p></header>
    <form onSubmit={generate} className="rr-generation-form" aria-label="生成周报参数">
      <div className="rr-generation-basics"><label>商品 <select aria-label="商品" value={variety} disabled={busy} onChange={e => setVariety(e.target.value)} className="rr-commodity-input" required>{(commodityProfiles?.list?.length ? commodityProfiles.list : ['锡']).map(c => <option key={c} value={c}>{c}</option>)}</select>{commodityProfiles?.folders?.[variety] && <span className="rr-muted">将上传至「{commodityProfiles.folders[variety]}」</span>}</label>
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
        <div className="rr-toolbar" role="group" aria-label="文档视图"><button className="rr-button" aria-pressed={viewMode === 'editor'} onClick={() => setViewMode('editor')}>可视化编辑</button><button className="rr-button rr-ai-enter" disabled={viewMode !== 'editor' || readOnly || !draft || aiBusy} title="直接进入 AI 模式改稿（同 //）" onClick={() => editorApiRef.current?.enterAIMode()}><svg className="rr-btn-ico" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 6.1L21 10l-6.6 1.9L12 18l-2.4-6.1L3 10l6.6-1.9z"/><path d="M19 15l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z"/></svg>进入 AI</button><button className="rr-button rr-voice-enter" disabled={viewMode !== 'editor' || readOnly || !draft || aiBusy} title="进入 AI 模式并开始语音输入（同右 Alt）" onClick={() => editorApiRef.current?.enterVoiceMode()}><svg className="rr-btn-ico" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm6-3a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-2.06A8 8 0 0 0 20 12h-2z"/></svg>语音</button><button className="rr-button" disabled={!draft} aria-pressed={viewMode === 'markdown'} onClick={() => { setViewMode('markdown'); setFocused(true); }}>Markdown 实时浏览</button><button className="rr-button" disabled={!draft} aria-pressed={viewMode === 'pdf'} onClick={() => { setViewMode('pdf'); setFocused(true); }}>PDF 实时浏览</button><button className="rr-button" disabled={!synced || busy} title={synced ? '导出当前已保存版本' : '等待当前内容保存并完成 PDF 生成后可导出'} onClick={() => { if (!synced) return; const link = document.createElement('a'); link.href = pdf.url; link.download = demo ? 'demo-weekly-report.pdf' : (draft.title || 'weekly-report').replace(/[<>:"/\\|?*]/g, '_') + '.pdf'; link.click(); }}>导出 PDF</button><button className="rr-button rr-button--primary rr-push" disabled={!dirty || readOnly} onClick={() => { setError(''); save(); }}>保存 / 重试</button></div>
        <p className="rr-engine-note">切换模式保留正文内容；可视化与源码之间切换时，撤销历史重新开始。</p>{panel && <section className="rr-review-view" aria-label="审阅详情"><div className="rr-review-view-head"><button className="rr-button" onClick={() => setPanel(null)}>← 返回正文</button><div className="rr-review-view-head2"><h2>{reviewTitle(panel.type)}</h2><span className="rr-muted">{reviewSub(panel.type, panel.value)}</span></div></div><div className="rr-review-view-body">{renderPanel()}</div></section>}<div className="rr-document-panes" data-view={viewMode}><div className="rr-source-pane"><div className="rr-pane-heading"><strong>{sourceMode ? 'Markdown 源码' : '可视化编辑'}</strong><span>{dirty ? '未保存' : '自动保存'}</span></div><section className="rr-canvas" aria-label="报告正文">{draft ? (sourceMode ? <Editor key={draft.reportId} editorRef={editorRef} value={text} readOnly={readOnly} onChange={changeText} /> : <BlockEditor key={draft.reportId} value={text} readOnly={readOnly} sessionId={sessionId} reportId={draft.reportId} onAiBusy={setAiBusy} editorApi={editorApiRef} onSource={() => { setViewMode('markdown'); setFocused(true); }} onChange={changeText} />) : <div className="rr-welcome"><span className="rr-eyebrow">本周的判断，从这里开始</span><h2>把数据整理成有依据的观点</h2><p>从左侧打开已有报告，或新建周报后使用上方设置生成初稿。</p><p className="rr-muted">生成初稿 → 人工审阅 → 确认版本 → 发布与核对</p></div>}</section>
        </div><section className="rr-markdown-preview" aria-label="Markdown 实时预览" hidden={viewMode !== 'markdown'}><div className="rr-pane-heading"><strong>阅读预览</strong><span>随输入实时更新</span></div>{viewMode === 'markdown' && <MarkdownPreview text={text} scrollRef={markdownScrollRef} />}</section>
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
      </aside>
    </div>
    <footer className="rr-status" role="status">{demo ? '演示模式 · ' : ''}{status} · {dirty ? '未保存，PDF 为旧预览' : synced && pdf ? 'PDF 已同步' : preview?.status === 'failed' ? 'PDF 生成失败' : 'PDF 等待生成 / 旧预览'}{aiModel?.model ? ` · AI ${aiModel.provider || ''}${aiModel.provider ? '/' : ''}${aiModel.model}` : ''}</footer>
    {error && <div className="rr-error" role="alert"><span className="rr-error-msg">{error}</span><button className="rr-error-close" aria-label="关闭错误提示" onClick={() => setError('')}>✕</button></div>}
    {confirmClose && <section className="rr-close-confirm" role="alert"><p>有未保存修改，放弃后将丢失这些内容。</p><button className="rr-button rr-button--danger" onClick={close}>放弃并关闭</button> <button className="rr-button" onClick={() => setConfirmClose(false)}>返回编辑</button></section>}
    {settingsOpen && !demo && <SettingsPanel request={request} onIdentity={v => alive.current && setIdentity(v)} onClose={() => { setSettingsOpen(false); request('identity').then(v => alive.current && setIdentity(v)).catch(() => {}); }} />}
    <GenerateProgress progress={progress} onCancel={cancelGen} onRetry={generate} onRegenerate={generate} onClose={() => setProgress(null)} />
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
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name:'sidebar.footer.action', id:'report-review', label:'周报工作台', order:15, inject: () => ({ ...triggerProps(), footer:true }) }, RegisteredTrigger));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name:'shell.overlay', id:'report-review', order:30, inject: () => ({ controller }) }, WorkspaceOverlay));
}
