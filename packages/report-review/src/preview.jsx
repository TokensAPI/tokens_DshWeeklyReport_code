import React, { useEffect, useId, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DEMO_CHART_URL, DEMO_CHART_DATA } from './demo-content.mjs';

const plugins = [remarkGfm];
function sourceLines() {
  return tree => {
    for (const node of tree.children || []) {
      if (node.type === 'element' && node.position) {
        node.properties = { ...node.properties, 'data-source-line': node.position.start.line };
      }
    }
  };
}
const htmlPlugins = [sourceLines];
const components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // Reading a draft must not automatically contact external image servers.
  img: ({ alt, src }) => src === DEMO_CHART_URL ? <img src={DEMO_CHART_DATA} alt={alt || '模拟库存示意图'} style={{ maxWidth: '100%' }} /> : <span className="rr-image-placeholder">图片：{alt || '未命名图片'}（请在 PDF 中查看）</span>
};
export function MarkdownPreview({ text, scrollRef }) {
  return <article ref={scrollRef} className="rr-markdown-body"><ReactMarkdown remarkPlugins={plugins} rehypePlugins={htmlPlugins} components={components} skipHtml>{text}</ReactMarkdown></article>;
}

// Map rendered block positions to their source lines rather than matching percentages:
// a table or wrapped paragraph can be very different heights in the two panes.
export function usePreviewScroll(editorRef, previewRef, active, text, readOnly) {
  useEffect(() => {
    const view = editorRef.current, preview = previewRef.current;
    if (!active || !view || !preview) return;
    const source = view.scrollDOM;
    const expected = new WeakMap();
    let frame;
    function sync(from, to, reverse) {
      const previous = expected.get(from);
      expected.delete(from);
      if (previous !== undefined && Math.abs(from.scrollTop - previous) < 2) return;
      const sourceMax = Math.max(0, source.scrollHeight - source.clientHeight);
      const previewMax = Math.max(0, preview.scrollHeight - preview.clientHeight);
      const anchors = [[0, 0]];
      for (const node of preview.querySelectorAll(':scope > [data-source-line]')) {
        const line = Math.min(view.state.doc.lines, Number(node.dataset.sourceLine));
        const sourceY = view.lineBlockAt(view.state.doc.line(line).from).top + view.documentTop - source.getBoundingClientRect().top + source.scrollTop;
        const previewY = node.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop;
        const point = [Math.min(sourceMax, Math.max(0, sourceY)), Math.min(previewMax, Math.max(0, previewY))];
        const last = anchors[anchors.length - 1];
        if (point[0] > last[0] && point[1] > last[1] && point[0] < sourceMax && point[1] < previewMax) anchors.push(point);
      }
      anchors.push([sourceMax, previewMax]);
      const x = reverse ? 1 : 0, y = reverse ? 0 : 1;
      const position = from.scrollTop;
      let target = 0;
      for (let i = 1; i < anchors.length; i++) {
        const a = anchors[i - 1], b = anchors[i];
        if (position <= b[x] || i === anchors.length - 1) {
          const ratio = b[x] > a[x] ? Math.max(0, Math.min(1, (position - a[x]) / (b[x] - a[x]))) : 0;
          target = a[y] + ratio * (b[y] - a[y]);
          break;
        }
      }
      if (Math.abs(to.scrollTop - target) > 1) { expected.set(to, target); to.scrollTop = target; }
    }
    const fromSource = () => sync(source, preview, false);
    const fromPreview = () => sync(preview, source, true);
    source.addEventListener('scroll', fromSource, { passive: true });
    preview.addEventListener('scroll', fromPreview, { passive: true });
    const resize = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fromSource); });
    resize.observe(source); resize.observe(preview);
    frame = requestAnimationFrame(fromSource);
    return () => { cancelAnimationFrame(frame); resize.disconnect(); source.removeEventListener('scroll', fromSource); preview.removeEventListener('scroll', fromPreview); };
  }, [active, text, readOnly]);
}

export function TemplateSelect({ value, templates, disabled, onChange }) {
  const id = useId(), root = useRef(null), trigger = useRef(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const options = [{ id: '', name: '默认模板', content: '使用内置周报分析结构' }, ...templates];
  const selected = Math.max(0, options.findIndex(option => option.id === value));
  function choose(index) { onChange(options[index].id); setOpen(false); trigger.current.focus(); }
  function move(index) {
    const next = Math.max(0, Math.min(options.length - 1, index));
    setActive(next);
    root.current.querySelectorAll('[role="option"]')[next]?.scrollIntoView({ block: 'nearest' });
  }
  function keyDown(event) {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) { setOpen(true); setActive(selected); }
      else move(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (open) choose(active); else { setOpen(true); setActive(selected); }
    } else if (event.key === 'Tab') setOpen(false);
  }
  return <div className="rr-template-select" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" ref={trigger} className="rr-select-trigger" role="combobox" aria-label="选择模板" aria-haspopup="listbox" aria-expanded={open && !disabled} aria-controls={id} aria-activedescendant={open && !disabled ? `${id}-${active}` : undefined} disabled={disabled} onKeyDown={keyDown} onClick={() => { setOpen(!open); setActive(selected); }}>
      <span><small>分析模板</small><strong>{options[selected].name}</strong></span><span aria-hidden="true">⌄</span>
    </button>
    {open && !disabled && <div id={id} role="listbox" aria-label="分析模板" className="rr-select-menu">
      {options.map((option, index) => <div key={option.id} id={`${id}-${index}`} role="option" aria-selected={value === option.id} data-active={active === index} className="rr-select-option" onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(index)}>
        <strong>{option.name}<span aria-hidden="true">{value === option.id ? ' ✓' : ''}</span></strong><small>{option.content?.replace(/[#*\n]/g, ' ').slice(0, 90) || '自定义分析要求'}</small>
      </div>)}
    </div>}
  </div>;
}
