import { imageMarkdown } from './report-image.jsx';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

const parser = unified().use(remarkParse).use(remarkGfm);
const inlineTypes = new Set(['text', 'strong', 'emphasis', 'delete', 'inlineCode', 'link', 'break']);
function supported(node) {
  if (node.type === 'code') return !node.meta;
  if (node.type === 'thematicBreak') return true;
  if (node.type === 'table') return !node.align.some(Boolean) && node.children.every(row => row.children.every(cell => cell.children.every(inline)));
  if (node.type === 'blockquote') return node.children.every(child => child.type === 'paragraph' && supported(child));
  if (node.type === 'list' && node.ordered && node.start !== 1) return false;
  if (['paragraph', 'heading'].includes(node.type)) return (node.children || []).every(inline);
  if (node.type === 'list') return node.children.every(item => item.children.every(supported));
  return false;
}
function inline(node) { return inlineTypes.has(node.type) && (!node.children || node.children.every(inline)); }
export function fingerprint(blocks) { return JSON.stringify(blocks); }

// Keep original source slices. Opening a document never normalizes Markdown;
// only changed blocks are serialized through BlockNote's lossy converter.
export function loadBlockMarkdown(editor, markdown) {
  const nodes = parser.parse(markdown).children;
  const records = [], blocks = [];
  let end = 0;
  for (const node of nodes) {
    const start = node.position.start.offset, stop = node.position.end.offset;
    const raw = markdown.slice(start, stop);
    let parsed;
    const picture = node.type === 'paragraph' && node.children.length === 1 && node.children[0].type === 'image' ? node.children[0] : null;
    if (picture) parsed = [{type:'image', props:{url:picture.url, caption:picture.alt || '', title:picture.title || ''}}];
    try { if (supported(node)) parsed = editor.tryParseMarkdownToBlocks(raw); } catch { /* retain original */ }
    if (!parsed?.length) parsed = [{ type: 'source', props: { raw } }];
    // Resolve generated ids and defaults using the same schema as the live editor. A block that
    // the schema rejects (e.g. a table whose rows lost their column grid, which is how a
    // document damaged by an interrupted AI edit reads back) must degrade to a preserved source
    // block. Letting it throw here would take down the whole session and leave the report with
    // no visual editing at all, when only one block is actually broken.
    let normalized;
    try {
      editor.replaceBlocks(editor.document, parsed);
      normalized = editor.document;
    } catch {
      editor.replaceBlocks(editor.document, [{ type: 'source', props: { raw } }]);
      normalized = editor.document;
    }
    records.push({ ids: normalized.map(b => b.id), snapshot: fingerprint(normalized), raw, before: markdown.slice(end, start) });
    blocks.push(...normalized);
    end = stop;
  }
  return { blocks: blocks.length ? blocks : [{ type: 'paragraph' }], records, byId: new Map(records.map(r => [r.ids[0], r])), cache: new Map(), tail: markdown.slice(end), original: markdown };
}

function serialize(editor, state, blocks) {
  const id = blocks[0].id, snapshot = fingerprint(blocks), cached = state.cache.get(id);
  if (cached?.snapshot === snapshot) return cached.markdown;
  // The vendor converter does not understand our source/image UI. Replace custom
  // blocks at every depth with plain text markers, then restore their Markdown.
  // Keep children so dragging a block into or beneath a custom block cannot drop it.
  const replacements = new Map();
  let prefix = 'RRCustomMarkdownBlock';
  while (snapshot.includes(prefix)) prefix += 'X';
  function prepare(items) {
    return items.map(block => {
      const children = prepare(block.children || []);
      if (block.type !== 'source' && block.type !== 'image') return { ...block, children };
      const marker = prefix + replacements.size;
      replacements.set(marker, block.type === 'source' ? block.props.raw : imageMarkdown(block.props.url, block.props.caption, block.props.title));
      return { id: block.id, type: 'paragraph', props: {}, content: [{ type: 'text', text: marker, styles: {} }], children };
    });
  }
  let markdown = editor.blocksToMarkdownLossy(prepare(blocks)).trimEnd();
  for (const [marker, raw] of replacements) {
    markdown = markdown.replace(new RegExp(`^([ \\t]*)${marker}$`, 'gm'), (_, indent) => raw.split('\n').map(line => indent + line).join('\n'));
    if (markdown.includes(marker)) throw new Error('Cannot preserve nested Markdown block');
  }
  state.cache.set(id, { snapshot, markdown });
  return markdown;
}

export function saveBlockMarkdown(editor, state) {
  const blocks = editor.document;
  if (state.snapshot === fingerprint(blocks)) return state.original;
  let result = '';
  for (let i = 0; i < blocks.length;) {
    const block = blocks[i];
    const record = state.byId.get(block.id);
    const group = record && blocks.slice(i, i + record.ids.length);
    if (record && group.length === record.ids.length && group.every((b, n) => b.id === record.ids[n])) {
      result += (i === 0 ? record.before : record.before || '\n\n');
      result += fingerprint(group) === record.snapshot ? record.raw : serialize(editor, state, group);
      i += group.length;
    } else {
      result += (i === 0 ? record?.before || '' : record?.before || '\n\n');
      result += serialize(editor, state, [block]);
      i++;
    }
  }
  return result + state.tail;
}
