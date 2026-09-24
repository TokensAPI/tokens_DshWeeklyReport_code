import React, { useMemo, useRef, useEffect, useState } from 'react';
import { autoUpdate } from '@floating-ui/react';
import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs, defaultStyleSpecs } from '@blocknote/core';
import { zh } from '@blocknote/core/locales';
import { createReactBlockSpec, FormattingToolbar, FormattingToolbarController, BasicTextStyleButton, CreateLinkButton, SideMenuController, SideMenu, DragHandleMenu, RemoveBlockItem, SuggestionMenuController, getDefaultReactSlashMenuItems } from '@blocknote/react';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { BlockNoteView } from '@blocknote/mantine';
import { AIExtension, AIToolbarButton, AIMenuController, getAISlashMenuItems, voiceBus, markVoiceAutoStart, VOICE_TOGGLE_EVENT } from './editor-ai/index.js';
import { zh as aiZh } from './editor-ai/locales.js';
import aiCss from './editor-ai/style.css';
import { ReportImage } from './report-image.jsx';
import { createNativeChat } from './ai-bridge.mjs';
import { htmlBlockLLMFormat } from './editor-ai/api/formats/html-blocks/htmlBlocks.js';
import editorCss from './block-editor-styles.mjs';
import { MarkdownPreview } from './preview.jsx';
import { loadBlockMarkdown, saveBlockMarkdown, fingerprint } from './block-markdown.mjs';
import { createHoldGate } from './ai-hold.mjs';
import { describeAiError } from './ai-error.mjs';

const sourceBlock = createReactBlockSpec({ type: 'source', propSchema: { raw: { default: '' } }, content: 'none' }, {
  render: ({ block }) => <div className="rr-preserved-block" contentEditable={false}><span className="rr-muted">此片段暂未开放可视化编辑 · 可切换 CodeMirror 修改</span><MarkdownPreview text={block.props.raw} /></div>
})();
const imageBlock = createReactBlockSpec({ type: 'image', propSchema: { url: {default:''}, caption: {default:''}, title: {default:''} }, content: 'none' }, {
  render: ({block, editor}) => <ReportImage url={block.props.url} caption={block.props.caption} readOnly={!editor.isEditable} onChange={props => editor.updateBlock(block, {props})} />,
})();
export const schema = BlockNoteSchema.create({
  blockSpecs: Object.fromEntries(['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'quote', 'codeBlock', 'divider', 'table'].map(key => [key, defaultBlockSpecs[key]]).concat([['source', sourceBlock], ['image', imageBlock]])),
  styleSpecs: Object.fromEntries(['bold', 'italic', 'strike', 'code'].map(key => [key, defaultStyleSpecs[key]]))
});

// Route the BlockNote AI (xl-ai) LLM calls through the DSH host llm.stream, same
// transport as hostFetch so credentials/origin stay consistent.
function aiFetch(path, init) {
  const base = globalThis.location?.origin && globalThis.location.origin !== 'null' ? globalThis.location.origin : 'http://dsh.internal';
  const send = globalThis.__DSH_TRANSPORT__?.fetch || globalThis.fetch;
  return send(base + path, init);
}

// Slash menu = AI items first (so "询问人工智能" is reachable at the top), then the
// BlockNote default items.
function getSlashMenuItemsWithAI(editor) {
  return [...getAISlashMenuItems(editor), ...getDefaultReactSlashMenuItems(editor)];
}

// Custom suggestion menu for the '//' shortcut: instead of showing a one-item chooser, it
// immediately invokes the single AI item once it loads. BlockNote wraps onItemClick so it
// closes the menu, clears the '//' trigger text, then opens the AI prompt.
function DirectAISuggestionMenu({ items, onItemClick }) {
  const invoked = useRef(false);
  useEffect(() => {
    if (!invoked.current && items && items.length > 0) {
      invoked.current = true;
      onItemClick(items[0]);
    }
  }, [items, onItemClick]);
  return null;
}

// Stable component types preserve open popovers across parent save/status renders.
function ReportFormattingToolbar() {
  return <FormattingToolbar><BasicTextStyleButton basicTextStyle="bold" /><BasicTextStyleButton basicTextStyle="italic" /><BasicTextStyleButton basicTextStyle="strike" /><BasicTextStyleButton basicTextStyle="code" /><CreateLinkButton /><AIToolbarButton /></FormattingToolbar>;
}
function ReportDragMenu() { return <DragHandleMenu><RemoveBlockItem>删除区块</RemoveBlockItem></DragHandleMenu>; }
function ReportSideMenu(props) { return <SideMenu {...props} dragHandleMenu={ReportDragMenu} />; }
// Keep the toolbars / side menus tracking the caret every animation frame.
const floatingOptions = { useFloatingOptions: { strategy: 'fixed', transform: false, whileElementsMounted: (reference, floating, update) => autoUpdate(reference, floating, update, { animationFrame: true }) } };
// The '/' and '//' suggestion menus paint at their default (top-left) position for one frame
// before floating-ui applies the caret position, flashing at the dialog's left edge on the
// first open. Hold it invisible until the first position update lands, then reveal.
const suggestionMenuFloatingOptions = {
  useFloatingOptions: {
    strategy: 'fixed',
    transform: false,
    whileElementsMounted(reference, floating, update) {
      floating.style.opacity = '0';
      let done = false;
      const reveal = () => { if (!done) { done = true; floating.style.opacity = '1'; } };
      const cleanup = autoUpdate(reference, floating, update, { animationFrame: true });
      const p = update();
      if (p && typeof p.then === 'function') { p.then(reveal).catch(() => {}); }
      // Safety: never leave the menu hidden if the position update stalls.
      const timer = setTimeout(reveal, 150);
      return () => { clearTimeout(timer); cleanup(); };
    },
  },
  elementProps: { style: { zIndex: 70, opacity: 0 } },
};

export function BlockEditor({ value, onChange, readOnly, onSource, sessionId, reportId, onAiBusy, editorApi }) {
  const root = useRef(null);
  const [portal, setPortal] = useState(null);
  useEffect(() => { setPortal(root.current?.closest('dialog') || root.current); }, []);
  // One persistent native-chat per editor mount, reused across every AI invocation so a
  // conversation (selection edit or chat edit) keeps its context and is bound to the DSH
  // session. `chatProvider` returns this same object, so xl-ai's chatSession resets never
  // discard the accumulated messages. The chat is created per report (the parent mounts this
  // component with key={reportId}), so `reportId` scopes the conversation + tool guard.
  const chatRef = useRef(null);
  // The format's own system prompt has to be passed in explicitly. Upstream xl-ai sends it as
  // part of its LLM request; this fork drives DSH directly through createNativeChat, and the
  // rewrite dropped it — nothing else in the tree reads `htmlBlockLLMFormat.systemPrompt`.
  // Without it the model is never told that block ids carry a trailing `$`, so it "cleans up"
  // the id it was given and every operation is rejected with "id must end with $", i.e. the
  // edit silently does nothing. The prompt also carries the list-item and code-block rules.
  if (!chatRef.current) chatRef.current = createNativeChat({ fetchFn: aiFetch, sessionId, reportId, system: htmlBlockLLMFormat.systemPrompt });
  const portalElements = useMemo(() => ({ default: portal }), [portal]);
  const callbacks = useRef({ onChange, readOnly, onAiBusy });
  callbacks.current = { onChange, readOnly, onAiBusy };
  const last = useRef(value);
  const [failed, setFailed] = useState(false);
  // Serialization is held while the AI edit is mid-flight; see ai-hold.mjs for why. `flushRef`
  // is filled in below once `session` exists, so the gate can be created before it.
  const flushRef = useRef(() => {});
  const gateRef = useRef(null);
  if (!gateRef.current) gateRef.current = createHoldGate(final => flushRef.current(final));
  // Show the outcome of the last AI request on screen (readable without DevTools).
  const [aiDiag, setAiDiag] = useState(null);
  const diagTimer = useRef(null);
  useEffect(() => {
    const on = (e) => { setAiDiag(e.detail); clearTimeout(diagTimer.current); diagTimer.current = setTimeout(() => setAiDiag(null), e.detail?.error ? 15000 : 6000); };
    window.addEventListener('dsh-ai-diag', on);
    return () => { window.removeEventListener('dsh-ai-diag', on); clearTimeout(diagTimer.current); };
  }, []);
  const session = useMemo(() => {
    try {
      const parser = BlockNoteEditor.create({ schema, dictionary: zh });
      const state = loadBlockMarkdown(parser, value);
      // Parsing uses scratch transactions. Start the visible editor with initial
      // content so Undo can never walk back through document initialization.
      // The AI edit pipeline now runs on our native LLM chat (drives DSH directly, no
      // streamText). chatProvider is how XL-AI lets us inject our own chat object.
      const editor = BlockNoteEditor.create({ schema, dictionary: { ...zh, placeholders: { ...zh.placeholders, default: "输入 '/' 以使用命令，输入 '//' 快速进入 AI 模式" }, ai: aiZh }, initialContent: state.blocks, extensions: [AIExtension({ chatProvider: () => chatRef.current })] });
      state.snapshot = fingerprint(editor.document);
      return { editor, state };
    } catch { return null; }
  }, []);
  // Serialize the document and bubble it up. `final` marks the settle after an AI edit: only
  // then is a serialization failure fatal. Mid-AI the document legitimately holds suggestion
  // marks (old + new content at once), which cannot round-trip through Markdown, so failing
  // there must not strand the editor in its fallback.
  flushRef.current = (final) => {
    if (!session || callbacks.current.readOnly) return;
    try {
      const next = saveBlockMarkdown(session.editor, session.state);
      if (next !== last.current) { last.current = next; callbacks.current.onChange(next); }
    } catch { if (final) setFailed(true); }
  };
  useEffect(() => {
    // Server echoes must not reset selection or undo history. A genuinely new
    // source document is mounted by the parent when changing editing engines.
    if (value !== last.current) setFailed(true);
  }, [value]);
  // Hold serialization while the AI is mid-edit, and settle once it lands. acceptChanges() and
  // rejectChanges() both call closeAIMenu() last, after their document transactions, so the
  // falling edge to 'closed' already sees the finished document.
  useEffect(() => {
    const store = session?.editor.getExtension(AIExtension)?.store;
    if (!store?.subscribe) return;
    gateRef.current.onAiState(store.state?.aiMenuState);
    return store.subscribe(({ currentVal }) => {
      const menu = currentVal?.aiMenuState;
      gateRef.current.onAiState(menu);
      // An operation the executor refused fails the whole edit, but the reason never reached the
      // screen: it lives in a non-enumerable `message`, so the console object looks empty. Put it
      // on the diag strip, which is where this project expects to be debugged from.
      if (menu && menu !== 'closed' && menu.status === 'error') {
        const message = describeAiError(menu.error);
        setAiDiag(d => ({ ...(d || {}), error: message }));
        clearTimeout(diagTimer.current);
        diagTimer.current = setTimeout(() => setAiDiag(null), 15000);
      }
    });
  }, [session]);
  // Any AI edit (the "/" slash menu or a selection edit) drives the same persistent chat, so
  // reflect its running status on the parent so the workspace can block report switching
  // while an AI request is in flight. status 'submitted' == a request is running.
  useEffect(() => {
    const unsub = chatRef.current['~registerStatusCallback']?.((s) => callbacks.current.onAiBusy?.(s === 'submitted'));
    return () => { try { unsub?.(); } catch { /* ignore */ } };
  }, []);
  // Expose a small editor API so the workspace toolbar's "AI" button can jump straight into
  // AI mode — the same pipeline as '/', '//' and selection edit (propose -> diff -> apply/revert).
  useEffect(() => {
    if (!editorApi || !session) return;
    const ext = () => session.editor.getExtension(AIExtension);
    editorApi.current = {
      enterAIMode() {
        if (callbacks.current.readOnly) return;
        try {
          const cursor = session.editor.getTextCursorPosition();
          const isEmpty = cursor?.block?.content && Array.isArray(cursor.block.content) && cursor.block.content.length === 0;
          const blockId = isEmpty && cursor.prevBlock ? cursor.prevBlock.id : cursor.block.id;
          ext().openAIMenuAtBlock?.(blockId);
        } catch { /* ignore */ }
      },
      enterVoiceMode() {
        if (callbacks.current.readOnly) return;
        try {
          const cursor = session.editor.getTextCursorPosition();
          const isEmpty = cursor?.block?.content && Array.isArray(cursor.block.content) && cursor.block.content.length === 0;
          const blockId = isEmpty && cursor.prevBlock ? cursor.prevBlock.id : cursor.block.id;
          // Same pipeline as right-Alt: mark the auto-start bit right before opening the menu so the
          // AIMenu sees it on mount and begins recording without a second click.
          markVoiceAutoStart();
          ext().openAIMenuAtBlock?.(blockId);
        } catch { /* ignore */ }
      },
    };
    return () => { editorApi.current = null; };
  }, [editorApi, session]);
  // Right-Alt (editable document): if the AI menu is closed, open it and auto-start voice;
  // if it's open, toggle the recording. Scoped to this visual editor and inactive when read-only.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Alt' || e.location !== 2 || e.repeat || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (callbacks.current.readOnly || !session) return;
      const ai = session.editor.getExtension(AIExtension);
      if (!ai?.openAIMenuAtBlock) return;
      e.preventDefault();
      if (voiceBus.menuOpen) {
        window.dispatchEvent(new CustomEvent(VOICE_TOGGLE_EVENT));
      } else {
        try {
          const cursor = session.editor.getTextCursorPosition();
          const isEmpty = cursor?.block?.content && Array.isArray(cursor.block.content) && cursor.block.content.length === 0;
          const blockId = isEmpty && cursor.prevBlock ? cursor.prevBlock.id : cursor.block.id;
          // Set the auto-start bit only right before opening, so a failed cursor read
          // cannot leave a stale "start voice" request for the next menu open.
          markVoiceAutoStart();
          ai.openAIMenuAtBlock(blockId);
        } catch { /* cursor read failed; do nothing */ }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [session]);
  if (!session || failed) return <div className="rr-editor-fallback" role="status">此文档暂时无法使用可视化编辑，请在源码中继续。<button className="rr-button" onClick={onSource}>打开 Markdown 源码</button></div>;
  return <div className="rr-block-editor" ref={root}>
    <style>{editorCss}</style>
    <style>{aiCss}</style>
    <div className="rr-block-hint">{readOnly ? '当前只读 · 已确认稿需开启修订后编辑' : '直接点击正文编辑 · 输入 / 插入区块 · 选中文字设置格式'}</div>
    {aiDiag && <div className="rr-ai-diag">AI：工具 {aiDiag.tools?.join(', ') || '(无)'} · 调用 {aiDiag.toolCalls ?? 0} 次 · {aiDiag.toolCalls > 0 ? '已生成操作' : '模型未调用工具'}{aiDiag.error ? ` · 错误：${aiDiag.error}` : ''}</div>}
    {portal && <BlockNoteView editor={session.editor} portalElements={portalElements} editable={!readOnly} formattingToolbar={false} sideMenu={false} slashMenu={false} filePanel={false} tableHandles={true} onChange={() => {
      if (callbacks.current.readOnly) return;
      gateRef.current.onChange();
    }}>
      <FormattingToolbarController formattingToolbar={ReportFormattingToolbar} floatingUIOptions={floatingOptions} />
      <SideMenuController sideMenu={ReportSideMenu} floatingUIOptions={floatingOptions} />
      <AIMenuController />
      <SuggestionMenuController triggerCharacter="/" getItems={async q => filterSuggestionItems(getSlashMenuItemsWithAI(session.editor), q)} floatingUIOptions={suggestionMenuFloatingOptions} />
      <SuggestionMenuController triggerCharacter="//" shouldOpen={(tr) => { const from = tr.selection.from; const before = tr.doc.textBetween(Math.max(0, from - 2), Math.max(0, from - 1)); return before.trim() === ''; }} getItems={async () => getAISlashMenuItems(session.editor)} suggestionMenuComponent={DirectAISuggestionMenu} floatingUIOptions={suggestionMenuFloatingOptions} />
    </BlockNoteView>}
  </div>;
}
