import React, { useMemo, useRef, useEffect, useState } from 'react';
import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs, defaultStyleSpecs } from '@blocknote/core';
import { zh } from '@blocknote/core/locales';
import { createReactBlockSpec, FormattingToolbar, FormattingToolbarController, BasicTextStyleButton, CreateLinkButton, SideMenuController, SideMenu, DragHandleMenu, RemoveBlockItem, SuggestionMenuController, getDefaultReactSlashMenuItems } from '@blocknote/react';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { BlockNoteView } from '@blocknote/mantine';
import { AIExtension, AIToolbarButton, AIMenuController, getAISlashMenuItems } from './editor-ai/index.js';
import { zh as aiZh } from './editor-ai/locales.js';
import aiCss from './editor-ai/style.css';
import { ReportImage } from './report-image.jsx';
import { createNativeChat } from './ai-bridge.mjs';
import editorCss from './block-editor-styles.mjs';
import { MarkdownPreview } from './preview.jsx';
import { loadBlockMarkdown, saveBlockMarkdown, fingerprint } from './block-markdown.mjs';

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

// Slash menu = BlockNote default items + the AI items.
function getSlashMenuItemsWithAI(editor) {
  return [...getDefaultReactSlashMenuItems(editor), ...getAISlashMenuItems(editor)];
}

// Stable component types preserve open popovers across parent save/status renders.
function ReportFormattingToolbar() {
  return <FormattingToolbar><BasicTextStyleButton basicTextStyle="bold" /><BasicTextStyleButton basicTextStyle="italic" /><BasicTextStyleButton basicTextStyle="strike" /><BasicTextStyleButton basicTextStyle="code" /><CreateLinkButton /><AIToolbarButton /></FormattingToolbar>;
}
function ReportDragMenu() { return <DragHandleMenu><RemoveBlockItem>删除区块</RemoveBlockItem></DragHandleMenu>; }
function ReportSideMenu(props) { return <SideMenu {...props} dragHandleMenu={ReportDragMenu} />; }
const floatingOptions = { useFloatingOptions: { strategy: 'fixed', transform: false } };

export function BlockEditor({ value, onChange, readOnly, onSource }) {
  const root = useRef(null);
  const [portal, setPortal] = useState(null);
  useEffect(() => { setPortal(root.current?.closest('dialog') || root.current); }, []);
  const portalElements = useMemo(() => ({ default: portal }), [portal]);
  const callbacks = useRef({ onChange, readOnly });
  callbacks.current = { onChange, readOnly };
  const last = useRef(value);
  const [failed, setFailed] = useState(false);
  // Show the outcome of the last AI request on screen (readable without DevTools).
  const [aiDiag, setAiDiag] = useState(null);
  useEffect(() => {
    const on = (e) => setAiDiag(e.detail);
    window.addEventListener('dsh-ai-diag', on);
    return () => window.removeEventListener('dsh-ai-diag', on);
  }, []);
  const session = useMemo(() => {
    try {
      const parser = BlockNoteEditor.create({ schema, dictionary: zh });
      const state = loadBlockMarkdown(parser, value);
      // Parsing uses scratch transactions. Start the visible editor with initial
      // content so Undo can never walk back through document initialization.
      // The AI edit pipeline now runs on our native LLM chat (drives DSH directly, no
      // streamText). chatProvider is how XL-AI lets us inject our own chat object.
      const editor = BlockNoteEditor.create({ schema, dictionary: { ...zh, ai: aiZh }, initialContent: state.blocks, extensions: [AIExtension({ chatProvider: () => createNativeChat({ fetchFn: aiFetch }) })] });
      state.snapshot = fingerprint(editor.document);
      return { editor, state };
    } catch { return null; }
  }, []);
  useEffect(() => {
    // Server echoes must not reset selection or undo history. A genuinely new
    // source document is mounted by the parent when changing editing engines.
    if (value !== last.current) setFailed(true);
  }, [value]);
  if (!session || failed) return <div className="rr-editor-fallback" role="status">此文档暂时无法使用可视化编辑，请在源码中继续。<button className="rr-button" onClick={onSource}>打开 Markdown 源码</button></div>;
  return <div className="rr-block-editor" ref={root}>
    <style>{editorCss}</style>
    <style>{aiCss}</style>
    <div className="rr-block-hint">{readOnly ? '当前只读 · 已确认稿需开启修订后编辑' : '直接点击正文编辑 · 输入 / 插入区块 · 选中文字设置格式'}</div>
    {aiDiag && <div className="rr-ai-diag">AI：工具 {aiDiag.tools?.join(', ') || '(无)'} · 调用 {aiDiag.toolCalls ?? 0} 次 · {aiDiag.toolCalls > 0 ? '已生成操作' : '模型未调用工具'}{aiDiag.error ? ` · 错误：${aiDiag.error}` : ''}</div>}
    {portal && <BlockNoteView editor={session.editor} portalElements={portalElements} editable={!readOnly} formattingToolbar={false} sideMenu={false} slashMenu={false} filePanel={false} tableHandles={true} onChange={() => {
      if (callbacks.current.readOnly) return;
      try {
        const next = saveBlockMarkdown(session.editor, session.state);
        if (next !== last.current) { last.current = next; callbacks.current.onChange(next); }
      } catch { setFailed(true); }
    }}>
      <FormattingToolbarController formattingToolbar={ReportFormattingToolbar} floatingUIOptions={floatingOptions} />
      <SideMenuController sideMenu={ReportSideMenu} floatingUIOptions={floatingOptions} />
      <AIMenuController />
      <SuggestionMenuController triggerCharacter="/" getItems={async q => filterSuggestionItems(getSlashMenuItemsWithAI(session.editor), q)} floatingUIOptions={floatingOptions} />
    </BlockNoteView>}
  </div>;
}
