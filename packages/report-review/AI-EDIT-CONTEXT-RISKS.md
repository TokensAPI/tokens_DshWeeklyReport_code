# AI 对话编辑：上下文与「改错报告」风险清单

> 本文档面向交互/实现，记录「直接对话修改报告」这条链路（Route A）在**上下文归属**与**改哪个报告**两方面的已知风险、当前防护，以及已落地的加固措施。用于指导后续交互设计与迭代。

## 0. 术语与架构速览

- **报告（report）**：report-core 里的一份文档，用 `sessionId` 归属到某个 DSH 会话；**每次编辑**（生成/保存）都要求 `sessionId` 匹配，否则 `NOT_FOUND`。
- **会话（session）**：DSH 对话/工作区，是报告的“容器”。一个会话可挂多份报告。
- **编辑工具 `applyDocumentOperations`**：把 LLM 产出的操作（add/update/delete…）以建议标记（insertion/deletion）落到**当前编辑器文档**，从而支持 内容 diff → 应用/还原。
- **聊天上下文 `state.convo`**：`createNativeChat` 里累积的 user/assistant 文本，用于给模型跨轮背景。
- **关键事实**：客户端用 `key={draft.reportId}` 渲染 `BlockEditor`，所以**切报告会整体重挂编辑器**，`chatRef`/`state.convo` 随之按报告重建。

## 1. 担心的点（为什么会有风险）

| # | 担忧 | 具体表现 |
|---|------|----------|
| R1 | 上下文无限迭代 | `state.convo` 只增不减，长对话下 prompt 越来越大，可能超上下文窗口，且当前报告的聚焦被旧内容稀释。 |
| R2 | 跨报告串台 | 同一段对话若跨多份报告，模型可能引用上一份报告的内容，导致语义串台（尽管物理上各报告已按重挂隔离）。 |
| R3 | 工具改错报告 | 若 AI 请求在飞时用户切到另一份报告，注入的是旧报告快照、但工具作用在“此刻 live 文档”上，可能落错。 |
| R4 | 会话级上下文缺失 | 当前上下文只在单次编辑器挂载生命周期内有效；离开再回来（同一会话）不保留此前对话。 |

## 2. 当前架构本身已安全的部分

- **改哪个文档（工具层）**：`applyDocumentOperations` 永远作用在**当前打开的编辑器文档**上；每轮 `injectDocumentStateMessages` 都会把**当前报告正文快照 + “忽略先前文档、必须针对最新版本文档操作”**注入模型输入（`ai-bridge.mjs` L315-338）。所以只要此刻打开的是报告 B，操作就落在 B 上——工具层不会改错文件。
- **跨报告上下文天然隔离**：因为 `key={draft.reportId}` 会重挂 `BlockEditor`，每个报告有自己独立的 `chatRef`/`state.convo`，切报告后上下文清零（R2 的“物理”层面已被弱化）。
- **只读/确认稿保护**：`editorApi.invokeConvo` 对 `readOnly` 直接抛错，不发起 AI 修改。

## 3. 已落地的加固（本次改动）

### 3.1 每条消息打上 `reportId` 并按报告过滤上下文
- `createNativeChat` 接收 `opts.reportId`（每个报告一个 chat）。
- `state.convo` 的每条 user/assistant 记录都带 `reportId`。
- 构造请求时，历史只取 `reportId === 当前` 的轮次（`ai-bridge.mjs` `sendMessage`）。

### 3.2 每一轮锚定当前报告
- `sendMessage` 在 system 里写明：`当前报告 ID：<reportId>，你正在编辑这份报告`。
- 配合每轮注入的正文快照，让模型明确自己在改哪一篇。

### 3.3 给工具加 `reportId` 并在执行前校验
- `createStreamToolsArraySchema` 在工具 schema 顶层新增可选的 `reportId` 字段（`editor-ai/streamTool/jsonSchema.ts`）。
- `createNativeChat.sendMessage` 收到 `applyDocumentOperations` 调用时：
  - 若模型盖的 `reportId` **存在且 ≠ 当前报告** → 直接 `setError` 拒绝，不应用，保护当前报告。
  - 若未盖（模型不可靠/旧路径）→ 兼容放行（chat 本身已按报告区分）。
  - 转发给执行管线前**剥离 `reportId`**，只传 `{ operations }`，避免破坏下游 `objectStreamToOperationsResult`。

### 3.4 AI 修改期间禁止切换报告
- 新增 `aiBusy` 状态：`BlockEditor` 的 `invokeConvo` 在执行前后调用 `onAiBusy(true/false)`。
- 报告列表按钮 `disabled={busy || dirty || aiBusy}`；`load()` 在 `aiBusy` 时直接提示“AI 修改进行中，暂时不能切换报告”，防止 R3 的竞态。

## 4. 尚未解决 / 后续考虑

- **R1 上下文无限增长**：暂未做窗口上限或滚动摘要。建议后续给 `state.convo` 设置上限（如最近 6–10 轮）或用摘要压缩，避免超窗口和聚焦漂移。
- **R4 会话级上下文**：当前上下文不跨“离开再回来”。若需要“同一会话、多次打开同一报告仍记得上一轮”，可接入 `sessions.get(id).deriveMessages()` 或按 `(sessionId, reportId)` 持久化 convo。**这属于未来增强**，不影响当前防错。
- **模型不保证盖 reportId**：工具校验是“兜底 + 明确锚定”，不是强依赖。若要求更严格，可在 `processToolCallPart`/执行器中强制 `reportId` 必须存在且匹配，代价是模型偶发不盖会失败。
- **视图切换竞态**：AI 修改中切到源码视图会卸载编辑器、使在途请求的 apply/revert 失效。如需彻底，也应在 `aiBusy` 时禁用视图/引擎切换。

## 5. 验证建议

- `npm run build` 重新构建 `lib/client.js`。
- `node --test` 运行 `test/ai-bridge.node.mjs`、`block-editor.test.mjs`、`workspace.test.mjs`、`client.test.mjs`，确认现有断言（`input.operations` 保留、单 tool part、reportId 缺省放行）仍通过。
- 手工：
  1. 同一会话开两份报告，各自 AI 改一轮，确认各自的对话上下文互不影响、都只改当前报告。
  2. AI 修改进行中尝试切换报告，确认被禁用（弹提示）。
  3. （可选）直接在 DevTools 里把模型盖成错误 `reportId`，确认被拒绝。
