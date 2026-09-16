// Explicit opt-in browser sandbox. No fetch, Host API, identity or publication credentials.
import { computeTimeline } from './timeline.mjs';

export const DEMO_STORAGE_KEY = 'run19-weekly-demo-v1';
const copy = value => structuredClone(value);
const id = prefix => `${prefix}_${Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('')}`;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const author = { userId: 'demo-user', displayName: '演示研究员' };

export function sampleReport({ variety = '锡', end = '2026-09-08', analysisPrompt = '' } = {}) {
  return `# ${variety}周报 · ${end}\n\n> 演示数据：所有行情数值与分析均为固定样例，不代表真实市场，不调用模型或数据库。\n\n## 一、核心判断\n本周价格回升，库存小幅下降，但仅凭去库尚不能确认需求持续改善。需要结合下游订单与供应变化核对。\n\n## 二、市场快照（模拟）\n| 指标 | 本期 | 上期 | 变化 |\n| --- | --- | --- | --- |\n| 参考价格（元/吨） | 268,500 | 263,200 | +2.01% |\n| 显性库存（吨） | 8,420 | 8,760 | -3.88% |\n| 开工率 | 67.2% | 66.5% | +0.7 个百分点 |\n\n来源：本插件内置模拟样例；展示日期 ${end}，非实际观测日。\n\n## 三、供需结构\n- 供应：样例冶炼厂开工率温和回升，关注检修后复产节奏。\n- 需求：样例下游企业按需采购，订单改善尚待验证。\n- 库存：样例库存连续两期回落，可能包含物流和交割因素。\n\n## 四、本周多空逻辑\n**支撑因素：** 库存下降与短期补库。\n**压力因素：** 供应恢复和终端订单不确定。\n\n## 五、跨周跟踪\n| 周期 | 判断 | 本期验证 |\n| --- | --- | --- |\n| 前两周（模拟） | 供需偏弱，等待去库 | 部分观察到去库 |\n| 上周（模拟） | 关注补库能否持续 | 订单仍需核实 |\n| 本周（模拟） | 维持审慎观察 | 跟踪开工率和库存 |\n\n## 六、下周关注\n1. 核对库存口径与统计范围。\n2. 补充下游订单证据，再判断需求改善。\n3. 若库存回升且订单走弱，重新评估补库判断。\n\n## 七、风险提示\n- 样例数据不用于投资决策。\n- 模拟分析不构成预测或建议。\n${analysisPrompt.trim() ? '\n## 本次分析要求\n'+analysisPrompt.trim()+'\n\n以上要求已记录；演示模式提供固定分析样例，没有实际 AI 推理。\n' : ''}`;
}

function makeDraft(input) {
  const markdown = input.markdown ?? sampleReport(input);
  return { reportId: id('demo'), title: input.title || `${input.variety || '锡'}周报 · ${input.end || '2026-09-08'}（演示）`, markdown, baselineMarkdown: markdown, saveToken: id('save'), status: 'draft', annotations: [], versions: [], records: [], humanItems: [], retrieval: { scope: { kind: 'demo', weeksBack: 2, queries: ['内置样例'] }, used: [{ title: '上周周报（模拟材料）' }, { title: '前两周周报（模拟材料）' }] } };
}

export function createDemoApi(storage, key = DEMO_STORAGE_KEY) {
  function read() {
    const saved = storage.getItem(key);
    if (saved) {
      try { const value = JSON.parse(saved); if (value.schema === 1 && Array.isArray(value.reports) && Array.isArray(value.templates)) return value; } catch {}
      fail('DEMO_DATA_INVALID', '演示存档无法读取；请保留存档后检查，未覆盖原数据。');
    }
    const initial = { schema: 1, reports: [makeDraft({ variety: '锡', end: '2026-09-08' })], templates: [] };
    storage.setItem(key, JSON.stringify(initial)); return initial;
  }
  return async (action, input = {}) => {
    const state = read();
    const persist = value => { storage.setItem(key, JSON.stringify(state)); return copy(value); };
    if (action === 'list') return { reports: copy(state.reports) };
    if (action === 'identity') return { confirmed: true, displayName: author.displayName, demo: true };
    if (action === 'templateList') return { templates: copy(state.templates) };
    if (action === 'templateSave') {
      const template = { id: input.id || id('template'), name: input.name, content: input.content };
      state.templates = [...state.templates.filter(t => t.id !== template.id), template]; return persist({ template });
    }
    if (action === 'templateDelete') { state.templates = state.templates.filter(t => t.id !== input.id); return persist({ deleted: true }); }
    if (action === 'create' || action === 'generate') { const draft = makeDraft(input); state.reports.push(draft); return persist(draft); }
    const draft = state.reports.find(d => d.reportId === input.reportId);
    if (!draft) fail('NOT_FOUND', '演示报告不存在。');
    const current = () => { if (input.saveToken !== draft.saveToken) fail('SAVE_CONFLICT', '演示稿已在其他窗口修改；本地输入已保留。'); };
    const editable = () => { current(); if (draft.status !== 'draft') fail('READ_ONLY', '确认稿只读，请开启新修订。'); };
    if (action === 'get') return copy(draft);
    if (action === 'save') {
      editable(); draft.markdown = input.markdown; draft.saveToken = id('save');
      draft.annotations = [{ annotationId: 'demo-edit', content: '本轮人工修订', source: 'user_direct' }];
      draft.humanItems = [{ annotationId: 'demo-edit', content: input.markdown, category: 'judgment', selected: false, visibility: 'local', mappingConfidence: 'high' }];
      return persist(draft);
    }
    if (action === 'preview') { current(); return { status: 'ready', saveToken: draft.saveToken, digest: draft.saveToken, pdfUrl: 'demo-pdf', demo: true }; }
    if (action === 'demoPdf') { current(); const { renderDemoPdf } = await import('./demo-pdf.mjs'); return renderDemoPdf(draft); }
    if (action === 'confirm') {
      editable(); const version = { versionId: `v${draft.versions.length + 1}`, baseVersionId: draft.versions.at(-1)?.versionId || null, title: draft.title, markdown: draft.markdown, author, annotations: copy(draft.annotations), humanItems: copy(draft.humanItems), completedAt: new Date().toISOString() };
      draft.versions.push(version); draft.status = 'confirmed'; draft.saveToken = id('save'); return persist(version);
    }
    if (action === 'versions') return { versions: copy(draft.versions) };
    if (action === 'timeline') {
      const baseline = { versionId: 'v0', markdown: draft.baselineMarkdown, author };
      const versions = [baseline, ...draft.versions];
      return { ...computeTimeline(versions), markdowns: Object.fromEntries(versions.map(v => [v.versionId, v.markdown])) };
    }
    if (action === 'startRevision') { current(); if (draft.status !== 'confirmed') fail('INVALID_STATE', '请先确认版本。'); draft.status = 'draft'; draft.saveToken = id('save'); return persist(draft); }
    if (action === 'humanItems') return { items: copy(draft.humanItems), saveToken: draft.saveToken, status: draft.status };
    if (action === 'saveHumanItems') {
      editable(); draft.humanItems = draft.humanItems.map(item => ({ ...item, ...input.items.find(i => i.annotationId === item.annotationId) })); draft.saveToken = id('save');
      return persist({ items: draft.humanItems, saveToken: draft.saveToken, status: draft.status });
    }
    if (action === 'publishPlan') {
      if (draft.status !== 'confirmed' || !draft.versions.some(v => v.versionId === input.versionId)) fail('INVALID_STATE', '需要有效的演示确认版。');
      draft.plan = { versionId: input.versionId, planId: id('plan'), digest: id('digest'), publishToken: id('demo-token'), target: '本地模拟知识库（不上传）' }; return persist(draft.plan);
    }
    if (action === 'publish') {
      const plan = draft.plan;
      if (!input.userInitiated || !plan || !['versionId', 'planId', 'digest', 'publishToken'].every(k => input[k] === plan[k])) fail('INVALID_PLAN', '模拟发布计划已失效。');
      draft.plan = null;
      const record = { versionId: input.versionId, planId: input.planId, phase: 'submitted', parseStatus: 'pending', demo: true };
      draft.records.push(record); return persist(record);
    }
    if (action === 'publicationStatus') return { records: copy(draft.records), demo: true };
    if (action === 'reconcile') { draft.records = draft.records.map(r => ({ ...r, parseStatus: 'completed', parseReady: true, checkedAt: new Date().toISOString() })); return persist({ records: draft.records, demo: true }); }
    fail('DEMO_UNSUPPORTED', '演示模式不支持此操作。');
  };
}
